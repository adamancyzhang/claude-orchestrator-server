# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Python MCP (Model Context Protocol) server that orchestrates multiple Claude Code instances — enabling instance discovery, task distribution, message passing, real-time notifications, and shared context.

ZooKeeper serves as the distributed coordination backbone: service discovery via ephemeral nodes, task ordering via sequential nodes, change notification via watches, and state storage in znode data.

## Tech Stack

- Python 3.12+
- `mcp[cli]` (Anthropic FastMCP SDK)
- FastAPI + uvicorn for Streamable HTTP transport (SSE)
- ZooKeeper 3.8+ via `kazoo` for distributed coordination
- Docker / docker-compose for local ZooKeeper

## Architecture

Four modules, all backed by ZooKeeper:

1. **Instance Registry** — Ephemeral znodes for registration, auto-cleanup on disconnect (no explicit heartbeat needed)
2. **Task Queue** — Sequential znodes for FIFO ordering, ephemeral claim nodes for atomicity
3. **Message Router** — ZK watches detect new messages; `notifications/resources/updated` notifies instances via MCP protocol; `poll_messages` and `wait_for_message` tools for retrieval
4. **Shared Context** — Persistent znodes for key-value storage with watch-based change notification

The MCP server exposes 17 tools, 5 resource URIs, and 2 prompts. See `docs/prd/README.md` for the full specification.

## Project Structure

```
├── pyproject.toml
├── docker-compose.yml         # ZooKeeper
├── docs/prd/
│   ├── README.md              # Full PRD
│   ├── architecture.md        # Component interaction, SSE, atomicity
│   └── zookeeper-schema.md    # ZK node tree, data formats, watch strategy
├── src/
│   ├── __init__.py
│   ├── server.py              # FastMCP entry point, tool registration
│   ├── zk_client.py           # ZooKeeper connection management
│   ├── registry.py            # Instance registry
│   ├── task_queue.py          # Task queue
│   ├── message_router.py      # Message routing + resource subscription + wait_for_message
│   ├── context_store.py       # Shared key-value store
│   └── models.py              # Pydantic data models
├── scripts/
│   ├── start-zk.sh
│   ├── start-server.sh
│   └── stop-all.sh
└── tests/
    ├── conftest.py
    ├── test_registry.py
    ├── test_task_queue.py
    ├── test_message_router.py
    └── test_integration.py
```

## Key Design Decisions

- **ZooKeeper over Redis**: Ephemeral nodes give us instance lifecycle for free. Sequential nodes provide atomic FIFO ordering. Watch mechanism enables true push without polling. Single dependency instead of Redis + PG.
- **Transport**: Streamable HTTP (SSE) on `127.0.0.1:3100`. Each instance keeps one SSE long connection for real-time push; tool calls use standard HTTP POST.
- **Instance identity**: `X-Instance-Name` + `X-Instance-Role` headers in mcp-config. Server assigns UUID on `register_instance`, validates against name whitelist.
- **Task claiming atomicity**: `zk.create(claimed_path)` is atomic — only one instance can claim a given task. Others retry the next match.
- **Real-time messages**: No custom SSE events (Claude Code silently drops unregistered notifications). Instead: (1) `resources/subscribe` on `orchestrator://messages/{id}` triggers `notifications/resources/updated` when new messages arrive — Claude Code's MCP SDK handles this natively and re-reads the resource. (2) `wait_for_message` tool for blocking long-poll when actively waiting for a reply. (3) `poll_messages` tool for explicit pull when needed.
- **No external database**: All state lives in ZooKeeper. Task history and messages use persistent znodes with TTL-based cleanup. For archival needs beyond ZK's data size limits, add a lightweight SQLite log.

## Development Commands

Once the project is scaffolded:

```bash
# Start ZooKeeper
docker-compose up -d

# Install dependencies
pip install -e ".[dev]"

# Run server
python -m src.server

# Run tests (with TestContainers or docker-compose ZK)
pytest -v

# Run a single test
pytest tests/test_task_queue.py::test_claim_atomicity -v
```
