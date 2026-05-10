---
name: orchestrator-register
description: Register this Claude Code instance with the Claude MCP Server orchestrator for multi-agent collaboration. Use when joining a team of Claude instances, setting up for distributed task execution, or when the user says "register", "join the orchestrator", "connect to the team", or "上线".
---

# Orchestrator Registration

Register this Claude Code instance with the orchestrator so other instances can discover you and assign tasks to you.

## Prerequisites

The orchestrator MCP server must be configured in this session's MCP settings. Verify by calling `server_status` — it should report "ZooKeeper: connected".

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

Call `register_instance`:
- `name`: the chosen display name
- `role`: the chosen role (one of `architect`, `developer`, `tester`, `general`)

Save the returned `instance_id` — you will need it for every subsequent orchestrator operation.

### 4. Verify

Call `list_instances` to confirm your registration and see who else is online.

### 5. Report

Summarize: "Registered as **[name]** (**[role]**). **[N]** other instance(s) online."

List the other active instances with their roles and status.

## Re-registration

If you have an existing `instance_id`, pass it to `register_instance` to re-register under the same identity. This preserves your task history and message inbox.

## Next Steps

After registration, use the `orchestrator-agent` skill (`/orchestrator-agent`) to start claiming and executing tasks.
