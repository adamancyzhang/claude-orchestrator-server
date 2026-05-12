---
name: claude-orchestrator
description: Multi-agent orchestration CLI backed by ZooKeeper for service discovery. Register instances, distribute tasks, send messages, and share context across Claude Code instances. Use when the user wants to register, join a team, claim tasks, send messages, check status, or any orchestrator operation.
---

# Claude Orchestrator

A CLI that provides multi-agent orchestration directly on top of ZooKeeper. Every Claude Code instance becomes a discoverable agent — register, claim tasks, communicate, and share context without a middleman server.

## Architecture

```
Claude Code  ──CLI──>  ZooKeeper
(instance A)          (service discovery, task queue, messages, context)

Claude Code  ──CLI──>  ZooKeeper
(instance B)
```

Every CLI command talks directly to ZooKeeper. Instance discovery is via ephemeral znodes. Tasks use sequential znodes for FIFO ordering. Messages use watch-based push.

## Setup

```bash
npm install -g @adamancyzhang/claude-orchestrator
docker-compose up -d   # start ZooKeeper
```

Initialize environment:

```bash
# Leader (team coordinator):
claude-orchestrator setup --leader --name Tom

# Worker (the doers):
claude-orchestrator setup --name Jerry --role builder
```

This creates:
- `.claude-orchestrator/agents/` — message templates (7 templates for leader + 5 worker links)
- `.claude/skills/` — 8 Claude Code skills (responsibility chain + infrastructure)
- `.claude-orchestrator/config.json` — project config (name, role)
- `~/.claude-orchestrator/config.json` — global config (ZK hosts, CLI command, cache dir)

Verify:

```bash
claude-orchestrator config
# Shows current configuration
```

## Global Options

| Option | Env var | Default | Description |
|--------|---------|---------|-------------|
| `--zookeeper`, `-z` | `ZK_HOSTS` | `127.0.0.1:2181` | ZooKeeper connection string |
| `--instance-id`, `-i` | — | auto (from config) | Override stored instance ID |

## Commands

### Leader

```bash
claude-orchestrator leader --name Tom
# Launches read-only TUI: team panel, task board, event log
```

Only one Leader at a time (ZK ephemeral node). The TUI shows who's online, what tasks are in each state, and a scrolling event log.

### Registration

**Setup** — one-time initialization:

```bash
claude-orchestrator setup --leader --name Tom                    # Leader
claude-orchestrator setup --name Jerry --role builder             # Worker
claude-orchestrator setup --name Lucy --role verifier \
  --cache-dir ~/shared/sessions --command "claude -p"             # Custom CLI
```

Setup options:

| Option | Default | Description |
|--------|---------|-------------|
| `--leader` | false | Initialize as Leader environment |
| `--name <name>` | — | Instance display name |
| `--role <role>` | builder | Role: planner, builder, verifier, reviewer, accepter |
| `--cache-dir <path>` | `~/.claude-orchestrator/sessions` | Shared cache directory |
| `--command <cmd>` | `claude --dangerously-skip-permissions --permission-mode dontAsk` | Claude CLI command |
| `--global` | false | Write only global config, skip project files |

**Register** — join the swarm:

```bash
# Connect and listen for messages (reads name/role from .claude-orchestrator/config.json):
claude-orchestrator register
# Worker Watcher starts, listens for messages, processes via claude -p
# Press Ctrl+C to stop and unregister
```

Registration creates an ephemeral ZK node. The instance auto-deregisters on disconnect (Ctrl+C or timeout). The Worker Watcher listens for messages on `/messages/{instance_id}` and processes them using the template that matches the message's `link` field.

**Unregister:**

```bash
claude-orchestrator unregister
```

### Tasks

**Push a task** to the queue:

```bash
claude-orchestrator push-task --title "Implement login endpoint" --priority 0
claude-orchestrator push-task --title "Verify auth module" --link verify --priority 1
claude-orchestrator push-task --title "Review PR #42" --link review --assignee <instance-id>
claude-orchestrator push-task --title "Part 2" --chain-id chain-001 --depends-on task-0000000001
```

Push options:

| Option | Default | Description |
|--------|---------|-------------|
| `--title <text>` | required | Task title |
| `--description <text>` | "" | Task description |
| `--priority <n>` | 1 | 0=HIGH, 1=MEDIUM, 2=LOW |
| `--assignee <id>` | — | Target instance ID |
| `--link <link>` | — | Responsibility chain link: plan, build, verify, review, accept |
| `--chain-id <id>` | — | Group related tasks under one chain |
| `--depends-on <ids>` | — | Comma-separated task IDs this task depends on |
| `--blocked-by <ids>` | — | Comma-separated task IDs blocking this task |

**Claim a task** — FIFO, higher priority first, assigned-to-you tasks jump the queue:

```bash
claude-orchestrator claim-task
# → { "id": "task-0000000001", "title": "Implement login endpoint", "status": "claimed", ... }
# → { "status": "no_tasks", "message": "No pending tasks available." }
```

**Complete a task:**

```bash
claude-orchestrator complete-task --task-id task-0000000001 --result "PR #42 — login endpoint with tests"
```

**Poll tasks:**

```bash
claude-orchestrator poll-task
claude-orchestrator poll-task --status pending
claude-orchestrator poll-task --status claimed
claude-orchestrator poll-task --status completed
claude-orchestrator poll-task --status blocked
claude-orchestrator poll-task --status failed
```

**Task lifecycle commands:**

```bash
claude-orchestrator task-block --task-id task-0000000001 --reason "Waiting for API key"
claude-orchestrator task-fail --task-id task-0000000001 --reason "Test environment unavailable"
claude-orchestrator task-retry --task-id task-0000000001
# → Re-queued with retry_count + 1 (max 3 retries)
```

Task state machine:

```
pending → claimed → in_progress → completed
                            → blocked → pending (retry)
                            → failed  → pending (retry, max 3)
claimed → pending (Worker disconnect, Leader recovers orphan)
```

### Messages

**Send a direct message:**

```bash
claude-orchestrator send-message --to-name Jerry --content "Can you review my PR?"
```

**Broadcast to all:**

```bash
claude-orchestrator send-message --broadcast --content "CI is down, don't push"
```

**Request help** (broadcasts to all with help flag):

```bash
claude-orchestrator send-message --request-help --broadcast --content "How do I test the auth flow?"
```

**Poll messages:**

```bash
claude-orchestrator poll-message
# [{ "id": "msg-...", "type": "direct", "from_name": "Tom", "content": "...", "read": true }]
```

**Delete a message:**

```bash
claude-orchestrator delete-message --message-id msg-0000000000
```

### Config

```bash
claude-orchestrator config
# Shows global and project configuration
```

## Roles

| Role | Value | Typical behavior |
|------|-------|-----------------|
| Leader | `leader` | Runs TUI, monitors team, recovers orphaned tasks |
| Planner | `planner` | Uses `task-planning` + `task-traceability` skills |
| Builder | `builder` | Uses `task-execution` + `task-traceability` skills |
| Verifier | `verifier` | Uses `task-verification` + `task-traceability` skills |
| Reviewer | `reviewer` | Uses `task-review` + `task-traceability` skills |
| Accepter | `accepter` | Uses `task-acceptance` + `task-traceability` skills |

## Workflow

A typical agent session:

```bash
# 1. Initialize (first time only)
claude-orchestrator setup --name Jerry --role builder

# 2. Join the team — Worker Watcher auto-processes incoming messages via claude -p
claude-orchestrator register
# Press Ctrl+C to stop and unregister
```

## Error recovery

- **ZooKeeper not connected**: check `docker-compose ps`, retry. ZK client auto-reconnects.
- **"No instance_id found"**: run `setup` first, or check `.claude-orchestrator/config.json`
- **Registration expired**: ephemeral nodes cleaned up on disconnect. Re-register to restore identity.
