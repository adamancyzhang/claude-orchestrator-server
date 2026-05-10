import atexit
import logging
from typing import Optional

from mcp.server.fastmcp import FastMCP

from .zk_client import ZkClient
from .registry import InstanceRegistry
from .task_queue import TaskQueue
from .message_router import MessageRouter
from .context_store import ContextStore
from .models import TaskPriority

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# -- Global state, initialized once at module load --
zk = ZkClient(hosts="127.0.0.1:2181")
registry = InstanceRegistry(zk)
task_queue = TaskQueue(zk)
message_router = MessageRouter(zk)
context_store = ContextStore(zk)

_zk_started = False


def _ensure_zk():
    global _zk_started
    if not _zk_started:
        zk.start()
        _zk_started = True
        atexit.register(_stop_zk)
        logger.info("ZooKeeper connected, server ready")


def _stop_zk():
    global _zk_started
    if _zk_started:
        zk.stop()
        _zk_started = False


mcp = FastMCP("Claude MCP Server", host="127.0.0.1", port=3100)


# ── Instance Registry tools ──

@mcp.tool()
async def server_status() -> str:
    zk_ok = zk.connected
    return f"Server: running\nZooKeeper: {'connected' if zk_ok else 'DISCONNECTED'}\nPort: 3100"


@mcp.tool()
async def register_instance(name: str, role: str = "general",
                            instance_id: Optional[str] = None) -> str:
    _ensure_zk()
    if not zk.connected:
        return "Error: ZooKeeper is not connected. Please wait for reconnection or restart the server."
    instance = registry.register(name=name, role=role, instance_id=instance_id)
    action = "re-registered" if instance_id and instance.id == instance_id else "registered"
    return f"Instance {action}:\n" + instance.model_dump_json(indent=2)


@mcp.tool()
async def heartbeat(instance_id: str, current_task: Optional[str] = None) -> str:
    registry.heartbeat(instance_id, current_task)
    return "ok"


@mcp.tool()
async def list_instances() -> str:
    instances = registry.list_all()
    result = [i.model_dump() for i in instances]
    n = len(result)
    return f"{n} active instance{'s' if n != 1 else ''}:\n" + \
           "\n".join(f"  [{i['role']}] {i['name']} ({i['id'][:8]}...) "
                     f"status={i['status']}" for i in result)


# ── Task Queue tools ──

@mcp.tool()
async def push_task(title: str, description: str = "",
                    priority: int = 1, instance_id: str = "",
                    assignee: Optional[str] = None) -> str:
    task = task_queue.push(
        title=title,
        description=description,
        priority=priority,
        created_by=instance_id,
        assigned_to=assignee,
    )
    return f"Task {task.id} created:\n  title: {task.title}\n  priority: {task.priority.name}"


@mcp.tool()
async def claim_task(instance_id: str) -> str:
    task = task_queue.claim(instance_id)
    if task is None:
        return "No pending tasks available."
    return f"Claimed task {task.id}\n  title: {task.title}\n  description: {task.description}"


@mcp.tool()
async def complete_task(instance_id: str, task_id: str, result: str) -> str:
    task = task_queue.complete(instance_id, task_id, result)
    return f"Task {task.id} completed."


@mcp.tool()
async def list_tasks(status: Optional[str] = None) -> str:
    tasks = task_queue.list_tasks(status)
    if not tasks:
        return "No tasks found."
    lines = [f"{len(tasks)} task(s):"]
    for t in tasks:
        lines.append(f"  [{t.status.value}] {t.id}: {t.title or '(no title)'}")
    return "\n".join(lines)


# ── Message Router tools ──

@mcp.tool()
async def send_message(instance_id: str, content: str,
                       to_instance: Optional[str] = None,
                       broadcast: bool = False) -> str:
    inst = registry.get(instance_id)
    from_name = inst.name if inst else instance_id[:8]
    messages = message_router.send(
        from_instance=instance_id,
        from_name=from_name,
        content=content,
        to_instance=to_instance,
        broadcast=broadcast,
    )
    targets = [m.to_instance for m in messages]
    return f"Message sent to: {targets}"


@mcp.tool()
async def poll_messages(instance_id: str) -> str:
    messages = message_router.poll(instance_id)
    if not messages:
        return "No messages."
    lines = [f"{len(messages)} message(s):"]
    for m in messages:
        read_mark = " [read]" if m.read else ""
        lines.append(f"  [{m.type.value}] from {m.from_name}: {m.content[:100]}{read_mark}")
    return "\n".join(lines)


@mcp.tool()
async def request_help(instance_id: str, question: str,
                       context: Optional[str] = None) -> str:
    inst = registry.get(instance_id)
    from_name = inst.name if inst else instance_id[:8]
    messages = message_router.request_help(
        from_instance=instance_id,
        from_name=from_name,
        question=question,
        context=context,
    )
    targets = [m.to_instance for m in messages]
    return f"Help request broadcast to {len(targets)} instance(s): {targets}"


# ── Shared Context tools ──

@mcp.tool()
async def set_context(key: str, value: str, instance_id: str = "") -> str:
    context_store.set(key, value, updated_by=instance_id)
    return f"Context set: {key} = {value}"


@mcp.tool()
async def get_context(key: str) -> str:
    value = context_store.get(key)
    if value is None:
        return f"No context found for key: {key}"
    return f"{key} = {value}"


def main():
    logger.info("Starting Claude MCP Server on 127.0.0.1:3100")
    _ensure_zk()
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
