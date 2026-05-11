---
name: orchestrator-setup
description: Configure Claude Code to connect to the orchestrator MCP server. Use when the user wants to set up, configure, initialize, or connect to the orchestrator for the first time.
---

# Orchestrator Setup

Configure a Claude Code project to connect to the orchestrator MCP server. The `setup` command writes `.claude/mcp.json` so Claude Code can discover and use the orchestrator tools.

## What Setup Does

The `claude-orchestrator setup` command:

1. Writes/updates `.claude/mcp.json` with an `orchestrator` entry pointing to the MCP server
2. Persists instance name/role to `.claude-orchestrator/config.json` (or `~/.claude-orchestrator/config.json` with `--global`) for auto-registration
3. Optionally adds a `SessionStart` hook so the instance auto-registers on Claude Code startup

This replaces manually editing JSON files — one command, fully configured.

## How Registration Works

The `SessionStart` hook runs `claude-orchestrator register` which:

1. Reads name/role/instance_id from `.claude-orchestrator/config.json` (project-local first, then global fallback)
2. Calls the MCP server's `POST /register` endpoint — the server creates an ephemeral ZK node using its persistent connection, so the instance stays visible as long as the server is running
3. If the MCP server isn't reachable, falls back to direct ZooKeeper connection
4. Saves the returned `instance_id` and reuses it on subsequent calls (no more duplicate IDs)

**Important:** The MCP server (`claude-orchestrator server`) must be running for instances to appear in ZK. Without the server, instances registered via CLI will disappear when the command exits.

## Prerequisites

Check these before running setup:

```bash
# 1. CLI installed?
claude-orchestrator --version

# 2. ZooKeeper running? (if already started)
claude-orchestrator status
# Should report "zookeeper": "connected". If ZK isn't running yet, that's fine —
# setup doesn't require ZK, but the server will need it.
```

## Setup Flow

### 1. Gather preferences

Ask the user (or infer from context):

| Question | Default | Notes |
|----------|---------|-------|
| Instance name? | ask | Convention: `{Name}-{Role}` (e.g., `Jerry-Dev`) |
| Instance role? | `general` | One of: `architect`, `developer`, `tester`, `general` |
| Global or local? | local (project `.claude/`) | `--global` writes to `~/.claude/mcp.json` instead |
| Auto-register hook? | yes | `--with-hook` adds a `SessionStart` hook to auto-register |
| Server host/port? | `127.0.0.1:3100` | Only ask if the user mentions a custom setup |

### 2. Build the command

Start with the base:

```bash
claude-orchestrator setup
```

Add flags based on what was gathered:

| Condition | Flag |
|-----------|------|
| User specified a name | `--name <name>` |
| User specified a role | `--role <role>` |
| User wants global config | `--global` |
| User wants auto-registration | `--with-hook` |
| Custom server host | `--host <host>` |
| Custom server port | `--port <port>` |

Typical recommended invocation (with auto-registration):

```bash
claude-orchestrator setup --name <name> --role <role> --with-hook
```

### 3. Run setup

Execute the command. It will:

- Create `.claude/` directory if needed
- Write `.claude/mcp.json` with the orchestrator entry
- Save instance config to `.claude-orchestrator/config.json` (project-local) or `~/.claude-orchestrator/config.json` (with `--global`)
- Add `SessionStart` hook if `--with-hook` was used

### 4. Verify

Check the generated file:

```bash
cat .claude/mcp.json
# or for global:
cat ~/.claude/mcp.json
```

Should show:
```json
{
  "mcpServers": {
    "orchestrator": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "headers": {
        "X-Instance-Name": "<name>",
        "X-Instance-Role": "<role>"
      }
    }
  }
}
```

### 5. Report

Summarize what was configured:

- "Configured orchestrator MCP server at `http://<host>:<port>/mcp`"
- "Instance name: **`<name>`**, role: **`<role>`**"
- If `--with-hook`: "SessionStart hook added — instance will auto-register on Claude Code startup"
- If `--global`: "Config written to `~/.claude/mcp.json` (global)"
- "Instance config saved to `.claude-orchestrator/config.json`" (or `~/.claude-orchestrator/config.json` if `--global`)

## Common Scenarios

### First-time team setup (recommended)

```bash
claude-orchestrator setup --name Tom-Architect --role architect --with-hook
```

This is the all-in-one setup. After this, restarting Claude Code in this project auto-registers the instance.

### Setup without auto-registration

```bash
claude-orchestrator setup --name Jerry-Dev --role developer
```

The user will need to manually call `register_instance` or run `claude-orchestrator register` on first use.

### Global setup (all projects)

```bash
claude-orchestrator setup --name Jerry-Dev --role developer --global --with-hook
```

Every Claude Code session on this machine will have orchestrator access and auto-register.

### Re-configure (change name/role/host)

Just re-run `setup` with the new values. It merges into the existing `.claude/mcp.json`, preserving other MCP server entries.

## Next Steps

1. **Start ZooKeeper** (if not already): `docker-compose up -d`
2. **Start the MCP server**: `claude-orchestrator server` — required for instances to persist in ZK
3. **Restart Claude Code** — the `SessionStart` hook auto-registers via the MCP server, or use `/orchestrator-register` to register manually
4. Use `/orchestrator-status` to confirm everything is online
