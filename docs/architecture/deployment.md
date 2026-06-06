# Deployment Guide

## Prerequisites

- Node.js 18+
- pnpm 10+
- Claude Code CLI (`claude`) installed and available in PATH
- Git 2.0+ (for worktree support)

## Installation

### From npm (recommended)

```bash
npm install -g @adamancyzhang/claude-orchestrator
```

### From source

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server
pnpm install
pnpm -r build
```

## Quick Start

```bash
# Launch with 6 Workers (minimum recommended)
claude-orchestrator run --worker 6
```

This single command:
1. Validates configuration and skills
2. Creates isolated git worktrees for each Worker
3. Starts the Leader TUI
4. Forks Worker child processes

## Configuration

### Config File Locations (5-layer merge, highest priority first)

1. CLI flags (`-d`, `--debug`)
2. Environment variables
3. Worktree-local `.claude-orchestrator/config.json`
4. Project root `.claude-orchestrator/config.json`
5. Global `~/.claude-orchestrator/config.json`

### Sample Config

```json
{
  "commands": {
    "claude_cli": "claude --dangerously-skip-permissions --permission-mode dontAsk",
    "git": "git"
  },
  "cache_dir": ".claude-orchestrator/sessions",
  "hooks": [
    {
      "event": "worker_message_start",
      "command": "echo Worker started"
    }
  ]
}
```

### Key Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `commands.claude_cli` | `claude --dangerously-skip-permissions` | Claude CLI command |
| `commands.git` | `git` | Git command |
| `cache_dir` | `.claude-orchestrator/sessions` | Session cache directory |
| `hooks` | `[]` | Lifecycle hook definitions |

## Running Modes

### Interactive Mode (default)

```bash
claude-orchestrator run --worker 6
```

Opens a React/Ink TUI with 7 panels. Type requirements in the input line.

### Headless Mode

```bash
claude-orchestrator run --worker 6 --headless
```

Serializes state to `state.json` for CLI inspection. No TUI.

### Magic Mode

```bash
claude-orchestrator run --worker 6 --magic --magic-max-chains 10
```

Enables autonomous exploration. Explorer Worker spawns sub-chains.

## CLI Commands

### Interactive Commands

| Command | Description |
|---------|-------------|
| `run --worker <n>` | Launch with N Workers |
| `config` | Print resolved configuration |

### Headless Commands

| Command | Description |
|---------|-------------|
| `status` | Full orchestrator state |
| `workers` | Workers table |
| `tasks` | Pending and in-progress tasks |
| `events [--tail <n>]` | Event log (default: last 20) |
| `messages <worker>` | Message history for a worker |
| `chains` | Active and completed chains |
| `send <message>` | Send a message |
| `wait --task <id> [--timeout <s>]` | Wait for task completion |

All headless commands accept `--state-dir <dir>` (default: `.claude-orchestrator/state`).

## Common Flags

| Flag | Description |
|------|-------------|
| `-d, --debug` | Enable debug logging |
| `-y, --yes` | Skip interactive InitChecker prompts |
| `--headless` | Serialize state for CLI inspection |
| `--magic` | Enable Explorer role and spawn_chain |
| `--magic-max-chains <m>` | Hard cap on chain forest depth |

## Monitoring

```bash
# Monitor workers in real-time
watch -n 2 'claude-orchestrator workers'

# Wait for a specific task
claude-orchestrator wait --task task-42 --timeout 120

# View recent events
claude-orchestrator events --tail 50

# Check worker message history
claude-orchestrator messages worker-1
```

## Graceful Shutdown

Send SIGINT or SIGTERM to the Leader process. The system will:

1. Stop task dispatch
2. Wait for in-flight tasks to complete
3. Shutdown all Workers
4. Stop TUI and state writer
5. Unregister from InstanceRegistry
6. Close ZooKeeper connection

Timeout: 30 seconds (configurable via `GracefulShutdown`).

## Directory Structure After Launch

```
.claude-orchestrator/
├── config.json                    # Instance configuration
├── sessions/                      # Claude session logs
├── state/                         # Headless mode state files
│   ├── state.json
│   └── commands.jsonl
├── worktree/                      # Worker git worktrees
│   ├── Tom/
│   │   ├── .claude-orchestrator/
│   │   │   ├── agents/            # Worker agent templates
│   │   │   └── docs/Tom/          # Worker memory
│   │   └── CLAUDE.md              # Team CLAUDE.md
│   ├── Jerry/
│   └── ...
├── chains/                        # Chain audit trails
│   ├── chain-abc123/
│   │   ├── manifest.json
│   │   ├── audit.jsonl
│   │   └── requirement.md
│   └── ...
└── merges/                        # Merge validation logs
    └── chain-abc123/
```

## Troubleshooting

### Workers not starting

- Check `claude` CLI is installed: `claude --version`
- Check Node.js version: `node --version` (requires 18+)
- Enable debug mode: `claude-orchestrator run --worker 6 -d`

### Merge conflicts

The system automatically detects merge conflicts and creates retry tasks. Check chain audit logs:

```bash
cat .claude-orchestrator/chains/<chain-id>/audit.jsonl | jq .
```

### Worker crashes

Workers auto-restart up to 3 times. Check Worker logs in `.claude-orchestrator/sessions/`.

### Performance

- Minimum 6 Workers recommended for full pipeline (planner, executor, verifier, reviewer, accepter, explorer)
- Each Worker runs in its own process with isolated git worktree
- In-memory coordination means no disk I/O for message passing
