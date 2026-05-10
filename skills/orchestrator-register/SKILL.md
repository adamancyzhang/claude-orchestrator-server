---
name: orchestrator-register
description: Register this Claude Code instance with the orchestrator for multi-agent collaboration. Use when joining a team of Claude instances, setting up for distributed task execution, or when the user says "register", "join the orchestrator", "connect to the team", or "上线".
---

# Orchestrator Registration

Register this Claude Code instance with the orchestrator so other instances can discover you and assign tasks to you.

## Prerequisites

The `claude-orchestrator` CLI must be installed (`pip install -e .` from the project root).

Verify ZooKeeper is running:

```bash
claude-orchestrator status
```

Should report `"zookeeper": "connected"`.

## Registration Steps

### 1. Determine role

Ask the user or infer from context:

| Role | Best for |
|------|----------|
| `architect` | High-level design, task decomposition, code review |
| `developer` | Implementation, bug fixes, feature development |
| `tester` | Test writing, quality verification, E2E validation |
| `general` | Any type of work (default) |

### 2. Determine name

Choose a distinctive name. Convention: `{Name}-{Role}` (e.g., `Jerry-Dev`, `Lucy-Test`). If the user doesn't specify, ask.

### 3. Register

Run:

```bash
claude-orchestrator register --name <name> --role <role>
```

The CLI saves the returned `instance_id` to `~/.claude-orchestrator/config.json` automatically. All subsequent commands will use it.

### 4. Verify

Run `claude-orchestrator list-instances` to confirm your registration and see who else is online.

### 5. Report

Summarize: "Registered as **[name]** (**[role]**). **[N]** other instance(s) online."

List the other active instances with their roles and status.

## Re-registration

If you have an existing `instance_id`, pass it via `--instance-id` to re-register under the same identity:

```bash
claude-orchestrator register --name <name> --role <role> --instance-id <id>
```

This preserves your task history and message inbox.

## Next Steps

After registration, use the `orchestrator-agent` skill (`/orchestrator-agent`) to start claiming and executing tasks.
