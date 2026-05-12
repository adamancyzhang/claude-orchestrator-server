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

v0.3.1 delivers a **Leader-Worker CLI-native architecture**: no MCP server, no HTTP. The Leader runs a read-only TUI monitoring the team, while Workers connect directly to ZooKeeper and process messages via `claude -p`. All messaging happens through the CLI. Built-in Claude Code skills (task-planning, task-execution, task-verification, task-review, task-acceptance, task-traceability) enforce a standardized responsibility chain for every task.

```
┌─────────────────────────────────────────────────┐
│                  ZooKeeper                       │
│  /leader  /instances  /tasks  /messages  /context│
└──────┬──────────────┬──────────────┬────────────┘
       │              │              │
  ┌────┴────┐    ┌────┴────┐    ┌────┴────┐
  │ Leader  │    │ Worker  │    │ Worker  │
  │  (TUI)  │    │ (CLI)   │    │ (CLI)   │
  │ Tom     │    │ Jerry   │    │  Bob    │
  │architect│    │developer│    │ tester  │
  └─────────┘    └─────────┘    └─────────┘
       │              │              │
       └──────────────┼──────────────┘
                      │
              claude-orchestrator CLI
              (send-message, push-task, …)
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

### 3. Initialize your environment

```bash
# For the Leader (the team coordinator):
claude-orchestrator setup --leader --name Tom

# For each Worker (the doers):
claude-orchestrator setup --name Jerry --role developer
```

This creates `.claude-orchestrator/agents/` with message templates, `.claude/skills/` with responsibility-chain skills, and writes project + global config.

### 4. Start the Leader

```bash
claude-orchestrator leader --name Tom
# → TUI launches: team panel, task board, event log, footer
```

The Leader TUI is read-only — it shows who's online, what tasks are pending/in-progress, and a scrolling event log. All actions are triggered by CLI commands or Worker registrations.

### 5. Register a Worker

```bash
# Reads name/role from .claude-orchestrator/config.json (set during setup).
# Starts Worker Watcher — listens for messages and auto-processes via claude -p:
claude-orchestrator register
# Press Ctrl+C to stop and unregister
```

### 6. Go

Now the Leader TUI shows Jerry online. You can push tasks, send messages, and manage the full lifecycle — all from any terminal.

```bash
claude-orchestrator push-task --title "Implement login endpoint" --priority 0
claude-orchestrator send-message --to-name Jerry --content "Starting on the auth module?"
claude-orchestrator poll-task
```

---

## How It Works

### Leader-Worker Model

| Component | What it does | ZK magic |
|-----------|-------------|----------|
| **Leader** | Read-only TUI, monitors team, recovers orphaned tasks | `/leader` EPHEMERAL — only one Leader at a time |
| **Worker** | Persistent ZK connection, auto-processes messages via `claude -p` | Ephemeral nodes → auto-cleanup on disconnect |
| **Task Queue** | Push → Claim → In Progress → Complete (or Block/Fail/Retry) | Sequential nodes for FIFO, ephemeral claims for atomic locks |
| **Message Router** | P2P messages, broadcast, help requests, templates | Persistent-sequential nodes, ZK watches for push |
| **Context Store** | Shared key-value storage, watch for changes | Persistent nodes, cross-instance visibility |

### CLI-Native — No MCP Server

v0.3.0 removes the centralized MCP Server entirely. Leader and Workers each connect directly to ZooKeeper. Messages are delivered via ZK watches that trigger `$COMMAND -p "$MSG" | tee $CACHE_DIR/{key}.log` on the recipient. This eliminates 3 layers of indirection (MCP protocol, SSE, HTTP) and makes every node self-contained.

### CLI Commands (15)

| Command | What it does |
|---------|-------------|
| `leader` | Start Leader node with read-only TUI |
| `setup` | Initialize environment: templates, skills, config |
| `register` | Join the swarm. With `--work-dir`: persistent message watcher |
| `unregister` | Explicitly unregister an instance |
| `push-task` | Create a task (optionally assign to someone) |
| `claim-task` | Grab the next task — atomic, no two instances can claim the same one |
| `complete-task` | Mark a task done with results |
| `poll-task` | Check your claimed tasks |
| `task-block` | Mark a claimed task as blocked (with reason) |
| `task-fail` | Mark a claimed task as failed (with reason) |
| `task-retry` | Re-queue a failed task for retry (retry_count + 1, max 3) |
| `send-message` | DM another instance by name |
| `poll-message` | Check your inbox |
| `delete-message` | Delete a message from your inbox |
| `config` | Show current configuration |

All CLI commands return JSON. Every command supports `--zookeeper` / `-z` (or `ZK_HOSTS` env var) for pointing at a remote ZooKeeper.

---

## Example Session

Here's a real flow with a Leader (Tom) and two Workers (Jerry, Bob):

**Tom starts the Leader:**
```
claude-orchestrator leader --name Tom
→ TUI shows: [TEAM] Tom (leader), [PENDING] empty, [EVENT LOG] Leader started
```

**Jerry registers as a Worker:**
```bash
claude-orchestrator register
```
```
TUI updates:
  [TEAM] Jerry joined (developer)
  [EVENT] 9:15:03 PM Jerry joined (developer)
```

**Tom assigns work (from another terminal):**
```bash
claude-orchestrator push-task --title "Implement POST /api/auth/login" \
  --description "Email+password login, return JWT." --priority 0
```

**Jerry claims it:**
```bash
claude-orchestrator claim-task
# → { "id": "task-0000000000", "status": "claimed", ... }
```

**Jerry gets blocked:**
```bash
claude-orchestrator task-block --task-id task-0000000000 --reason "Waiting for API key"
```

**Tom sees the block in the TUI and sends the key:**
```bash
claude-orchestrator send-message --to-name Jerry --content "API key is in 1Password: auth/third-party/google-oauth"
```

**Jerry finishes:**
```bash
claude-orchestrator complete-task --task-id task-0000000000 --result "PR #42 — login endpoint with tests"
```

**Bob fails a task (test env down):**
```bash
claude-orchestrator task-fail --task-id task-0000000001 --reason "Test environment unavailable"
claude-orchestrator task-retry --task-id task-0000000001
# → Re-queued as task-0000000002 with retry_count: 1
```

---

## ZooKeeper Schema (v0.3.0)

```
/claude-orchestrator
├── leader                     [EPHEMERAL] Leader metadata
├── instances/
│   ├── a1b2c3d4...            [EPHEMERAL] Tom (leader)
│   ├── f6e5d4c3...            [EPHEMERAL] Jerry (developer)
│   └── e7f8a9b0...            [EPHEMERAL] Bob (tester)
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

**Key insight:** Ephemeral nodes mean crashed instances auto-unregister. Ephemeral claim nodes mean abandoned tasks auto-release. The Leader monitors `/instances` and recovers orphaned tasks when a Worker disconnects (max 3 retries, then archived as failed).

---

## Task State Machine (v0.3.0)

```
pending → claimed → in_progress → completed
                            → blocked → pending (retry)
                            → failed  → pending (retry, max 3)
claimed → pending (Worker disconnect, Leader recovers orphan)
```

| State | Meaning | Trigger |
|-------|---------|---------|
| `pending` | Waiting for claim | `push_task` |
| `claimed` | Claimed, not started | `claim_task` |
| `in_progress` | Working | `heartbeat(current_task=...)` |
| `completed` | Done | `complete_task` |
| `blocked` | Blocked, waiting unblock | `task-block` |
| `failed` | Failed, can retry | `task-fail` |

---

## Installation & Development

### Prerequisites

- Node.js 18+
- Docker (for ZooKeeper)
- Claude Code CLI (for `register --work-dir` message processing)

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

# Start the Leader
claude-orchestrator leader

# Or use the CLI directly
claude-orchestrator config
```

### Run Tests

```bash
npm test
```

---

## Skills for Claude Code

The repo includes Claude Code skills that enforce a standardized **responsibility chain**: Plan → Build → Verify → Review → Accept. Each link has a dedicated skill, grounded on the `task-traceability` foundation layer. The `setup` command installs all skills into `.claude/skills/`.

| Skill | Role | What it does |
|-------|------|-------------|
| `task-planning` | Planner | Analyze requirements, define blueprints, break down tasks, push to queue |
| `task-execution` | Builder | Claim tasks, implement against blueprints, commit code with traceability |
| `task-verification` | Verifier | Independently verify Builder output against Plan criteria |
| `task-review` | Reviewer | Review full chain (Plan→Build→Verify) for design consistency |
| `task-acceptance` | Accepter | Validate final deliverable against business criteria, sign Go/No-Go |
| `task-traceability` | Foundation | Trace → Execute → Map → Evidence → Record — all roles |
| `claude-orchestrator` | Infrastructure | Full CLI reference — all 15 commands with examples |
| `claude-code-developer` | Infrastructure | Hooks, settings, MCP, CLI reference for extending Claude Code |

---

## Why ZooKeeper?

| Concern | ZooKeeper answer |
|---------|-----------------|
| Instance lifecycle | Ephemeral nodes → auto-cleanup. No heartbeat polling needed. |
| Task ordering | Sequential nodes → guaranteed FIFO. No race conditions. |
| Claim atomicity | `create(path, ephemeral=true)` is atomic at the ZK level. Only one winner. |
| Leader election | `/leader` EPHEMERAL → exactly one Leader. Auto-released on crash. |
| Change notification | Built-in watches → push, not poll. |
| Dependencies | One dependency (ZK). No external database, no HTTP server. |

Zero external database. All state lives in ZooKeeper.

---

## Roles

| Role | Value | Typical behavior |
|------|-------|-----------------|
| Leader | `leader` | Runs TUI, monitors team, recovers orphaned tasks |
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
| Claude command | `--command` flag or `config.json` → `command` | `claude --dangerously-skip-permissions -v` |
| Cache directory | `--cache-dir` flag or `config.json` → `cache_dir` | `~/.claude-orchestrator/sessions` |

---

## Project Structure

```
├── src/
│   ├── index.ts               # CLI entry point (commander, 15 commands)
│   ├── config.ts              # Configuration handling
│   ├── cli/
│   │   └── commands.ts        # CLI subcommand implementations
│   ├── leader/                # Leader node (v0.3.0)
│   │   ├── index.ts           #   startup / shutdown orchestration
│   │   ├── tui.ts             #   ANSI-based read-only TUI
│   │   ├── event-bus.ts       #   typed EventEmitter
│   │   ├── state.ts           #   centralized LeaderState
│   │   ├── monitor.ts         #   WorkerMonitor — join/leave detection
│   │   ├── orchestrator.ts    #   TaskOrchestrator — lifecycle tracking
│   │   ├── recovery.ts        #   TaskRecovery — orphan recovery (max 3 retries)
│   │   └── watcher.ts         #   LeaderWatcher — message processing
│   ├── worker/                # Worker node (v0.3.0)
│   │   └── watcher.ts         #   WorkerWatcher — persistent message loop
│   ├── templates/             # Built-in agent templates
│   │   ├── leader-decompose.md #   Leader decompose prompt
│   │   ├── leader-decide.md   #   Leader decide prompt
│   │   ├── worker-plan.md     #   Planner template (task-traceability + task-acceptance)
│   │   ├── worker-build.md    #   Builder template (task-traceability)
│   │   ├── worker-verify.md   #   Verifier template (task-traceability)
│   │   ├── worker-review.md   #   Reviewer template (task-traceability)
│   │   └── worker-accept.md   #   Accepter template (task-traceability + task-acceptance)
│   ├── zk/
│   │   ├── client.ts          # ZooKeeper connection management
│   │   ├── paths.ts           # ZK path constants
│   │   └── watcher.ts         # ZK watch manager
│   ├── modules/
│   │   ├── registry.ts        # Instance registry
│   │   ├── task-queue.ts      # Task queue (6-state: push/claim/block/fail/retry)
│   │   ├── message-router.ts  # Message routing + template rendering + long-poll
│   │   └── context-store.ts   # Shared key-value store
│   ├── models/
│   │   └── schemas.ts         # Zod schemas and inferred types
│   └── utils/
│       ├── exec.ts            # Shell execution (execWithTee)
│       └── output.ts          # CLI output formatting
├── bin/
│   └── claude-orchestrator     # npm CLI entry (Node.js)
├── scripts/
│   ├── start-zk.sh             # Docker ZK launcher
│   ├── start-leader.sh         # Leader launcher
│   ├── start-worker.sh         # Worker launcher
│   ├── stop-all.sh             # Tear down
│   └── publish.sh              # npm publish pipeline
├── skills/                     # Claude Code skills (8 skills, responsibility chain)
│   ├── task-planning/           #   Planner skill
│   ├── task-execution/          #   Builder skill
│   ├── task-verification/       #   Verifier skill
│   ├── task-review/             #   Reviewer skill
│   ├── task-acceptance/         #   Accepter skill
│   ├── task-traceability/       #   Foundation layer skill
│   ├── claude-orchestrator/     #   CLI reference skill
│   └── claude-code-developer/   #   Claude Code extension skill
├── docs/
│   ├── v0.1.0/                 # Archived Python v0.1.0 docs
│   ├── v0.2.0/                 # Archived MCP-based v0.2.x docs
│   └── v0.3.0/                 # Current v0.3.0 docs
│       ├── prd/                # Full spec + architecture + ZK schema
│       └── migration-guide.md  # v0.2.0 → v0.3.0 migration
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
  <sub>Built with TypeScript and ZooKeeper. Orchestrate responsibly.</sub>
</p>
