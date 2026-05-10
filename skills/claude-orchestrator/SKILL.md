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
pip install -e .
docker-compose up -d   # start ZooKeeper
```

Verify:

```bash
claude-orchestrator status
# {"status": "healthy", "zookeeper": "connected", "instances_online": 0}
```

## Global Options

| Option | Env var | Default | Description |
|--------|---------|---------|-------------|
| `--zk-hosts` | `ZK_HOSTS` | `127.0.0.1:2181` | ZooKeeper connection string |
| `--instance-id` | — | auto (from config) | Override stored instance ID |

## Commands

### Registration

**Register** this instance:

```bash
claude-orchestrator register --name Jerry-Dev --role developer
# {"id": "a1b2c3d4...", "name": "Jerry-Dev", "role": "developer", "status": "idle", ...}
```

The returned `id` is saved to `~/.claude-orchestrator/config.json`. Pass `--instance-id` on re-registration to reuse the same identity.

**Heartbeat** — keep registration alive, optionally declare current task:

```bash
claude-orchestrator heartbeat
claude-orchestrator heartbeat --current-task "fix-login-bug"
```

ZK session timeout is 30s. Call heartbeat regularly (every 30-60s) while working.

**List instances:**

```bash
claude-orchestrator list-instances
# [{"id": "...", "name": "Jerry-Dev", "role": "developer", "status": "busy", ...}, ...]
```

### Tasks

**Push a task** to the queue:

```bash
claude-orchestrator push-task --title "Fix login bug" --description "..." --priority 0
claude-orchestrator push-task --title "Review PR #42" --assignee <instance-id>
```

Priority: `0` = HIGH, `1` = MEDIUM (default), `2` = LOW.

**Claim a task** — FIFO, higher priority first, assigned-to-you tasks jump the queue:

```bash
claude-orchestrator claim-task
# {"id": "task-0000000001", "title": "Fix login bug", ...}   ← claimed
# {"status": "no_tasks", "message": "No pending tasks available."}  ← empty queue
```

**Complete a task:**

```bash
claude-orchestrator complete-task --task-id task-0000000001 --result "Fixed auth middleware, added tests"
```

**List tasks:**

```bash
claude-orchestrator list-tasks
claude-orchestrator list-tasks --status pending
claude-orchestrator list-tasks --status claimed
claude-orchestrator list-tasks --status completed
```

### Messages

**Send a direct message:**

```bash
claude-orchestrator send-message --to <instance-id> --content "Can you review my PR?"
```

**Broadcast to all:**

```bash
claude-orchestrator send-message --broadcast --content "CI is down, don't push"
```

**Poll messages:**

```bash
claude-orchestrator poll-messages
# [{"id": "msg-...", "type": "direct", "from_name": "Lucy-Test", "content": "...", "read": true}]
```

**Request help** (broadcasts to all):

```bash
claude-orchestrator request-help --question "How do I test the auth flow?" --context "stack trace..."
```

### Shared Context

**Set:**

```bash
claude-orchestrator set-context --key ci_status --value "failing: auth tests"
```

**Get:**

```bash
claude-orchestrator get-context --key ci_status
# {"key": "ci_status", "value": "failing: auth tests"}
```

### Status

```bash
claude-orchestrator status
# {"status": "healthy", "zookeeper": "connected", "instances_online": 3}
```

## Workflow

A typical agent session:

```bash
# 1. Join the team
claude-orchestrator register --name Jerry-Dev --role developer

# 2. Check who's online
claude-orchestrator list-instances

# 3. Work loop
while true; do
  claude-orchestrator poll-messages     # check for messages
  task=$(claude-orchestrator claim-task)  # grab work
  if [ "$task" = "no_tasks" ]; then break; fi
  # ... execute the task ...
  claude-orchestrator complete-task --task-id <id> --result "Done: ..."
done
```

## Error recovery

- **ZooKeeper not connected**: check `docker-compose ps`, retry. ZK client auto-reconnects.
- **"No instance_id found"**: register first, or pass `--instance-id`
- **Registration expired**: ephemeral nodes cleaned up on disconnect. Re-register with same `--instance-id` to restore identity.
