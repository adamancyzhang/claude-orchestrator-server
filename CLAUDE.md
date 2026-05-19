# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A CLI-native multi-agent orchestration system backed by ZooKeeper. Leader runs an interactive TUI (input line for user requirements, Tab/Shift+Tab/1–9 to switch the focused Worker's message panel); Workers connect directly to ZK and auto-process messages via `claude -p`. No MCP server, no HTTP — everything is CLI + ZK watches.

## Development Commands

```bash
# Start ZooKeeper
docker-compose up -d

# Install dependencies (pnpm workspaces)
pnpm install

# Build all packages (`tsc -b` in each workspace)
pnpm build

# Typecheck without emitting
pnpm typecheck

# Workspace cross-package dependency check
pnpm depcheck
pnpm pkgcheck

# Start full orchestration (Leader TUI + 6 Workers; --worker default is 6, minimum is 6)
# Requires a clean git workspace (orchestrator throws if `git status --porcelain` is non-empty).
./bin/claude-orchestrator run --worker 6

# Start with debug trace
./bin/claude-orchestrator run --worker 6 --debug

# Magic mode: the 6th worker becomes `explorer` and chains may spawn sub-chains
./bin/claude-orchestrator run --worker 6 --magic
./bin/claude-orchestrator run --worker 6 --magic --magic-max-chains 5

# Run all tests (sequential across workspaces)
pnpm test

# Run tests in watch mode (single package)
pnpm --filter @co/orchestrator test:watch

# Run a single test file (inside a package directory)
npx vitest run tests/core/integration/workflow-acceptance.test.ts
```

## Architecture

### No MCP Server — CLI-Native

v0.3.x removed the centralized MCP server. Leader and Workers each connect directly to ZooKeeper. Message delivery happens via ZK watches triggering `claude -p` on the recipient. This is a fundamental difference from v0.2.x — there are no MCP tools, resources, prompts, SSE, or Express.

### Package Layout (pnpm monorepo)

v0.7 moved every file out of a flat `src/` tree into per-responsibility packages under `packages/`:

| Package | Responsibility |
|---------|----------------|
| `@co/cli` (`packages/cli/`) | CLI entry (`commander`), argument parsing, command dispatch |
| `@co/orchestrator` (`packages/orchestrator/`) | Unified `run` orchestrator, child supervisor, worktree initializer, init checker, CO root initializer |
| `@co/leader` (`packages/leader/`) | Leader state machine, event bus, TUI, ChainRouter, monitor, recovery, merge validator, memory bootstrap, chain audit |
| `@co/worker` (`packages/worker/`) | Worker child runner, ZK watch loop, self-evaluator, commit checker, docs committer |
| `@co/coordination` (`packages/coordination/`) | InstanceRegistry, TaskQueue, MessageRouter (ZK-backed primitives) |
| `@co/runtime` (`packages/runtime/`) | TemplateEngine, ClaudeRunner, HookEngine (shared by Leader/Worker) |
| `@co/contracts` (`packages/contracts/`) | Zod schemas, branded IDs, ZK/cache path helpers, `PROTOCOL_VERSION`, error classes |
| `@co/infra` (`packages/infra/`) | Config loader (5-layer merge), Logger, ZK client, exec/console utilities |

### Leader Node (`packages/leader/src/`)

The Leader is a TUI with an event-driven architecture and keyboard input:

```
ZK watches (instances, tasks, messages)
  → LeaderEventBus (typed EventEmitter, 17 event types)
    → LeaderState (centralized state, .apply() reduces each event)
      → TuiController + renderer (ANSI escape-code rendering, re-renders on every event)
```

**Subsystems wired by `packages/leader/src/index.ts` (and `packages/orchestrator/src/run.ts`):**

| Subsystem | Role |
|-----------|------|
| `WorkerMonitor` | Watches `/instances` children → emits `worker_joined` / `worker_left` |
| `TaskOrchestrator` | Watches `/tasks/pending` and `/tasks/claimed` → emits `task_created` / `task_claimed` / `task_completed` |
| `TaskRecovery` | On `worker_left`, scans claimed tasks for that worker → re-queues (max 3 retries) or archives as failed |
| `LeaderWatcher` | Watches own message dir → routes to `ChainRouter` for mechanical dispatching |
| `ChainRouter` | Mechanical router — self-processes decompose via claude-cli when template available, otherwise forwards to Planner Worker. Parses task definitions, executes Worker self-evaluation decisions |

Task decomposition may be self-processed by Leader when the decompose template is loaded, or forwarded to a Planner Worker. Decision evaluation is a Worker capability. The Leader handles message forwarding, task creation from structured definitions, and mechanical execution of EvalDecision JSON from Workers.

The TUI has a keyboard input line — typed text is sent as a message to the Leader's own ZK message queue, which the `LeaderWatcher` picks up and routes to `ChainRouter` for forwarding to a Planner Worker.

### Worker Node (`packages/worker/src/`)

Workers run as child processes (forked by the orchestrator) in isolated git worktrees:

| File | Role |
|------|------|
| `child.ts` | Child process entry point (forked by `@co/orchestrator` supervisor) |
| `child-runner.ts` | Full worker child initialization: chdir to worktree, connect ZK, start watch loop |
| `watcher.ts` | ZK watch loop + orchestration. Wires template rendering, Claude execution, self-evaluation, and completion reporting |
| `evaluator.ts` | Built-in self-evaluation after task completion. Loads `worker-evaluate.md` (+ `worker-evaluate-format-hint.md` fallback), runs Claude, returns EvalDecision JSON |
| `commit-checker.ts` | Auto-commits worktree changes after task completion (for chain-link tasks) |
| `docs-committer.ts` | Commits `<co_root>/docs/{worker_name}/` writes back to the CO root repo after each task (independent from worktree commit) |

> Worktree creation, name/role assignment, and asset seeding live in **`packages/orchestrator/src/worktree-initializer.ts`**, not in the worker package.

### Runtime (`packages/runtime/src/`)

Standalone execution primitives reused by Leader and Worker:

| File | Role |
|------|------|
| `template.ts` | `TemplateEngine` — loads templates from `primary_dir` first (a Worker's `<worktree>/.claude-orchestrator/agents/`), falls back to `fallback_dir` (project root `templates/agents/`); renders with identity card + variable substitution |
| `runner.ts` | `ClaudeRunner` — `claude -p` execution wrapper; manages log/output/result paths via `cachePaths` |
| `hook-engine.ts` | Fires shell scripts for lifecycle events (`worker_message_start`, `worker_message_end`, etc.). Environment variables (`CO_EVENT`, `CO_WORKER_NAME`, `CO_TASK_ID`, …) are set on the spawned process. |

### Orchestrator (`packages/orchestrator/src/`)

`run.ts` provides a **5-phase unified startup**:

| Phase | What happens |
|-------|--------------|
| **1. Env & init** | `ensureCleanWorkspace` throws on dirty `git status --porcelain`; `InitChecker.runAll` walks 4 steps (global config, user `~/.claude/CLAUDE.md`, team `CLAUDE.md`, skills); `loadConfig` 5-layer merge; `commitInitFiles` auto-commits init artifacts when `git.auto_commit_init_files` is true. |
| **2. Worktrees + leader ZK** | `initializeWorktrees` creates 6+ git worktrees under `<project>/.claude-orchestrator/worktree/{name}/` and seeds agents + skills + team `CLAUDE.md`; `ensure_paths` mkdir's the 7 ZK base paths; `/claude-orchestrator/leader` EPHEMERAL node written with `{ protocol_version, leader_id, pid, host, started_at, magic_mode, magic_max_chains }`. |
| **3. Leader subsystems** | `InstanceRegistry` self-register; `ensureCoRoot` initializes `~/.claude-orchestrator/projects/{leader_id}/` as an independent git repo; `captureConsoleToFile` so the TUI owns the terminal; LeaderEventBus + LeaderState + ChainRouter + MergeValidator + MemoryBootstrap + ChainAudit; `bus.emit({ type: "magic_mode_configured", … })`; `LeaderWatcher.start()` + `WorkerMonitor.start()` + `TaskOrchestrator.start()` + `TaskRecovery.start() + scanOrphans()`; `TuiController.start()`. |
| **4. Fork workers** | `ChildSupervisor.start(worktreeConfigs)` forks N children. Each child: `chdir(worktree_path)` → ZK connect → `InstanceRegistry.register` (ephemeral `/instances/{worker_id}`) → load templates → `WorkerWatcher.waitForMessage` loop. Worker registration emits `worker_joined` → `LeaderState._workers` fills to N. |
| **5. Wait** | SIGINT/SIGTERM cleanup handler; supervisor shutdown → leader stop → ZK close. |

Other `packages/orchestrator/src/` modules:

| File | Role |
|------|------|
| `child-supervisor.ts` | Forks N workers; restarts up to 3 times on non-zero exit |
| `child-boot.ts` | Worker child bootstrap (template engine, evaluator, commit-checker, docs-committer, hook-engine) |
| `worktree-initializer.ts` | `BUILTIN_NAMES` pool, role assignment, git worktree creation, `seedWorktreeAssets` |
| `init-checker.ts` | 4-step init: global config, user CLAUDE.md, team CLAUDE.md, skills |
| `co-root-initializer.ts` | Creates `~/.claude-orchestrator/projects/{leader_id}/` as an independent git repo |

### Worker Message Processing Flow

A persistent ZK watch loop on the Worker's own message directory. On new message:
1. `TemplateEngine` selects and renders the template by `msg.link` (reads from `<worktree>/.claude-orchestrator/agents/` first, falls back to project `templates/agents/`)
2. `HookEngine` fires `worker_message_start` hook
3. `ClaudeRunner` executes `$COMMAND -p "$prompt" | tee <cache>/{key}.log`
4. `HookEngine` fires `worker_message_end` hook
5. For chain-link tasks, `CommitChecker` auto-commits worktree changes; `DocsCommitter` commits `<co_root>/docs/{worker_name}/` writes back to the CO root repo
6. For chain-link tasks, `SelfEvaluator` runs built-in evaluation via `worker-evaluate.md` (with `worker-evaluate-format-hint.md` fallback, max 3 retries)
7. Completion report (with `EvalDecision` JSON or `ChainDef` JSON) is sent back to Leader

### Coordination Modules (`packages/coordination/src/`)

| Module | Responsibility |
|--------|---------------|
| `instance-registry.ts` | Instance register/unregister/heartbeat (ephemeral nodes) |
| `task-queue.ts` | push/claim/complete/block/fail/retry + role-link priority sorting |
| `message-router.ts` | send (name-based or broadcast), poll, waitForMessage, template rendering |

### Roles

The orchestrator manages 5 roles in standard mode, 6 in magic mode:

| # | Role | Chain link | Notes |
|---|------|-----------|-------|
| 1 | `planner` | `plan` | Decomposes user input into a `ChainDef` |
| 2 | `executor` | `execute` | Carries out the planned changes |
| 3 | `verifier` | `verify` | Runs tests, type checks, lint |
| 4 | `reviewer` | `review` | Reads diff, flags issues |
| 5 | `accepter` | `accept` | Final acceptance + merge readiness check |
| 6 | `explorer` | `explore` | Only present with `--magic`; may spawn sub-chains |

`packages/orchestrator/src/worktree-initializer.ts` assigns roles by `ROLE_PRIORITY` (standard) or `MAGIC_ROLE_PRIORITY` (magic). For `--worker 6`:
- **Standard**: `planner, executor, verifier, reviewer, accepter, executor` (the 6th defaults to a second `executor`).
- **Magic**: `planner, executor, verifier, reviewer, accepter, explorer`.

Worker 7+ always defaults to `executor` (only one `explorer` per cluster — FR-32).

### Role-Link Task Claiming

When claiming tasks, `TaskQueue.claim()` sorts pending tasks with a composite key:
1. Tasks explicitly assigned to this instance (first)
2. Tasks whose `link` matches the instance's role (`planner`→`plan`, `executor`→`execute`, `verifier`→`verify`, `reviewer`→`review`, `accepter`→`accept`, `explorer`→`explore`)
3. Priority (HIGH=0 first)
4. Task ID (FIFO)

This ensures planners claim `plan` tasks, executors claim `execute` tasks, etc., but any worker can claim any task as a fallback.

### Responsibility Chain

```
plan → execute → verify → review → accept
```

Each link is a Claude Code skill under `skills/` and a Worker template under `templates/agents/`. Tasks in a chain share a `chain_id`. Each Worker self-evaluates its own output after completing a task, then sends an `EvalDecision` JSON to the Leader, which mechanically activates the next link or handles feedback.

With `--magic`, the chain gains a 6th link (`explore`) and the explorer worker may emit `spawn_chain` decisions to fork new sub-chains. See [docs/v0.7/dd/10-magic-loop.md](docs/v0.7/dd/10-magic-loop.md).

### Configuration Layering

`packages/infra/src/config/config-loader.ts` merges five layers (later layers override earlier):

1. **Defaults** (hard-coded): `zk.hosts=127.0.0.1:2181`, `claude_cli=claude --dangerously-skip-permissions --permission-mode dontAsk`, `git.remote=origin`, `git.auto_commit_init_files=true`, `projects_root=~/.claude-orchestrator/projects`
2. **Global**: `~/.claude-orchestrator/config.json`
3. **Project**: `<project_root>/.claude-orchestrator/config.json`
4. **Environment variables**: `ZK_HOSTS`, `CO_MAGIC_MAX_CHAINS`, `CO_CHAIN_MAX_RETRIES`
5. **CLI args**: `-z/--zookeeper`, `--magic`, `--magic-max-chains`, `--debug`

Notable git options (defaults under `git.*`):
- `auto_commit_init_files=true` — Phase 1 auto-commits orchestrator init artifacts (`chore: init orchestrator workspace files`)
- `auto_commit_init_files_branch=null` — optional dedicated branch for init commits
- `remote=origin`
- `merge_target_branch=null` — falls back to `git rev-parse --abbrev-ref HEAD` at merge time

### ZK Client (`packages/infra/src/zk/`)

| File | Role |
|------|------|
| `client.ts` | Promisified ZK wrapper with auto-reconnect (exponential backoff, 10 attempts, 2s spin delay), `mkdirp`-on-connect, atomic `createEphemeral`, watch helpers |

ZK path constants live in **`packages/contracts/src/paths/zkPaths.ts`** (not the infra package): `leader()`, `instance(id)`, `tasksPending()`, `tasksClaimed()`, `tasksCompleted()`, `messageDir(insId)`, plus `allEnsurePaths()` for `mkdirp` on connect.

Key behaviors:
- `mkdirp` on connect ensures the 7 base paths exist (project root, instances, tasks/{pending,claimed,completed}, messages)
- Watch methods return current children AND set a ZK watch for future changes
- `claimTask` relies on ZK's atomic `create(path, EPHEMERAL)` — only one caller succeeds

### ZK Node Tree

```
/claude-orchestrator
├── leader                     [EPHEMERAL]   # see fields below
├── instances/{id}             [EPHEMERAL]   # Instance schema (see packages/contracts/src/schemas/instance.ts)
├── tasks/
│   ├── pending/task-NNNNN     [PERSISTENT_SEQUENTIAL]
│   ├── claimed/{insId}-task-NNNNN [EPHEMERAL] ← atomic claim lock
│   └── completed/task-NNNNN   [PERSISTENT]
└── messages/{instanceId}/msg-NNNNN [PERSISTENT_SEQUENTIAL]
```

`/leader` EPHEMERAL payload (`packages/orchestrator/src/run.ts:153-169`):

```json
{
  "protocol_version": "0.7.0",
  "leader_id": "<32-char hex>",
  "pid": <int>,
  "host": "<os.hostname()>",
  "started_at": "<ISO-8601>",
  "magic_mode": false,
  "magic_max_chains": null
}
```

Workers read `/leader` on connect to validate `protocol_version` and pick up `magic_mode` / `magic_max_chains` so they can recognize `spawn_chain` decisions.

Context store (`/context`) is not implemented — no paths exist in `zkPaths.ts`.

### Magic Mode

`--magic` enables the autonomous loop:

- The 6th worker is assigned the `explorer` role (`MAGIC_ROLE_PRIORITY`); chains gain an `explore` link.
- Workers may emit `spawn_chain` decisions that fork new sub-chains, building a `chain_forest` rooted at the original chain.
- `--magic-max-chains <m>` (or env `CO_MAGIC_MAX_CHAINS`) caps the total chain count in the forest. Unset → unlimited.
- Leader emits `magic_mode_configured` so the TUI shows a `[MAGIC]` badge on first frame.

See [`docs/v0.7/dd/10-magic-loop.md`](docs/v0.7/dd/10-magic-loop.md) for end-to-end timing, termination matrix, and v0.6 incompatibilities.

## Key Files

| File | Purpose |
|------|---------|
| `packages/cli/src/index.ts` | CLI entry point (commander). Parses `--worker` (default 6, min 6), `--magic`, `--magic-max-chains`, `-z/--zookeeper`, `-d/--debug`, `-y/--yes`. |
| `packages/infra/src/config/config-loader.ts` | 5-layer config merge (defaults → global → project → env → CLI) |
| `packages/orchestrator/src/run.ts` | Unified 5-phase startup orchestrator |
| `packages/orchestrator/src/child-supervisor.ts` | Forks N worker child processes, restarts on non-zero exit (max 3) |
| `packages/orchestrator/src/child-boot.ts` | Worker child bootstrap (chdir, ZK connect, registry, template engine, evaluator, committers) |
| `packages/orchestrator/src/worktree-initializer.ts` | `BUILTIN_NAMES`, `ROLE_PRIORITY` / `MAGIC_ROLE_PRIORITY`, git worktree creation, `seedWorktreeAssets` |
| `packages/orchestrator/src/init-checker.ts` | 4-step init: global config, user CLAUDE.md, team CLAUDE.md, skills |
| `packages/orchestrator/src/co-root-initializer.ts` | Creates `~/.claude-orchestrator/projects/{leader_id}/` as an independent git repo |
| `packages/leader/src/index.ts` | Re-exports for the Leader package (state, bus, controller, routers) |
| `packages/leader/src/event-bus.ts` | Typed `EventEmitter` with 17 `LeaderEventType` values |
| `packages/leader/src/state.ts` | `LeaderState.apply()` — reduces events into display state; `LINK_TO_ROLE` map |
| `packages/leader/src/tui/controller.ts` | TUI controller — keyboard input + render loop |
| `packages/leader/src/tui/renderer.ts` | ANSI escape-code rendering (TEAM, PENDING, IN_PROGRESS, EVENT LOG, INPUT panels) |
| `packages/leader/src/tui/input.ts` | `StdinKeyboardSource` |
| `packages/leader/src/watcher.ts` | Leader message watch → `ChainRouter` mechanical routing |
| `packages/leader/src/chain-router.ts` | Mechanical router: decompose (self or forward), parse task defs, execute EvalDecisions, spawn_chain |
| `packages/leader/src/recovery.ts` | Orphan task recovery on Worker disconnect (max 3 retries) |
| `packages/leader/src/monitor.ts` | `WorkerMonitor` — watches instances, emits `worker_joined`/`worker_left` |
| `packages/leader/src/task-orchestrator.ts` | `TaskOrchestrator` — watches pending/claimed tasks, emits task lifecycle events |
| `packages/leader/src/stream-tailer.ts` | Polls worker log files for live output display |
| `packages/leader/src/merge-validator.ts` | Validates and merges Worker git branches; renders `worker-merge-decision.md` |
| `packages/leader/src/memory-bootstrap.ts` | `/init` full bootstrap + `memory_refresh` incremental refresh |
| `packages/leader/src/chain-audit.ts` | manifest log (`audit.jsonl`), `recordLinkCommit`, `collectUpstreamCommits`, `clearLinkCommitsFrom` |
| `packages/worker/src/child.ts` | Worker child process entry |
| `packages/worker/src/child-runner.ts` | Worker child initialization: chdir, ZK connect, watch loop |
| `packages/worker/src/watcher.ts` | Worker ZK watch loop → orchestration, template rendering, completion reporting |
| `packages/worker/src/evaluator.ts` | Built-in self-evaluation after task completion (max 3 retries with format-hint fallback) |
| `packages/worker/src/commit-checker.ts` | Auto-commits worktree changes after chain-link task completion |
| `packages/worker/src/docs-committer.ts` | Commits `<co_root>/docs/{worker_name}/` writes after each task |
| `packages/runtime/src/template.ts` | `TemplateEngine` — primary_dir + fallback_dir loading, identity card, variable rendering |
| `packages/runtime/src/runner.ts` | `ClaudeRunner` — CLI execution wrapper |
| `packages/runtime/src/hook-engine.ts` | Pre/post lifecycle hooks with `CO_*` env vars |
| `packages/infra/src/zk/client.ts` | ZooKeeper client — all ZK operations + watch methods |
| `packages/contracts/src/paths/zkPaths.ts` | ZK path constants and `allEnsurePaths()` |
| `packages/contracts/src/paths/cachePaths.ts` | Cache path helpers under CO root (`taskDir`, `merges`, …) |
| `packages/coordination/src/instance-registry.ts` | Instance register/unregister/heartbeat (ephemeral nodes) |
| `packages/coordination/src/task-queue.ts` | Task lifecycle: push/claim/complete/block/fail/retry/list + role-link sorting |
| `packages/coordination/src/message-router.ts` | Message send/poll/wait/dismiss |
| `packages/contracts/src/schemas/{instance,task,message,chain,eval,merge}.ts` | Zod schemas for Instance, Task, Message + ChainDef, EvalDecision, MergeDecision |
| `packages/infra/src/utils/exec.ts` | `execWithTee` (streaming), `execWithStreaming` (line-by-line), `execAndCapture` (buffered) |
| `packages/infra/src/logger.ts` | Tagged logger with `--debug` mode for tracing prompts and execution |
| `packages/infra/src/utils/output.ts` | JSON output helper for CLI commands |
| `packages/infra/src/utils/console-capture.ts` | Console redirect to file (for TUI display) |
| `templates/agents/` | 20 agent prompt templates: 6 role system prompts `worker-{role}.md` (planner/executor/verifier/reviewer/accepter/explorer) + 6 per-task user-message wrappers `worker-{role}-task.md` + `worker-identity.md` + `worker-decompose.md` + `worker-evaluate.md` + `worker-evaluate-format-hint.md` + `worker-commit-message.md` + `worker-merge-decision.md` + `worker-memorize-dir.md` + `worker-memorize-file.md` |
| `templates/claude-memory/` | 7 memory templates: 1 `team-claude.md` (seeded to `<worktree>/CLAUDE.md`) + 6 `personal-claude-{role}.md` (currently not seeded — see [docs/evals/01-startup-worker-6.md](docs/evals/01-startup-worker-6.md) §6 D14) |
| `skills/` | 10 Claude Code skills: 6 chain skills (`task-planning`, `task-execution`, `task-verification`, `task-review`, `task-acceptance`, `task-exploration`) + `task-traceability` + `test-driven-development` + `claude-orchestrator` (CLI ref) + `claude-code-developer` (dev ref) |

## Testing

Tests use **Vitest** and live under `packages/*/tests/`. Each workspace package has its own `vitest.config.ts`, its `test` / `test:watch` scripts, and its own `tests/CLAUDE.md` that mirrors the canonical [Testing Standards](tests/CLAUDE.md).

**All test files have been removed in v0.7 — unit, integration, e2e, and manual.** The test infrastructure (vitest configs, scripts, `tests/` directories) is intentionally preserved as a baseline for reintroducing tests. Running `pnpm test` today reports "no test files found" per package; that is expected.

New tests MUST follow the directory layout in [`tests/CLAUDE.md`](tests/CLAUDE.md):
- `tests/core/integration/` — multi-module flows over real ZooKeeper.
- `tests/core/e2e/` — full leader+worker runs.
- `tests/core/manual/` — `claude-cli` + ZK smoke scripts.
- `tests/scratch/YYYY-MM-DD/<feature>/` — ephemeral iteration tests (3-day retention).
- Do **not** create `tests/core/unit/` — unit tests were retired in v0.7.

ZooKeeper must be running (`docker-compose up -d`) before invoking integration/e2e tests.

```bash
# Full suite (all packages, sequential) — currently reports "no tests"
pnpm test

# Single package
pnpm --filter @co/orchestrator test

# Single file inside a package directory
npx vitest run tests/core/integration/<file>.test.ts
```
