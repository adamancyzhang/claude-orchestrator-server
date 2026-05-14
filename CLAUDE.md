# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A CLI-native multi-agent orchestration system backed by ZooKeeper. Leader runs an interactive TUI (input line for user requirements, Tab/Shift+Tab/1–9 to switch the focused Worker's message panel); Workers connect directly to ZK and auto-process messages via `claude -p`. No MCP server, no HTTP — everything is CLI + ZK watches.

## Development Commands

```bash
# Start ZooKeeper
docker-compose up -d

# Install dependencies
npm install

# Build (compiles TypeScript + copies templates and skills to dist/)
npm run build

# Start full orchestration (Leader TUI + 3 Workers)
node dist/index.js run --worker 3

# Start with debug trace
node dist/index.js run --worker 3 --debug

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

The Leader is a TUI with an event-driven architecture and keyboard input:

```
ZK watches (instances, tasks, messages)
  → LeaderEventBus (typed EventEmitter, 17 event types)
    → LeaderState (centralized state, .apply() reduces each event)
      → LeaderTui (ANSI escape-code rendering, re-renders on every event)
```

**Subsystems started by `leader/index.ts`:**

| Subsystem | Role |
|-----------|------|
| `WorkerMonitor` | Watches `/instances` children → emits `worker_joined` / `worker_left` |
| `TaskOrchestrator` | Watches `/tasks/pending` and `/tasks/claimed` → emits `task_created` / `task_claimed` / `task_completed` |
| `TaskRecovery` | On `worker_left`, scans claimed tasks for that worker → re-queues (max 3 retries) or archives as failed |
| `LeaderWatcher` | Watches own message dir → routes to `ChainRouter` for mechanical dispatching |
| `ChainRouter` | Mechanical router — self-processes decompose via claude-cli when template available, otherwise forwards to Planner Worker. Parses task definitions, executes Worker self-evaluation decisions |

Task decomposition may be self-processed by Leader when the decompose template is loaded, or forwarded to a Planner Worker. Decision evaluation is a Worker capability. The Leader handles message forwarding, task creation from structured definitions, and mechanical execution of EvalDecision JSON from Workers.

The TUI has a keyboard input line — typed text is sent as a message to the Leader's own ZK message queue, which the `LeaderWatcher` picks up and routes to `ChainRouter` for forwarding to a Planner Worker.

### Worker Node (`src/worker/`)

Workers run as child processes (forked by the orchestrator) in isolated git worktrees:

| File | Role |
|------|------|
| `worktree-initializer.ts` | Name generation, git worktree creation, role assignment, template/skill seeding |
| `child.ts` | Child process entry point (forked by orchestrator) |
| `child-runner.ts` | Full worker child initialization: chdir to worktree, connect ZK, start watch loop |
| `watcher.ts` | ZK watch loop + orchestration. Wires template rendering, Claude execution, self-evaluation, and completion reporting |
| `evaluator.ts` | Built-in self-evaluation after task completion. Loads `worker-evaluate.md`, runs Claude, returns EvalDecision JSON |
| `commit-checker.ts` | Auto-commits changes after task completion (for chain-link tasks) |

### Executor (`src/executor/`)

Standalone template execution, reusable across Leader and Worker:

| File | Role |
|------|------|
| `template.ts` | TemplateEngine — loads templates from agents directory, renders with identity card + variable substitution |
| `runner.ts` | ClaudeRunner — CLI execution wrapper with `execWithTee` and `execWithStreaming`, manages log/output/result paths |

### Hooks (`src/hooks/`)

`HookEngine` fires shell scripts for lifecycle events (`worker_message_start`, `worker_message_end`, etc.). Environment variables (`CO_EVENT`, `CO_WORKER_NAME`, `CO_TASK_ID`, etc.) are set on the spawned process.

### Orchestrator (`src/orchestrator/`)

`run.ts` provides a 5-phase unified startup: (1) environment setup, (2) worktree initialization, (3) leader startup with TUI, (4) worker child process forking, (5) wait for shutdown.

### Worker Message Processing Flow

A persistent ZK watch loop on the Worker's own message directory. On new message:
1. `TemplateEngine` selects and renders the template by `msg.link`
2. `HookEngine` fires `worker_message_start` hook
3. `ClaudeRunner` executes `$COMMAND -p "$prompt" | tee $CACHE_DIR/{key}.log`
4. `HookEngine` fires `worker_message_end` hook
5. For chain-link tasks, `CommitChecker` auto-commits changes
6. For chain-link tasks, `SelfEvaluator` runs built-in evaluation via `worker-evaluate.md`
7. Completion report (with EvalDecision JSON or ChainDef JSON) is sent back to Leader

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

Each link is a Claude Code skill under `skills/` and a Worker template under `templates/`. Tasks in a chain share a `chain_id`. Each Worker self-evaluates its own output after completing a task, then sends an EvalDecision JSON to the Leader, which mechanically activates the next link or handles feedback.

### Configuration Layering

`src/config.ts` merges two config files:
- **Global**: `~/.claude-orchestrator/config.json` (ZK hosts, cache_dir, commands)
- **Project**: `.claude-orchestrator/config.json` (instance_id, name, role, commands overrides)

Project overrides global for commands. ZK hosts can also come from CLI `-z` flag or `ZK_HOSTS` env var.

### ZK Client (`src/zk/`)

| File | Role |
|------|------|
| `client.ts` | Promisified ZK wrapper with auto-reconnect (exponential backoff, 10 attempts, 2s spin delay) |
| `paths.ts` | ZK path constants and `ALL_ENSURE_PATHS` for `mkdirp` on connect |
| `watcher.ts` | Thin `ZkWatcher` wrapper around ZK watch callbacks |

Key behaviors:
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

Context store (`/context`) is not implemented — no paths exist in `paths.ts`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point (commander, 13 commands) |
| `src/config.ts` | Config loading, layering, instance ID persistence |
| `src/orchestrator/run.ts` | Unified 5-phase startup orchestrator |
| `src/leader/index.ts` | Leader startup orchestration — wires all subsystems |
| `src/leader/event-bus.ts` | Typed EventEmitter with 17 `LeaderEventType` values |
| `src/leader/state.ts` | `LeaderState.apply()` — reduces events into display state |
| `src/leader/tui.ts` | ANSI escape-code TUI rendering with keyboard input (team, tasks, event log, input) |
| `src/leader/watcher.ts` | Leader message watch → ChainRouter mechanical routing |
| `src/leader/chain-router.ts` | Mechanical router: decompose (self or forward), parse task defs, execute EvalDecisions |
| `src/leader/recovery.ts` | Orphan task recovery on Worker disconnect (max 3 retries) |
| `src/leader/monitor.ts` | `WorkerMonitor` — watches instances, emits worker_joined/worker_left |
| `src/leader/orchestrator.ts` | `TaskOrchestrator` — watches pending/claimed tasks, emits task lifecycle events |
| `src/leader/stream-tailer.ts` | `StreamTailer` — polls worker log files for live output display |
| `src/leader/merge-validator.ts` | `MergeValidator` — validates and merges Worker git branches |
| `src/worker/worktree-initializer.ts` | Name generation, git worktree creation, role assignment |
| `src/worker/child.ts` | Child process entry point (forked by orchestrator) |
| `src/worker/child-runner.ts` | Worker child initialization: chdir, ZK connect, watch loop |
| `src/worker/watcher.ts` | Worker ZK watch loop → orchestration, template rendering, completion reporting |
| `src/worker/evaluator.ts` | Built-in self-evaluation after task completion (max 3 retries) |
| `src/worker/commit-checker.ts` | Auto-commits changes after chain-link task completion |
| `src/hooks/engine.ts` | `HookEngine` — pre/post lifecycle hooks with CO_* env vars |
| `src/executor/template.ts` | `TemplateEngine` — loading, identity card, variable rendering |
| `src/executor/runner.ts` | `ClaudeRunner` — CLI execution wrapper (execWithTee, execWithStreaming) |
| `src/zk/client.ts` | ZooKeeper client — all ZK operations + watch methods |
| `src/zk/paths.ts` | ZK path constants and helper functions |
| `src/zk/watcher.ts` | `ZkWatcher` — thin ZK watch callback wrapper |
| `src/modules/registry.ts` | Instance register/unregister/heartbeat (ephemeral nodes) |
| `src/modules/task-queue.ts` | Task lifecycle: push/claim/complete/block/fail/retry/list + role-link sorting |
| `src/modules/message-router.ts` | Message send/poll/wait/dismiss |
| `src/models/schemas.ts` | Zod schemas for Instance, Task, Message + ChainDef, EvalDecision + factory functions |
| `src/utils/exec.ts` | `execWithTee` (streaming), `execWithStreaming` (line-by-line), `execAndCapture` (buffered) |
| `src/utils/logger.ts` | Tagged logger with `--debug` mode for tracing prompts and execution |
| `src/utils/output.ts` | JSON output helper for CLI commands |
| `src/utils/console-capture.ts` | Console redirect to file (for TUI display) |
| `templates/` | Agent prompt templates (7 worker templates) + claude-memory templates (6 role configs) |
| `skills/` | Claude Code skills for responsibility chain (6) + CLI reference + developer reference |

## Testing

Tests use **Vitest**. No ZK mock library — tests spin up a real ZooKeeper (docker-compose). Integration tests (`tests/integration/leader-worker.test.ts`) test the full Leader+Worker flow. Unit tests (`tests/unit/`) focus on individual modules.

```bash
npm test                    # vitest run (all tests)
npx vitest run tests/unit/leader.test.ts   # single file
```
