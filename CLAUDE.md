# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A CLI-native multi-agent orchestration system backed by ZooKeeper. Leader runs a read-only TUI; Workers connect directly to ZK and auto-process messages via `claude -p`. No MCP server, no HTTP — everything is CLI + ZK watches.

## Development Commands

```bash
# Start ZooKeeper
docker-compose up -d

# Install dependencies
npm install

# Build (compiles TypeScript + copies templates and skills to dist/)
npm run build

# Start Leader (TUI)
node dist/index.js leader --name Tom

# Start Worker
node dist/index.js register

# Run all tests
npm test              # vitest run

# Run tests in watch mode
npm run test:watch    # vitest

# Run a single test
npx vitest run tests/unit/leader.test.ts
```

## Architecture

### No MCP Server — CLI-Native

v0.3.x removed the centralized MCP server. Leader and Workers each connect directly to ZooKeeper. Message delivery happens via ZK watches triggering `claude -p` on the recipient. This is a fundamental difference from v0.2.x — there are no MCP tools, resources, prompts, SSE, or Express.

### Leader Node (`src/leader/`)

The Leader is a read-only TUI with an event-driven architecture:

```
ZK watches (instances, tasks, messages)
  → LeaderEventBus (typed EventEmitter, 11 event types)
    → LeaderState (centralized state, .apply() reduces each event)
      → LeaderTui (ANSI escape-code rendering, re-renders on every event)
```

**Subsystems started by `leader/index.ts`:**

| Subsystem | Role |
|-----------|------|
| `WorkerMonitor` | Watches `/instances` children → emits `worker_joined` / `worker_left` |
| `TaskOrchestrator` | Watches `/tasks/pending` and `/tasks/claimed` → emits `task_created` / `task_claimed` / `task_completed` |
| `TaskRecovery` | On `worker_left`, scans claimed tasks for that worker → re-queues (max 3 retries) or archives as failed |
| `LeaderWatcher` | Watches own message dir → routes to `DecisionEngine` (if msg has `link`) or `TaskGenerator` (otherwise) |
| `DecisionEngine` | Evaluates Worker completion reports via `claude -p` + `leader-decide.md` template → pass/feedback/reject |
| `TaskGenerator` | Decomposes requirements via `claude -p` + `leader-decompose.md` template → creates responsibility chains |

The TUI has a keyboard input line — typed text is sent as a message to the Leader's own ZK message queue, which the `LeaderWatcher` picks up and routes to `TaskGenerator` for decomposition.

### Worker Node (`src/worker/watcher.ts`)

A persistent ZK watch loop on the Worker's own message directory. On new message:
1. Selects the template by `msg.link` (`plan`/`build`/`verify`/`review`/`accept` or `_generic`)
2. Renders template variables (`{{name}}`, `{{content}}`, `{{work_dir}}`, etc.)
3. Executes `$COMMAND -p "$prompt" | tee $CACHE_DIR/{key}.log`
4. If the message has a `link`, sends a completion report back to the Leader

### ZooKeeper Modules (`src/modules/`)

| Module | Responsibility |
|--------|---------------|
| `registry.ts` | Instance register/unregister/heartbeat (ephemeral nodes) |
| `task-queue.ts` | push/claim/complete/block/fail/retry + role-link priority sorting |
| `message-router.ts` | send (name-based or broadcast), poll, waitForMessage, template rendering |

### Role-Link Task Claiming

When claiming tasks, `TaskQueue.claim()` sorts pending tasks with a composite key:
1. Tasks explicitly assigned to this instance (first)
2. Tasks whose `link` matches the instance's role (`planner`→`plan`, `builder`→`build`, etc.)
3. Priority (HIGH=0 first)
4. Task ID (FIFO)

This ensures planners claim `plan` tasks, builders claim `build` tasks, etc., but any worker can claim any task as a fallback.

### Responsibility Chain

```
plan → build → verify → review → accept
```

Each link is a Claude Code skill under `skills/` and a Worker template under `src/templates/`. Tasks in a chain share a `chain_id`. The Leader's `DecisionEngine` evaluates each link's completion before activating the next.

### Configuration Layering

`src/config.ts` merges two config files:
- **Global**: `~/.claude-orchestrator/config.json` (ZK hosts, cache_dir, commands)
- **Project**: `.claude-orchestrator/config.json` (instance_id, name, role, command overrides)

Project overrides global for commands. ZK hosts can also come from CLI `-z` flag or `ZK_HOSTS` env var.

### ZK Client (`src/zk/client.ts`)

Wraps `node-zookeeper-client` with promisified methods. Key behaviors:
- Auto-reconnect with exponential backoff (10 attempts)
- `mkdirp` on connect ensures all base paths exist
- Watch methods return current children AND set a ZK watch for future changes
- `claimTask` relies on ZK's atomic `create(path, EPHEMERAL)` — only one caller succeeds

### ZK Node Tree

```
/claude-orchestrator
├── leader                     [EPHEMERAL] Leader metadata
├── instances/{id}             [EPHEMERAL] Instance metadata
├── tasks/
│   ├── pending/task-NNNNN     [PERSISTENT_SEQUENTIAL]
│   ├── claimed/{insId}-task-NNNNN [EPHEMERAL] ← atomic claim lock
│   └── completed/task-NNNNN   [PERSISTENT]
└── messages/{instanceId}/msg-NNNNN [PERSISTENT_SEQUENTIAL]
```

Context store (`/context`) paths are defined in `paths.ts` but not actively used by the Leader/Worker flow.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point (commander, 15 commands) |
| `src/config.ts` | Config loading, layering, instance ID persistence |
| `src/leader/index.ts` | Leader startup orchestration — wires all subsystems |
| `src/leader/event-bus.ts` | Typed EventEmitter with 11 `LeaderEventType` values |
| `src/leader/state.ts` | `LeaderState.apply()` — reduces events into display state |
| `src/leader/tui.ts` | ANSI escape-code TUI rendering (team, tasks, event log, input) |
| `src/leader/watcher.ts` | Leader message watch → DecisionEngine / TaskGenerator routing |
| `src/leader/decision-engine.ts` | Claude-driven decision on Worker completion reports |
| `src/leader/task-generator.ts` | Claude-driven requirement decomposition into task chains |
| `src/leader/recovery.ts` | Orphan task recovery on Worker disconnect (max 3 retries) |
| `src/worker/watcher.ts` | Worker message watch → template render → `claude -p` |
| `src/zk/client.ts` | ZooKeeper client — all ZK operations + watch methods |
| `src/zk/paths.ts` | ZK path constants and helper functions |
| `src/modules/task-queue.ts` | Task lifecycle: push/claim/complete/block/fail/retry/list |
| `src/modules/message-router.ts` | Message send/poll/wait/dismiss + template rendering |
| `src/models/schemas.ts` | Zod schemas for Instance, Task, Message + factory functions |
| `src/utils/exec.ts` | `execWithTee` (streaming) and `execAndCapture` (buffered) |
| `src/templates/` | Agent prompt templates (leader-decompose, leader-decide, worker-{plan,build,verify,review,accept}) |
| `skills/` | Claude Code skills for responsibility chain + CLI reference |

## Testing

Tests use **Vitest**. No ZK mock library — tests spin up a real ZooKeeper (docker-compose). Integration tests (`tests/integration/leader-worker.test.ts`) test the full Leader+Worker flow. Unit tests (`tests/unit/`) focus on individual modules.

```bash
npm test                    # vitest run (all tests)
npx vitest run tests/unit/leader.test.ts   # single file
```
