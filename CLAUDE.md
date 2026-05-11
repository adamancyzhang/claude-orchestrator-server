# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js MCP (Model Context Protocol) server that orchestrates multiple Claude Code instances — enabling instance discovery, task distribution, message passing, real-time notifications, and shared context.

ZooKeeper serves as the distributed coordination backbone: service discovery via ephemeral nodes, task ordering via sequential nodes, change notification via watches, and state storage in znode data.

## Tech Stack

- Node.js 18+ / TypeScript 5.6+
- `@modelcontextprotocol/sdk` (Anthropic MCP SDK)
- Express for Streamable HTTP transport (SSE)
- ZooKeeper 3.8+ via `node-zookeeper-client` for distributed coordination
- `zod` for runtime schema validation
- `commander` for CLI
- Docker / docker-compose for local ZooKeeper

## Architecture

Four modules, all backed by ZooKeeper:

1. **Instance Registry** — Ephemeral znodes for registration, auto-cleanup on disconnect
2. **Task Queue** — Sequential znodes for FIFO ordering, ephemeral claim nodes for atomicity
3. **Message Router** — ZK watches detect new messages; `notifications/resources/updated` notifies instances via MCP protocol; `poll_messages` and `wait_for_message` tools for retrieval
4. **Shared Context** — Persistent znodes for key-value storage with watch-based change notification

The MCP server exposes 18 tools, 5 resource URIs, and 2 prompts. See `docs/v0.2.0/prd/README.md` for the full specification.

## Project Structure

```
├── package.json
├── tsconfig.json
├── docker-compose.yml         # ZooKeeper
├── docs/
│   ├── v0.1.0/                # Archived Python v0.1.0 docs
│   │   ├── prd/               # Original PRD + architecture + ZK schema
│   │   └── operations-guide.md
│   └── v0.2.0/                # Current TypeScript v0.2.0 docs
│       ├── prd/
│       │   ├── README.md      # Full PRD (updated for TS)
│       │   ├── architecture.md # Component interaction, SSE, atomicity
│       │   └── zookeeper-schema.md # ZK node tree, data formats, watch strategy
│       └── operations-guide.md # Step-by-step walkthrough (Chinese)
├── src/
│   ├── index.ts               # CLI entry point
│   ├── server.ts              # MCP server entry + tool/resource/prompt registration
│   ├── config.ts              # Configuration handling
│   ├── cli/
│   │   └── commands.ts        # CLI subcommand implementations
│   ├── zk/
│   │   ├── client.ts          # ZooKeeper connection management
│   │   ├── paths.ts           # ZK path constants
│   │   └── watcher.ts         # ZK watch manager
│   ├── modules/
│   │   ├── registry.ts        # Instance registry
│   │   ├── task-queue.ts      # Task queue
│   │   ├── message-router.ts  # Message routing + resource subscription + wait_for_message
│   │   └── context-store.ts   # Shared key-value store
│   ├── models/
│   │   └── schemas.ts         # Zod schemas and inferred types
│   └── utils/
│       └── output.ts          # CLI output formatting
├── scripts/
│   ├── start-zk.sh
│   ├── start-server.sh
│   ├── stop-all.sh
│   └── publish.sh
└── tests/
    ├── unit/
    └── integration/
```

## Key Design Decisions

- **ZooKeeper over Redis**: Ephemeral nodes give us instance lifecycle for free. Sequential nodes provide atomic FIFO ordering. Watch mechanism enables true push without polling. Single dependency instead of Redis + PG.
- **Transport**: Streamable HTTP (SSE) on `127.0.0.1:3100`. Each instance keeps one SSE long connection for real-time push; tool calls use standard HTTP POST.
- **Instance identity**: `X-Instance-Name` + `X-Instance-Role` headers in mcp-config. Server assigns UUID on `register_instance`, validates against name whitelist.
- **Task claiming atomicity**: `zk.create(claimedPath, ephemeral=True)` is atomic — only one instance can claim a given task. Others retry the next match.
- **Real-time messages**: No custom SSE events (Claude Code silently drops unregistered notifications). Instead: (1) `resources/subscribe` on `orchestrator://messages/{id}` triggers `notifications/resources/updated` when new messages arrive — Claude Code's MCP SDK handles this natively and re-reads the resource. (2) `wait_for_message` tool for blocking long-poll when actively waiting for a reply. (3) `poll_messages` tool for explicit pull when needed.
- **No external database**: All state lives in ZooKeeper. Task history and messages use persistent znodes with TTL-based cleanup.
- **Pure npm distribution**: `npm install -g` installs the CLI directly. No binary downloads needed.

## MCP Tools Reference

| # | Tool | Description |
|---|------|-------------|
| 1 | `register_instance` | Join the swarm with a name and role |
| 2 | `heartbeat` | Stay alive, optionally report current task |
| 3 | `list_instances` | List all active instances |
| 4 | `push_task` | Create a task in the queue |
| 5 | `claim_task` | Atomically claim the next pending task |
| 6 | `complete_task` | Mark a claimed task as done |
| 7 | `list_tasks` | View tasks by status (pending/claimed/completed) |
| 8 | `send_message` | DM or broadcast a message |
| 9 | `poll_messages` | Check inbox (non-blocking) |
| 10 | `wait_for_message` | Long-poll — block until message arrives |
| 11 | `mark_read` | Mark a message as read |
| 12 | `dismiss_message` | Delete a message |
| 13 | `request_help` | Broadcast a help request |
| 14 | `set_context` | Write a shared key-value entry |
| 15 | `get_context` | Read a shared key-value entry |
| 16 | `delete_context` | Remove a shared context key |
| 17 | `list_context_keys` | List all context keys |
| 18 | `server_status` | Health check (ZK connection, port) |

### MCP Resources
| URI | Description | Subscription |
|-----|-------------|:---:|
| `orchestrator://instances` | Active instance list | — |
| `orchestrator://tasks/pending` | Pending tasks | — |
| `orchestrator://tasks/in-progress` | Claimed tasks in progress | — |
| `orchestrator://messages/{instance_id}` | Instance messages | **Yes** |
| `orchestrator://context/{key}` | Context value | **Yes** |

### MCP Prompts
| Prompt | Description |
|--------|-------------|
| `orchestrate-task` | Break down a goal into assignable tasks |
| `team-status` | Summarize current team state |

## Documentation

Docs are organized by version under `docs/`:

- **`docs/v0.1.0/`** — Archived Python v0.1.0 documentation (git history is authoritative)
- **`docs/v0.2.0/`** — Current TypeScript v0.2.0 docs
  - `prd/README.md` — Full product requirements document
  - `prd/architecture.md` — Component interaction, SSE transport, claim atomicity
  - `prd/zookeeper-schema.md` — ZK node tree, data formats, watch strategy
  - `operations-guide.md` — Step-by-step operational walkthrough (Chinese)

When making changes that affect the spec, update `docs/v0.2.0/prd/` accordingly. For a new major version, create `docs/vX.Y.0/`.

## Development Commands

```bash
# Start ZooKeeper
docker-compose up -d

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start MCP server
node dist/index.js --server

# Run CLI commands
node dist/index.js status
node dist/index.js register --name my-instance

# Run tests
npm test
```

## CLI Usage

```
claude-orchestrator --server              # Start MCP server
claude-orchestrator <command> [options]   # CLI command mode

Global options:
  -z, --zookeeper <hosts>   ZK connection (env: ZK_HOSTS, default: 127.0.0.1:2181)
  -i, --instance-id <id>    Instance ID (persisted in ~/.claude-orchestrator/config.json)
  -h, --help                Show help
  -V, --version             Show version

Server options:
  --port <port>             Server port (env: ORCHESTRATOR_PORT, default: 3100)
  --host <host>             Server host (env: ORCHESTRATOR_HOST, default: 127.0.0.1)

Commands:
  status | register | heartbeat | list-instances | push-task | claim-task |
  complete-task | list-tasks | send-message | poll-messages | wait-for-message |
  dismiss-message | request-help | set-context | get-context | delete-context |
  list-context-keys | watch-context | watch-tasks | unregister | config
```
