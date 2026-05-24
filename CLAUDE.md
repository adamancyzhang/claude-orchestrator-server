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
pnpm --filter @co/runtime test -- -t "Tom"  # Run a single test by name pattern
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
- **Config loading**: 5-layer merge — CLI flags → env vars → worktree-local config → project config → global `~/.claude-orchestrator/config.json`.
- **Magic mode**: `--magic` flag enables the Explorer role and `spawn_chain` EvalDecision variant. The 6th worker becomes an explorer that autonomously discovers work and spawns sub-chains.

## Template System

Templates live under `templates/` and are loaded by `TemplateEngine` (`@co/runtime`) with a two-tier lookup: `primary_dir` (worktree `.claude-orchestrator/agents/`, seeded at init) shadows `fallback_dir` (the built-in `templates/` directory). Template names use subdirectory prefixes to disambiguate sources.

### Directory structure

| Directory | Content | Template name prefix |
|-----------|---------|---------------------|
| `templates/agents/` | `worker-identity.md` (identity card) + 6 per-role dirs (`planner/`, `executor/`, …) each with `responsibilities.md` + `task.md` | `agents/` |
| `templates/workflow/` | Utility templates: `decompose.md`, `evaluate.md`, `evaluate-format-hint.md`, `commit-message.md`, `memorize-file.md`, `memorize-dir.md`, `merge-decision.md` | `workflow/` |
| `templates/` (top-level) | `project-claude.md` (team-level CLAUDE.md seed), `user-global-claude.md` | no prefix (flat) |

### Identity card (`agents/worker-identity.md`)

Rendered via `ClaudeRunner.buildIdentityPrompt()` which replaces these placeholders:

| Placeholder | Source |
|-------------|--------|
| `{{name}}`, `{{role}}` | `ChildConfig` / `WorktreeConfig` |
| `{{originBranch}}` | `GitConfig.merge_target_branch` (null if unset) |
| `{{worktreePath}}`, `{{worktreeBranch}}` | Worker's worktree on disk |
| `{{co_root}}` | `{projects_root}/{leader_instance_id}` |
| `{{co_role_path}}` | `{co_root}/docs/{name}` (worker's personal docs dir) |

### System prompt assembly

Happens once at worker boot (`child-boot.ts`, `in-process-supervisor.ts`). Two layers joined by `\n\n---\n\n`:

1. `agents/worker-identity.md` — identity card
2. `agents/{role}/responsibilities.md` — merged standing responsibilities, process steps, output contract, prohibited rules, session memory

The old `personal-claude-{role}.md` files (formerly in `templates/claude-memory/`) no longer exist — their content was merged into `responsibilities.md`.

### Task prompt

Each role has a per-task template (`agents/{role}/task.md`) rendered by the WorkerWatcher with upstream artifacts, commit hashes, output paths, and retry context. These carry only the task body; the system prompt (identity + responsibilities) is sent separately via `--append-system-prompt`.

### CLAUDE.md memory system

Workers read/write three layers of CLAUDE.md:
- **Team**: project root `CLAUDE.md` (seeded from `templates/project-claude.md`)
- **Personal**: `{{co_role_path}}/CLAUDE.md`
- **Daily**: `{{co_role_path}}/YYYY-MM-DD/CLAUDE.md`

The `co_role_path` directory lives under the CO root (`{projects_root}/{leader_instance_id}/docs/{name}/`), an independent git repo shared by all workers; never in the project directory.

### Template name reference map

Key code locations that map role/link names to template paths:

| Mapping | Package / File | Template names |
|---------|---------------|----------------|
| `ROLE_TO_SYSTEM_TEMPLATE` | `orchestrator/src/child-boot.ts`, `orchestrator/src/in-process-supervisor.ts` | `"agents/{role}/responsibilities.md"` |
| `LINK_TO_TASK_TEMPLATE` | `worker/src/watcher.ts` | `"agents/{role}/task.md"` |
| decompose | `leader/src/chain-router.ts`, `worker/src/watcher.ts` | `"workflow/decompose.md"` |
| merge-decision | `orchestrator/src/run.ts` | `"workflow/merge-decision.md"` |
| memorize | `leader/src/memory-bootstrap.ts` | `"workflow/memorize-file.md"`, `"workflow/memorize-dir.md"` |
| evaluate | `worker/src/evaluator.ts` (SelfEvaluator) | `"workflow/evaluate.md"`, `"workflow/evaluate-format-hint.md"` (retry hint on attempt >= 2) |
| commit-message | `worker/src/commit-checker.ts`, `worker/src/docs-committer.ts` | `"workflow/commit-message.md"` |

## Roles & Responsibility Chain

Roles: `planner`, `executor`, `verifier`, `reviewer`, `accepter`, `explorer` (magic mode), `leader` (TUI only, never claims tasks).

Chain: `Plan -> Execute -> Verify -> Review -> Accept` (+ `Explore` in magic mode).

EvalDecision variants: `activate_next`, `feedback`, `reject`, `close_chain`, `spawn_chain`.

`ROLE_WEIGHTS` matrix in `@co/contracts` defines task-claim sorting: own link = 100, cross-role fallback = 10-20, leader = 0 across the board.

## Runtime Dependencies

- Node.js 18+
- `claude` CLI (for actual Worker message processing — templates invoke `claude -p` and `claude --resume`/`--fork-session`)
- ZooKeeper 3.8+ only if using `--enabled-zookeeper` (in-memory client is the default)
