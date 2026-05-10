import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

import click

from .zk_client import ZkClient
from .registry import InstanceRegistry
from .task_queue import TaskQueue
from .message_router import MessageRouter
from .context_store import ContextStore


CONFIG_DIR = Path.home() / ".claude-orchestrator"
CONFIG_FILE = CONFIG_DIR / "config.json"

logging.basicConfig(level=logging.WARNING)


def _load_instance_id() -> Optional[str]:
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text())
            return data.get("instance_id")
        except (json.JSONDecodeError, KeyError):
            return None
    return None


def _save_instance_id(instance_id: str):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps({"instance_id": instance_id}, indent=2))


def _resolve_instance_id(instance_id: Optional[str]) -> str:
    resolved = instance_id or _load_instance_id()
    if not resolved:
        raise click.UsageError(
            "No instance_id found. Run 'claude-orchestrator register' first, "
            "or pass --instance-id."
        )
    return resolved


def _output(data, error: bool = False):
    if isinstance(data, str):
        data = {"message": data}
    click.echo(json.dumps(data, indent=2, ensure_ascii=False))
    if error:
        sys.exit(1)


# ── Shared state (lazily initialized) ──

_zk: Optional[ZkClient] = None
_registry: Optional[InstanceRegistry] = None
_task_queue: Optional[TaskQueue] = None
_message_router: Optional[MessageRouter] = None
_context_store: Optional[ContextStore] = None


def _get_zk(hosts: str = "127.0.0.1:2181") -> ZkClient:
    global _zk
    if _zk is None:
        _zk = ZkClient(hosts=hosts)
        _zk.start()
    return _zk


def _get_registry(hosts: str = "127.0.0.1:2181") -> InstanceRegistry:
    global _registry
    if _registry is None:
        _registry = InstanceRegistry(_get_zk(hosts))
    return _registry


def _get_task_queue(hosts: str = "127.0.0.1:2181") -> TaskQueue:
    global _task_queue
    if _task_queue is None:
        _task_queue = TaskQueue(_get_zk(hosts))
    return _task_queue


def _get_message_router(hosts: str = "127.0.0.1:2181") -> MessageRouter:
    global _message_router
    if _message_router is None:
        _message_router = MessageRouter(_get_zk(hosts))
    return _message_router


def _get_context_store(hosts: str = "127.0.0.1:2181") -> ContextStore:
    global _context_store
    if _context_store is None:
        _context_store = ContextStore(_get_zk(hosts))
    return _context_store


# ── Global options ──

@click.group()
@click.option("--zk-hosts", envvar="ZK_HOSTS", default="127.0.0.1:2181",
              help="ZooKeeper connection string")
@click.option("--instance-id", default=None,
              help="Instance ID (reads from ~/.claude-orchestrator/config.json if omitted)")
@click.pass_context
def cli(ctx, zk_hosts: str, instance_id: Optional[str]):
    ctx.ensure_object(dict)
    ctx.obj["zk_hosts"] = zk_hosts
    ctx.obj["instance_id"] = instance_id


# ── Status ──

@cli.command()
@click.pass_context
def status(ctx):
    """Check server connection and ZooKeeper health."""
    try:
        zk = _get_zk(ctx.obj["zk_hosts"])
        connected = zk.connected
        instances = _get_registry(ctx.obj["zk_hosts"]).list_all()
        _output({
            "status": "healthy" if connected else "degraded",
            "zookeeper": "connected" if connected else "disconnected",
            "instances_online": len(instances),
        })
    except Exception as e:
        _output({"status": "error", "zookeeper": str(e), "instances_online": 0}, error=True)


# ── Instance Registry ──

@cli.command()
@click.option("--name", required=True, help="Display name for this instance")
@click.option("--role", default="general",
              type=click.Choice(["architect", "developer", "tester", "general"]),
              help="Instance role")
@click.pass_context
def register(ctx, name: str, role: str):
    """Register this instance with the orchestrator."""
    instance_id = ctx.obj["instance_id"]
    try:
        registry = _get_registry(ctx.obj["zk_hosts"])
        instance = registry.register(name=name, role=role, instance_id=instance_id)
        _save_instance_id(instance.id)
        _output(instance.model_dump())
    except Exception as e:
        _output({"error": str(e)}, error=True)


@cli.command()
@click.option("--current-task", default=None, help="Current task title (omit to clear)")
@click.pass_context
def heartbeat(ctx, current_task: Optional[str]):
    """Send heartbeat to keep registration alive."""
    instance_id = _resolve_instance_id(ctx.obj["instance_id"])
    try:
        _get_registry(ctx.obj["zk_hosts"]).heartbeat(instance_id, current_task)
        _output({"status": "ok", "instance_id": instance_id})
    except Exception as e:
        _output({"error": str(e)}, error=True)


@cli.command("list-instances")
@click.pass_context
def list_instances(ctx):
    """List all active instances."""
    try:
        instances = _get_registry(ctx.obj["zk_hosts"]).list_all()
        _output([i.model_dump() for i in instances])
    except Exception as e:
        _output({"error": str(e)}, error=True)


# ── Task Queue ──

@cli.command("push-task")
@click.option("--title", required=True, help="Task title")
@click.option("--description", default="", help="Task description")
@click.option("--priority", default=1, type=click.IntRange(0, 2),
              help="Priority: 0=HIGH, 1=MEDIUM, 2=LOW")
@click.option("--assignee", default=None, help="Target instance ID")
@click.pass_context
def push_task(ctx, title: str, description: str, priority: int, assignee: Optional[str]):
    """Create and push a new task to the queue."""
    instance_id = ctx.obj["instance_id"] or ""
    try:
        task = _get_task_queue(ctx.obj["zk_hosts"]).push(
            title=title, description=description, priority=priority,
            created_by=instance_id, assigned_to=assignee,
        )
        _output(task.model_dump())
    except Exception as e:
        _output({"error": str(e)}, error=True)


@cli.command("claim-task")
@click.pass_context
def claim_task(ctx):
    """Claim the highest-priority pending task."""
    instance_id = _resolve_instance_id(ctx.obj["instance_id"])
    try:
        task = _get_task_queue(ctx.obj["zk_hosts"]).claim(instance_id)
        if task is None:
            _output({"status": "no_tasks", "message": "No pending tasks available."})
        else:
            _output(task.model_dump())
    except Exception as e:
        _output({"error": str(e)}, error=True)


@cli.command("complete-task")
@click.option("--task-id", required=True, help="Task ID to complete")
@click.option("--result", required=True, help="Summary of what was accomplished")
@click.pass_context
def complete_task(ctx, task_id: str, result: str):
    """Mark a claimed task as completed."""
    instance_id = _resolve_instance_id(ctx.obj["instance_id"])
    try:
        task = _get_task_queue(ctx.obj["zk_hosts"]).complete(instance_id, task_id, result)
        _output(task.model_dump())
    except Exception as e:
        _output({"error": str(e)}, error=True)


@cli.command("list-tasks")
@click.option("--status", "status_filter", default=None,
              type=click.Choice(["pending", "claimed", "completed"]),
              help="Filter by task status")
@click.pass_context
def list_tasks(ctx, status_filter: Optional[str]):
    """List tasks, optionally filtered by status."""
    try:
        tasks = _get_task_queue(ctx.obj["zk_hosts"]).list_tasks(status_filter)
        _output([t.model_dump() for t in tasks])
    except Exception as e:
        _output({"error": str(e)}, error=True)


# ── Message Router ──

@cli.command("send-message")
@click.option("--content", required=True, help="Message content")
@click.option("--to", "to_instance", default=None, help="Recipient instance ID")
@click.option("--broadcast", is_flag=True, default=False, help="Send to all instances")
@click.pass_context
def send_message(ctx, content: str, to_instance: Optional[str], broadcast: bool):
    """Send a message to another instance or broadcast to all."""
    if not to_instance and not broadcast:
        raise click.UsageError("Must specify --to or --broadcast")
    instance_id = _resolve_instance_id(ctx.obj["instance_id"])
    try:
        router = _get_message_router(ctx.obj["zk_hosts"])
        inst = _get_registry(ctx.obj["zk_hosts"]).get(instance_id)
        from_name = inst.name if inst else instance_id[:8]
        messages = router.send(
            from_instance=instance_id, from_name=from_name,
            content=content, to_instance=to_instance, broadcast=broadcast,
        )
        targets = [m.to_instance for m in messages]
        _output({"sent_to": targets, "message_count": len(targets)})
    except Exception as e:
        _output({"error": str(e)}, error=True)


@cli.command("poll-messages")
@click.pass_context
def poll_messages(ctx):
    """Check for new messages."""
    instance_id = _resolve_instance_id(ctx.obj["instance_id"])
    try:
        messages = _get_message_router(ctx.obj["zk_hosts"]).poll(instance_id)
        _output([m.model_dump() for m in messages])
    except Exception as e:
        _output({"error": str(e)}, error=True)


@cli.command("request-help")
@click.option("--question", required=True, help="Your question or problem description")
@click.option("--context", default=None, help="Additional context (stack traces, logs)")
@click.pass_context
def request_help(ctx, question: str, context: Optional[str]):
    """Broadcast a help request to all online instances."""
    instance_id = _resolve_instance_id(ctx.obj["instance_id"])
    try:
        inst = _get_registry(ctx.obj["zk_hosts"]).get(instance_id)
        from_name = inst.name if inst else instance_id[:8]
        messages = _get_message_router(ctx.obj["zk_hosts"]).request_help(
            from_instance=instance_id, from_name=from_name,
            question=question, context=context,
        )
        targets = [m.to_instance for m in messages]
        _output({"sent_to": targets, "message_count": len(targets)})
    except Exception as e:
        _output({"error": str(e)}, error=True)


# ── Shared Context ──

@cli.command("set-context")
@click.option("--key", required=True, help="Context key")
@click.option("--value", required=True, help="Context value")
@click.pass_context
def set_context(ctx, key: str, value: str):
    """Store a shared context key-value pair."""
    instance_id = ctx.obj["instance_id"] or ""
    try:
        entry = _get_context_store(ctx.obj["zk_hosts"]).set(key, value, updated_by=instance_id)
        _output(entry.model_dump())
    except Exception as e:
        _output({"error": str(e)}, error=True)


@cli.command("get-context")
@click.option("--key", required=True, help="Context key to retrieve")
@click.pass_context
def get_context(ctx, key: str):
    """Retrieve a shared context value by key."""
    try:
        value = _get_context_store(ctx.obj["zk_hosts"]).get(key)
        if value is None:
            _output({"key": key, "value": None, "status": "not_found"})
        else:
            _output({"key": key, "value": value})
    except Exception as e:
        _output({"error": str(e)}, error=True)


def main():
    cli()


if __name__ == "__main__":
    main()
