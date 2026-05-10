---
name: orchestrator-status
description: View the orchestrator dashboard showing all instances, tasks, and system health. Use when the user wants to "check status", "view the dashboard", "see what's happening", "list all agents", "查看状态", or monitor orchestrator activity.
---

# Orchestrator Status Dashboard

View the current state of the entire orchestrator — health, instances, tasks, and shared context.

## Steps

### 1. Server health

```bash
claude-orchestrator status
```

Verify ZooKeeper is connected. If disconnected, report the issue — no other operations will work until ZK reconnects.

### 2. Instance overview

```bash
claude-orchestrator list-instances
```

For each instance, note:
- **name** — display name
- **role** — architect / developer / tester / general
- **status** — idle (ready for work), busy (working on a task), or blocked (stuck)
- **current_task_id** — what they're working on (if busy)

### 3. Task overview

```bash
claude-orchestrator list-tasks
```

Group by status and report:
- **Pending**: tasks waiting to be claimed
- **Claimed**: tasks currently being worked on (with claimant)
- **Completed**: finished tasks (with results)

### 4. Summarize

Present a concise summary:

```
## Orchestrator Status

**Server**: healthy (ZK connected)
**Instances**: N online

| Name | Role | Status | Current Task |
|------|------|--------|-------------|
| ... | ... | ... | ... |

**Tasks**: X pending, Y in progress, Z completed
```

### Filtering tasks

To see only tasks of a specific status:

```bash
claude-orchestrator list-tasks --status pending    # unclaimed tasks
claude-orchestrator list-tasks --status claimed    # in-progress tasks
claude-orchestrator list-tasks --status completed  # finished tasks
```

### Shared context

To view shared context entries, use `claude-orchestrator get-context --key <key>` for keys you're interested in. Common keys might include project conventions, current milestone, or active decisions. Ask other instances or check with `claude-orchestrator list-instances` to discover context keys.
