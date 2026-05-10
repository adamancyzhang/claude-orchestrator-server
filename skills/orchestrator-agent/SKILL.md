---
name: orchestrator-agent
description: Operate as an autonomous agent in the orchestrator — check messages, claim tasks, execute them, and report completion. Use when the user wants this instance to "start working", "claim a task", "be an agent", "go to work", "开始工作", or process tasks from the orchestrator queue. Also use after registration to begin the work loop.
---

# Orchestrator Agent

Operate as a worker in the orchestrator: claim tasks, execute them, report results, and repeat. Before using this skill, you must be registered (see `orchestrator-register`).

## Required State

Your `instance_id` is stored in `~/.claude-orchestrator/config.json` after registration. All CLI commands read it automatically.

## Work Loop

Execute steps 1-6. After step 6, loop back to step 1.

### Step 1: Check for incoming messages

```bash
claude-orchestrator poll-messages
```

If messages are returned:
- Read each one. If someone is asking you a question, respond via `claude-orchestrator send-message --to <id> --content "..."` before continuing.
- If a message is a broadcast announcement, acknowledge it but don't reply unless action is needed.
- If a message is a help request (`type=help`), respond if you have relevant expertise.

If no messages, proceed to step 2.

### Step 2: Update heartbeat

```bash
claude-orchestrator heartbeat
```

This keeps your registration alive and signals you're ready.

### Step 3: Claim a task

```bash
claude-orchestrator claim-task
```

- If the output contains `"status": "no_tasks"` — report this to the user and stop the loop. Check back after any new work is assigned.
- If a task is returned, extract the `id` (task_id), `title`, and `description`.

### Step 4: Announce and update status

Tell the user: "Claimed task **[task_id]**: **title**"

```bash
claude-orchestrator heartbeat --current-task "<task title>"
```

This lets other instances see you're busy.

### Step 5: Execute the task

Carry out the task according to its description. Use all available tools (code editing, shell commands, web search, etc.).

If you encounter blockers:
- Try alternative approaches first.
- If truly stuck, use `/orchestrator-help` to broadcast a help request.
- Do NOT mark the task complete until the work is done.

### Step 6: Complete the task

When the task is fully done:

```bash
claude-orchestrator complete-task --task-id <task_id> --result "<summary>"
```

The result should be a concise summary of what was accomplished. Include relevant details (files changed, tests run, decisions made).

### Step 7: Loop

Return to step 1 to check for new messages and claim the next task.

## Task Selection Rules

The orchestrator assigns tasks by priority:

1. Tasks explicitly `assigned_to` you always come first.
2. Among unassigned tasks, `priority=0` (HIGH) comes before `priority=1` (MEDIUM) before `priority=2` (LOW).
3. Within the same priority, FIFO order applies.

## Heartbeat Cadence

- Call `claude-orchestrator heartbeat` at least once every 60 seconds while working on a long task.
- ZK session timeout is 30s by default; regular heartbeats prevent your ephemeral nodes from being cleaned up.
- If your ephemeral nodes are lost, your claimed tasks are automatically released back to the queue.

## Error Recovery

- **ZooKeeper is not connected**: Wait 10 seconds and retry (ZK auto-reconnects). If persistent, check `docker-compose ps`.
- **"No instance_id found"**: Your registration may have expired. Re-register: `claude-orchestrator register --name <name> --role <role>`.
- **Claim returns no_tasks repeatedly**: Someone else is claiming faster. The queue will rebalance — keep trying.
- **Task already claimed by another instance**: This is normal (optimistic locking). Step 3 will automatically retry with the next task.
