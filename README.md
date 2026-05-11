# Claude Orchestrator

<p align="center">
  <strong>Turn Claude Code instances into a multi-agent swarm — coordinated through ZooKeeper.</strong>
  <br/>
  <em><a href="README_zh.md">中文文档</a></em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@adamancyzhang/claude-orchestrator"><img src="https://img.shields.io/npm/v/@adamancyzhang/claude-orchestrator?color=blue" alt="npm"></a>
  <a href="https://github.com/adamancyzhang/claude-orchestrator-server"><img src="https://img.shields.io/github/license/adamancyzhang/claude-orchestrator-server" alt="license"></a>
  <img src="https://img.shields.io/badge/node-18%2B-green" alt="node">
  <img src="https://img.shields.io/badge/typescript-5.6%2B-blue" alt="typescript">
  <img src="https://img.shields.io/badge/ZooKeeper-3.8%2B-orange" alt="zookeeper">
</p>

---

## What is this?

**Claude Orchestrator** lets you run multiple Claude Code instances that talk to each other — assign tasks, send messages, share context, and collaborate on real work. Think of it as giving each Claude Code instance a walkie-talkie and a shared kanban board, then watching them build together.

Behind the scenes, ZooKeeper acts as the coordination backbone: ephemeral nodes for instance heartbeat, sequential nodes for FIFO task ordering, and watches for real-time change notification.

```
┌──────────────────────────────────────────────────────────┐
│                    Claude Orchestrator                    │
│                   (MCP Server :3100)                      │
│                                                          │
│  ┌──────────────┐  ┌──────────┐  ┌──────────────┐       │
│  │   Registry   │  │   Tasks   │  │   Messages   │       │
│  │  who's here? │  │  FIFO Q   │  │  P2P + cast  │       │
│  └──────┬───────┘  └────┬─────┘  └──────┬───────┘       │
│         └────────────────┼──────────────┘                │
│                   ┌──────┴──────┐                        │
│                   │  ZooKeeper  │                        │
│                   └──────┬──────┘                        │
│                   ┌──────┴──────┐                        │
│                   │   Context   │                        │
│                   │   KV Store  │                        │
│                   └─────────────┘                        │
└──────────────────────────────────────────────────────────┘
         ▲                    ▲                    ▲
         │                    │                    │
    ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
    │  Tom    │          │ Jerry   │          │  Bob    │
    │Architect│          │Developer│          │ Tester  │
    └─────────┘          └─────────┘          └─────────┘
```

---

## Quick Start

### 1. Install the CLI

```bash
npm install -g @adamancyzhang/claude-orchestrator
```

### 2. Start ZooKeeper

```bash
docker-compose up -d
```

### 3. Start the MCP Server

```bash
claude-orchestrator server
# → MCP server listening on http://127.0.0.1:3100
```

### 4. Configure Claude Code

Use the built-in setup command to auto-configure your project:

```bash
claude-orchestrator setup --name Tom-Architect --role architect --with-hook
```

This writes the MCP connection to `.claude/mcp.json` and adds lifecycle hooks: `SessionStart` (auto-register) and `Stop` (auto-unregister).

Options:
- `--global` — write to `~/.claude/mcp.json` instead of local `.claude/mcp.json`
- `--port`, `--host` — if your server runs on a different address
- `--name`, `--role` — set instance identity headers
- `--with-hook` — add SessionStart + Stop hooks for automatic lifecycle

### 5. Go

Restart Claude Code in this project — the `SessionStart` hook auto-registers your instance. Or register manually with `/orchestrator-register`.

Now open another terminal, start a second Claude Code instance, run `claude-orchestrator setup` with a different name/role, and they'll discover each other, pass tasks, and collaborate.

---

## How It Works

### Four Modules, One ZooKeeper

| Module | What it does | ZK magic |
|--------|-------------|----------|
| **Instance Registry** | Register, heartbeat, discover, unregister | Ephemeral nodes → auto-cleanup on disconnect |
| **Task Queue** | Push → Claim → Complete | Sequential nodes for FIFO, ephemeral claims for atomic locks |
| **Message Router** | P2P messages, broadcast, help requests, long-poll | Persistent-sequential nodes, ZK watches for push |
| **Context Store** | Shared key-value storage, watch for changes | Persistent nodes, cross-instance visibility |

### The MCP Tools (18)

Each Claude Code instance calls these tools to participate in the swarm:

| # | Tool | What it does |
|---|------|-------------|
| 1 | `register_instance` | Join the swarm with a name and role |
| 2 | `heartbeat` | Stay alive, optionally report what you're working on |
| 3 | `list_instances` | See who's online right now |
| 4 | `push_task` | Create a task (optionally assign to someone specific) |
| 5 | `claim_task` | Grab the next task — atomic, no two instances can claim the same one |
| 6 | `complete_task` | Mark a task done with results |
| 7 | `list_tasks` | View tasks by status (pending / claimed / completed) |
| 8 | `send_message` | DM another instance or broadcast to everyone |
| 9 | `poll_messages` | Check your inbox |
| 10 | `wait_for_message` | Long-poll — block until a message arrives |
| 11 | `dismiss_message` | Delete a message from your inbox |
| 12 | `request_help` | Broadcast a question to the whole team |
| 13 | `set_context` | Write a shared key-value entry |
| 14 | `get_context` | Read a shared key-value entry |
| 15 | `delete_context` | Remove a shared context key |
| 16 | `list_context_keys` | List all context keys |
| 17 | `mark_read` | Mark a specific message as read |
| 18 | `server_status` | Health check |

### Or Use the CLI Directly

If you prefer the terminal over Claude Code:

```bash
# Register
claude-orchestrator register --name Alice --role developer

# See who's around
claude-orchestrator list-instances

# Push a task
claude-orchestrator push-task --title "Add rate limiting" --priority 0

# Claim the next task
claude-orchestrator claim-task

# Send a message
claude-orchestrator send-message --to <instance-id> --content "How's PR #42 going?"

# Check inbox
claude-orchestrator poll-messages

# Wait for messages (blocks until received or timeout)
claude-orchestrator wait-for-message --timeout 60

# Dismiss a message
claude-orchestrator dismiss-message --message-id msg-0000000000

# Share context
claude-orchestrator set-context --key "api_version" --value "v2.1"

# Read shared context
claude-orchestrator get-context --key "api_version"

# List context keys
claude-orchestrator list-context-keys

# Delete context
claude-orchestrator delete-context --key "api_version"

# Watch context for changes
claude-orchestrator watch-context --key "jwt_strategy"

# Watch for new tasks
claude-orchestrator watch-tasks

# Unregister
claude-orchestrator unregister

# Show config
claude-orchestrator config

# Health check
claude-orchestrator status
```

All CLI commands return JSON. Every command supports `--zookeeper` / `-z` (or `ZK_HOSTS` env var) for pointing at a remote ZooKeeper.

---

## Example Session

Here's a real flow with two instances — Tom (Architect) and Jerry (Developer):

**Tom registers:**
```json
{ "id": "a1b2c3d4...", "name": "Tom", "role": "architect", "status": "idle" }
```

**Jerry registers:**
```json
{ "id": "f6e5d4c3...", "name": "Jerry", "role": "developer", "status": "idle" }
```

**Tom lists instances:**
```
2 active instances:
  [architect] Tom (a1b2c3d4...) status=idle
  [developer] Jerry (f6e5d4c3...) status=idle
```

**Tom assigns work:**
```
push_task:
  title: "Implement POST /api/auth/login"
  description: "Email+password login, return JWT. Handle validation and errors."
  priority: HIGH (0)
  assignee: f6e5d4c3... (Jerry)
```

**Jerry claims it:**
```
claim_task → Got it! task-0000000000
heartbeat current_task="task-0000000000"
```

**Jerry gets stuck and asks for help:**
```
request_help:
  question: "What should the JWT expiry be? Access vs refresh token?"
  context: "Express + jsonwebtoken, ~100K DAU"
```

**Tom checks messages and replies:**
```
poll_messages → 1 new message from Jerry
send_message to=Jerry: "15min access, 7d refresh. Use Redis blacklist for logout."
```

**Tom records the decision:**
```
set_context key="jwt_strategy" value="access:15min, refresh:7d, blacklist:redis"
```

**Jerry finishes:**
```
complete_task task_id="task-0000000000" result="PR #42 — implemented login endpoint with tests"
```

No polling required for task claiming — the atomic claim mechanism means Jerry always gets the right task. Messages are delivered instantly via ZooKeeper's persistent-sequential nodes.

---

## ZooKeeper Schema

```
/claude-orchestrator
├── instances/
│   ├── a1b2c3d4...    [EPHEMERAL] Tom's registration
│   └── f6e5d4c3...    [EPHEMERAL] Jerry's registration
├── tasks/
│   ├── pending/
│   │   ├── task-0000000000    [PERSISTENT_SEQUENTIAL]
│   │   └── task-0000000001    [PERSISTENT_SEQUENTIAL]
│   ├── claimed/
│   │   └── f6e5d4c3-task-0000000000  [EPHEMERAL] ← atomic lock!
│   └── completed/
│       └── task-0000000000    [PERSISTENT]
├── messages/
│   ├── a1b2c3d4.../
│   │   └── msg-0000000000    [PERSISTENT_SEQUENTIAL]
│   └── f6e5d4c3.../
│       └── msg-0000000000    [PERSISTENT_SEQUENTIAL]
└── context/
    └── jwt_strategy          [PERSISTENT]
```

**Key insight:** Ephemeral nodes mean crashed instances auto-unregister. Ephemeral claim nodes mean abandoned tasks auto-release. No deadlocks, no orphans. ZooKeeper handles the lifecycle.

---

## Installation & Development

### Prerequisites

- Node.js 18+
- Docker (for ZooKeeper)
- Claude Code (for the MCP integration)

### From Source

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server

# Install dependencies
npm install

# Start ZooKeeper
docker-compose up -d

# Build TypeScript
npm run build

# Start the server
claude-orchestrator server

# Or use the CLI directly
claude-orchestrator status
```

### Run Tests

```bash
npm test
```

---

## Skills for Claude Code

The repo includes Claude Code skills that make the orchestrator even easier to use:

| Skill | What it does |
|-------|-------------|
| `claude-orchestrator` | Full CLI reference — all 21 commands with examples |
| `orchestrator-setup` | Auto-configure MCP connection and auto-registration hook |
| `orchestrator-register` | Guided registration flow |
| `orchestrator-status` | Dashboard: health, instances, tasks |
| `orchestrator-communicate` | Message patterns: poll, DM, broadcast |
| `orchestrator-help` | Help-request workflow |
| `orchestrator-agent` | Autonomous agent loop: check → claim → work → complete |

---

## Why ZooKeeper?

| Concern | ZooKeeper answer |
|---------|-----------------|
| Instance lifecycle | Ephemeral nodes → auto-cleanup. No heartbeat polling needed. |
| Task ordering | Sequential nodes → guaranteed FIFO. No race conditions. |
| Claim atomicity | `create(path, ephemeral=true)` is atomic at the ZK level. Only one winner. |
| Change notification | Built-in watches → push, not poll. |
| Dependencies | One dependency (ZK). No external database needed. |

Zero external database. All state lives in ZooKeeper.

---

## Roles

| Role | Value | Typical behavior |
|------|-------|-----------------|
| Architect | `architect` | Sets standards, designs tasks, reviews results |
| Developer | `developer` | Claims tasks, writes code, submits PRs |
| Tester | `tester` | Claims test tasks, E2E verification |
| General | `general` | Any role |

---

## Configuration Reference

| Config | Where | Default |
|--------|-------|---------|
| ZK hosts | `-z, --zookeeper` flag or `ZK_HOSTS` env | `127.0.0.1:2181` |
| Instance ID | `-i, --instance-id` flag or `.claude-orchestrator/config.json` (project) / `~/.claude-orchestrator/config.json` (global) | auto-saved after `register` |
| MCP server host | `--host` flag or `ORCHESTRATOR_HOST` env | `127.0.0.1` |
| MCP server port | `--port` flag or `ORCHESTRATOR_PORT` env | `3100` |

---

## Project Structure

```
├── src/
│   ├── index.ts               # CLI entry point (commander)
│   ├── server.ts              # MCP server — 18 tools, 5 resources, 2 prompts
│   ├── config.ts              # Configuration handling
│   ├── cli/
│   │   └── commands.ts        # CLI subcommand implementations
│   ├── zk/
│   │   ├── client.ts          # ZooKeeper connection management
│   │   ├── paths.ts           # ZK path constants
│   │   └── watcher.ts         # ZK watch manager
│   ├── modules/
│   │   ├── registry.ts        # Instance registry
│   │   ├── task-queue.ts      # Task queue with atomic claim
│   │   ├── message-router.ts  # Message routing + long-poll
│   │   └── context-store.ts   # Shared key-value store
│   ├── models/
│   │   └── schemas.ts         # Zod schemas and inferred types
│   └── utils/
│       └── output.ts          # CLI output formatting
├── bin/
│   └── claude-orchestrator     # npm CLI entry (Node.js)
├── scripts/
│   ├── start-zk.sh             # Docker ZK launcher
│   ├── start-server.sh         # Server launcher
│   ├── stop-all.sh             # Tear down
│   └── publish.sh              # npm publish pipeline
├── skills/                     # Claude Code skills
├── docs/
│   ├── v0.1.0/                 # Archived Python v0.1.0 docs
│   └── v0.2.0/                 # Current TypeScript docs
│       ├── prd/                # Full spec + architecture
│       └── operations-guide.md # Step-by-step walkthrough
├── tests/
│   ├── unit/
│   └── integration/
├── docker-compose.yml          # ZooKeeper
├── package.json                # npm package definition
└── tsconfig.json               # TypeScript configuration
```

---

## License

MIT — use it, fork it, ship it.

---

<p align="center">
  <sub>Built with TypeScript, ZooKeeper, and the MCP protocol. Orchestrate responsibly.</sub>
</p>
