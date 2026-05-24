# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
pnpm install                     # Install dependencies (requires pnpm 10+)
pnpm -r build                    # tsc -b across all 8 packages (project references)
pnpm typecheck                   # tsc --noEmit across all packages
pnpm depcheck                    # dependency-cruiser layer-isolation validation
pnpm pkgcheck                    # per-package dependency whitelist enforcement
pnpm test                        # vitest run (all packages, --workspace-concurrency=1)
pnpm --filter @co/contracts test # Single package
pnpm --filter @co/leader test:watch # Watch mode for one package
```

Start the orchestrator: `node bin/claude-orchestrator run --worker 6` (requires `pnpm -r build` first). The in-memory message protocol is the default — no external services needed.

## Architecture: 8-Package Layered Monorepo

Strict one-directional layering enforced by `dependency-cruiser` (.dependency-cruiser.cjs):

| Layer | Package | Responsibility | Allowed deps |
|-------|---------|---------------|--------------|
| 0 | `@co/contracts` | Branded IDs (`InstanceId`, `TaskId`, etc.), Zod schemas, interfaces, `ROLE_WEIGHTS`, `PROTOCOL_VERSION`, error codes | `zod` |
| 1 | `@co/infra` | `InMemoryZkClient`, `ZkClient` (real ZK), `Logger`, `ConfigLoader` (5-layer merge), exec utils | contracts, `node-zookeeper-client` |
| 2 | `@co/runtime` | `ClaudeRunner` (`--resume`/`--fork-session`), `TemplateEngine`, `HookEngine` | contracts, infra |
| 3 | `@co/coordination` | `TaskQueue`, `MessageRouter`, `InstanceRegistry` (abstract away messaging primitives) | contracts, infra |
| 4a | `@co/leader` | EventBus, State, ChainRouter, MergeValidator, Recovery, TaskOrchestrator, TUI (React/Ink v7, 7 panels) | contracts, runtime, coordination |
| 4b | `@co/worker` | WorkerWatcher (8-step pipeline), SelfEvaluator, CommitChecker | contracts, runtime, coordination |
| 5 | `@co/orchestrator` | `runOrchestrator()` 5-phase startup, `InitChecker`, `WorktreeInitializer`, `ChildSupervisor` | contracts, infra, runtime, coordination, leader, worker |
| 6 | `@co/cli` | `commander` entry point: `run` + `config` commands | contracts, infra, coordination, orchestrator |

**Critical rule**: Leader (4a) and Worker (4b) are same layer — they must not import each other. They communicate only through `@co/coordination` interfaces.

## Key Patterns

- **Branded IDs**: All IDs are branded types (`InstanceId`, `TaskId`, `MessageId`, `ChainId`, `SessionId`, `WorktreeName`, `ProjectId`, `ZkPath`). Use `asInstanceId()`, `asTaskId()` etc. to create them.
- **Error handling**: `CoError` hierarchy with stable string `code` properties (`ZK_SESSION_EXPIRED`, `ORPHAN_RETRY_EXHAUSTED`, etc.) — never throw generic `Error` for domain failures.
- **DI through factories**: `runOrchestrator()` accepts optional `OrchestratorDeps` (zk_factory, supervisor_factory, claude_runner_factory) for test injection.
- **In-memory messaging default**: `InMemoryZkClient` is the default (no real ZooKeeper needed for dev). Pass `--enabled-zookeeper` to use real ZK.
- **TUI split**: React/Ink v7 with 7 panels (`event-log`, `footer`, `in-progress`, `input-line`, `pending`, `team`, `worker-messages`) — keep rendering side-effect-free.
- **Config loading**: 5-layer merge — CLI flags -> env vars -> worktree-local config -> project config -> global `~/.claude-orchestrator/config.json`.
- **CLAUDE.md memory system**: Three layers — Team (worktree `CLAUDE.md`), Personal (`{co_root}/docs/{name}/CLAUDE.md`), Daily (`{co_root}/docs/{name}/YYYY-MM-DD/CLAUDE.md`). Docs live in the CO root (`{projects_root}/{leader_instance_id}/docs/`), an independent git repo shared by all workers; never in the project directory.
- **Magic mode**: `--magic` flag enables the Explorer role and `spawn_chain` EvalDecision variant. The 6th worker becomes an explorer that autonomously discovers work and spawns sub-chains.

## Roles & Responsibility Chain

Roles: `planner`, `executor`, `verifier`, `reviewer`, `accepter`, `explorer` (magic mode), `leader` (TUI only, never claims tasks).

Chain: `Plan -> Execute -> Verify -> Review -> Accept` (+ `Explore` in magic mode).

EvalDecision variants: `activate_next`, `feedback`, `reject`, `close_chain`, `spawn_chain`.

`ROLE_WEIGHTS` matrix in `@co/contracts` defines task-claim sorting: own link = 100, cross-role fallback = 10-20, leader = 0 across the board.

## Runtime Dependencies

- Node.js 18+
- `claude` CLI (for actual Worker message processing — templates invoke `claude -p` and `claude --resume`/`--fork-session`)
- ZooKeeper 3.8+ only if using `--enabled-zookeeper` (in-memory client is the default)
