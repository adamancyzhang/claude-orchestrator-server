---
name: claude-code-developer
description: Reference for developing Claude Code extensions — hooks, settings, MCP, CLI, and skills. Use when building tools on Claude Code, configuring automation, debugging hooks, or understanding extension points.
---

# Claude Code Developer Guide

Reference for building tools and automations on top of Claude Code. Covers hooks, settings, MCP integration, and CLI usage.

## Hooks

Hooks run shell commands at specific points in Claude Code's lifecycle. Configured in `settings.json` under `hooks.<EventName>`.

### Hook Event Reference

| Event | Matcher | Fires when | Use for |
|-------|---------|-----------|---------|
| `SessionStart` | — | Session starts | Auto-register, init workspace |
| `SessionEnd` | — | Session truly ends | Cleanup, unregister |
| `Stop` | — | Claude stops (clear/resume/compact too) | Logging — prefer `SessionEnd` for cleanup |
| `UserPromptSubmit` | — | User submits a prompt | Pre-processing, logging |
| `PreToolUse` | Tool name | Before a tool runs | Validation, blocking dangerous ops |
| `PostToolUse` | Tool name | After a tool succeeds | Formatting, logging, notifications |
| `PostToolUseFailure` | Tool name | After a tool fails | Error recovery |
| `PreCompact` | `"manual"`/`"auto"` | Before context compaction | Save state, warn user |
| `PostCompact` | `"manual"`/`"auto"` | After compaction | Post-processing |
| `Notification` | Notification type | On notifications | Custom notification handling |
| `PermissionRequest` | Tool name | Before permission prompt | Custom permission logic |
| `SubagentStart` | — | Subagent spawns | Agent lifecycle tracking |
| `SubagentStop` | — | Subagent exits | Agent lifecycle tracking |

### Hook Structure

```json
{
  "hooks": {
    "EVENT_NAME": [
      {
        "matcher": "ToolName|OtherTool",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

- **matcher**: tool name (`"Bash"`, `"Write"`, `"Edit"`), pipe-separated list (`"Write|Edit"`), or `""` to match all. For non-tool events, omit or use `""`.
- **hooks**: array of hook objects, each with `type` and type-specific fields.

### Hook Types

**command** — Shell command:
```json
{ "type": "command", "command": "echo 'hello'", "timeout": 30 }
```
- Receives JSON on stdin with event context
- `timeout` in seconds (optional)
- `statusMessage` for spinner text (optional)
- `once`: auto-remove after first run (optional)
- `async`: run in background without blocking (optional)

**prompt** — LLM evaluation (PreToolUse/PostToolUse/PermissionRequest only):
```json
{ "type": "prompt", "prompt": "Is this safe? $ARGUMENTS" }
```
- `$ARGUMENTS` placeholder replaced with hook input JSON

**agent** — Agent with tools (PreToolUse/PostToolUse/PermissionRequest only):
```json
{ "type": "agent", "prompt": "Verify tests pass", "timeout": 60 }
```

**http** — POST hook input to a URL:
```json
{ "type": "http", "url": "https://example.com/hook", "headers": {} }
```

**mcp_tool** — Call an MCP tool:
```json
{ "type": "mcp_tool", "server": "server-name", "tool": "tool_name", "input": {} }
```

### Hook stdin JSON

Hooks receive context on stdin. Key fields:

```json
{
  "session_id": "abc123",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path/to/file.txt", "content": "..." },
  "tool_response": { "success": true }
}
```

Extract with `jq`:
```bash
jq -r '.tool_input.file_path'
jq -r '.tool_input.command'  # for Bash
```

### Hook JSON Output

Commands can output JSON to control behavior:

```json
{
  "systemMessage": "Warning shown to user",
  "continue": false,
  "stopReason": "Blocked because...",
  "decision": "block",
  "reason": "Explanation",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Injected into model context",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Why allowed"
  }
}
```

### Common Hook Pitfalls

1. **`Stop` vs `SessionEnd`**: `Stop` fires on clear/resume/compact — use `SessionEnd` for cleanup
2. **Matcher is required**: each hook entry needs `"matcher"` (use `""` for all)
3. **Nested hooks array**: the outer `hooks` object contains arrays of `{matcher, hooks:[...]}`
4. **Silent failure**: invalid JSON in settings.json silently disables ALL settings from that file
5. **Hook command format**: `{matcher: "", hooks: [{type: "command", command: "..."}]}` — NOT flat `{matcher: "", command: "..."}`

## Settings

### File Locations

| File | Scope | Git | Use for |
|------|-------|-----|---------|
| `~/.claude/settings.json` | Global (user) | No | Personal preferences |
| `.claude/settings.json` | Project | Yes | Team-wide config |
| `.claude/settings.local.json` | Project local | Gitignore | Personal overrides |

Priority: user → project → local (later overrides earlier).

### Key Settings for Tool Developers

**Permissions** — allow/deny tool operations:
```json
{
  "permissions": {
    "allow": ["Bash(npm *)", "Bash(git *)"],
    "deny": ["Bash(rm -rf *)"],
    "defaultMode": "default"
  }
}
```

**MCP Servers** — manage server approval:
```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["orchestrator"],
  "disabledMcpjsonServers": ["blocked-server"]
}
```

**Environment Variables**:
```json
{ "env": { "DEBUG": "true", "ZK_HOSTS": "127.0.0.1:2181" } }
```

**Model & Agent**:
```json
{ "model": "sonnet", "agent": "agent-name" }
```

**Plugins**:
```json
{ "enabledPlugins": { "formatter@anthropic-tools": true } }
```

**Status Line** — custom terminal status bar:
```json
{
  "statusLine": {
    "type": "command",
    "command": "echo '$(date +%H:%M)'",
    "padding": 0
  }
}
```

### JSON Validation

Broken JSON in settings.json silently disables the entire file. Validate with:
```bash
jq -e '.hooks.SessionStart' .claude/settings.json
python3 -m json.tool .claude/settings.json > /dev/null
```

## MCP Integration

### .mcp.json Format

```json
{
  "mcpServers": {
    "server-name": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "headers": {
        "X-Instance-Name": "my-instance",
        "X-Instance-Role": "developer"
      }
    }
  }
}
```

- `type`: `"http"` for Streamable HTTP, `"stdio"` for subprocess
- `headers`: custom HTTP headers sent with every request
- MCP tools appear as callable tools in Claude Code

### MCP Server Best Practices

1. Use Streamable HTTP transport on `127.0.0.1` for local servers
2. Expose a `/health` endpoint for diagnostics
3. Provide REST endpoints alongside MCP tools for CLI-based interaction
4. Use `resources/subscribe` for push notifications to Claude Code
5. Stateless sessions simplify scaling (set `sessionIdGenerator: undefined`)

## CLI Reference

### Key Commands

```bash
claude                      # Interactive session
claude -p "prompt"          # One-shot, print and exit
claude -c                   # Continue last session
claude -r                   # Resume by ID or picker
claude --resume <id>        # Resume specific session
claude --model sonnet       # Override model
claude --mcp-config file.json  # Additional MCP config
claude --settings file.json    # Additional settings
claude --add-dir /path      # Additional workspace dir
claude --debug              # Debug mode
claude --debug hooks        # Debug hooks specifically
claude --bare               # Minimal mode (no hooks/LSP/plugins)
```

### Useful Subcommands

```bash
claude mcp                  # MCP server management
claude auth                 # Auth management
claude doctor               # Health check
claude update               # Check for updates
claude agents               # Background agents management
claude plugin               # Plugin management
```

### Hook Testing

```bash
# Debug hooks
claude --debug hooks

# Stream hook events
claude --include-hook-events --output-format stream-json -p "test"

# Validate hook JSON
jq -e '.hooks.<event>[] | select(.matcher == "<matcher>") | .hooks[] | select(.type == "command") | .command' .claude/settings.json
```

## Skills

### Skill File Format

Skills live in `skills/<name>/SKILL.md`:

```markdown
---
name: skill-name
description: One-line description — used for trigger matching
---

# Skill Title

Skill content with instructions for the LLM.
```

- `name`: unique identifier, used for `/skill-name` invocation
- `description`: used by Claude Code to auto-detect when to invoke the skill

### Skill Design Guidelines

1. **Clear triggers in description** — mention keywords users will say
2. **Step-by-step instructions** — the LLM follows the skill literally
3. **Include bash commands** — for the LLM to run
4. **Handle edge cases** — re-registration, cleanup, verification
5. **Keep it concise** — skills are loaded into context

## Development Workflow

### Testing a Hook

1. Write the hook in `.claude/settings.json`
2. Validate JSON: `jq -e '.hooks' .claude/settings.json`
3. Reload config: open `/hooks` in Claude Code or restart
4. Test with `--debug hooks` to see execution logs
5. For tool hooks: trigger the tool and verify the side effect
6. For lifecycle hooks (`SessionStart`, `SessionEnd`, `Stop`): restart Claude Code

### Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| Hook doesn't fire | Invalid JSON, wrong event name, matcher mismatch |
| All settings ignored | Syntax error in settings.json |
| Hook fires but command fails | Command not in PATH, permission denied, timeout |
| `Stop` fires unexpectedly | `Stop` triggers on clear/compact too — use `SessionEnd` |
| MCP tools not showing | Server not running, wrong URL in mcp.json, port conflict |
