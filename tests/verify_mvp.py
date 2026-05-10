"""End-to-end verification script for the MVP MCP server.

Run with: python tests/verify_mvp.py
Requires: server running on 127.0.0.1:3100
"""

import asyncio
import json

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def main():
    async with streamablehttp_client("http://127.0.0.1:3100/mcp") as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # 1. List tools
            tools = await session.list_tools()
            tool_names = [t.name for t in tools.tools]
            print(f"Available tools ({len(tool_names)}): {tool_names}\n")

            # 2. Register two instances
            r1 = await session.call_tool("register_instance", {"name": "Tom", "role": "architect"})
            tom = json.loads(r1.content[0].text)
            tom_id = tom["id"]
            print(f"[Tom registered] id={tom_id[:8]}... role={tom['role']}")

            r2 = await session.call_tool("register_instance", {"name": "Jerry", "role": "developer"})
            jerry = json.loads(r2.content[0].text)
            jerry_id = jerry["id"]
            print(f"[Jerry registered] id={jerry_id[:8]}... role={jerry['role']}\n")

            # 3. List instances
            r3 = await session.call_tool("list_instances", {})
            print(f"list_instances:\n{r3.content[0].text}\n")

            # 4. Heartbeat
            r4 = await session.call_tool("heartbeat", {"instance_id": tom_id, "current_task": "reviewing PRD"})
            print(f"heartbeat: {r4.content[0].text}\n")

            # 5. Push tasks
            r5 = await session.call_tool("push_task", {
                "title": "Implement POST /api/items",
                "description": "Create the items endpoint per OpenAPI spec",
                "priority": 0,
                "instance_id": tom_id,
                "assignee": jerry_id,
            })
            print(f"push_task: {r5.content[0].text}")

            r6 = await session.call_tool("push_task", {
                "title": "Write E2E tests",
                "description": "Test the entire items workflow",
                "priority": 1,
                "instance_id": tom_id,
            })
            task2_text = r6.content[0].text
            task2_id = task2_text.split()[1]
            print(f"push_task: {task2_text}\n")

            # 6. List pending tasks
            r7 = await session.call_tool("list_tasks", {"status": "pending"})
            print(f"list_tasks(pending):\n{r7.content[0].text}\n")

            # 7. Jerry claims a task
            r8 = await session.call_tool("claim_task", {"instance_id": jerry_id})
            print(f"claim_task (Jerry):\n{r8.content[0].text}\n")

            # 8. Jerry completes the task
            task1_id = r8.content[0].text.split()[2]  # "Claimed task task-xxx:"
            r9 = await session.call_tool("complete_task", {
                "instance_id": jerry_id,
                "task_id": task1_id,
                "result": "PR #42 — implemented full CRUD",
            })
            print(f"complete_task: {r9.content[0].text}\n")

            # 9. List all tasks
            r10 = await session.call_tool("list_tasks", {})
            print(f"list_tasks(all):\n{r10.content[0].text}\n")

            # 10. Send a message
            r11 = await session.call_tool("send_message", {
                "instance_id": tom_id,
                "content": "How is the implementation going?",
                "to_instance": jerry_id,
            })
            print(f"send_message: {r11.content[0].text}\n")

            # 11. Poll messages
            r12 = await session.call_tool("poll_messages", {"instance_id": jerry_id})
            print(f"poll_messages (Jerry):\n{r12.content[0].text}\n")

            # 12. Request help
            r13 = await session.call_tool("request_help", {
                "instance_id": jerry_id,
                "question": "Which database migration strategy should I use?",
                "context": "Working on items API, need to add new tables",
            })
            print(f"request_help: {r13.content[0].text}\n")

            # 13. Tom polls messages
            r14 = await session.call_tool("poll_messages", {"instance_id": tom_id})
            print(f"poll_messages (Tom):\n{r14.content[0].text}\n")

            # 14. Shared context
            r15 = await session.call_tool("set_context", {
                "key": "db_migration_strategy",
                "value": "alembic with --sql audit mode",
                "instance_id": tom_id,
            })
            print(f"set_context: {r15.content[0].text}")

            r16 = await session.call_tool("get_context", {"key": "db_migration_strategy"})
            print(f"get_context: {r16.content[0].text}\n")

            # 15. List instances again
            r17 = await session.call_tool("list_instances", {})
            print(f"list_instances (final):\n{r17.content[0].text}")

            print("\n=== MVP Verification Complete ===")


if __name__ == "__main__":
    asyncio.run(main())
