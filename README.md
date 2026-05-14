# Claude Orchestrator

<p align="center">
  <strong>Turn Claude Code instances into a multi-agent swarm — coordinated through ZooKeeper.</strong>
  <br/>
  <em><a href="README_zh.md">中文文档</a></em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@adamancyzhang/claude-orchestrator"><img src="https://img.shields.io/npm/v/@adamancyzhang/claude-orchestrator?color=blue" alt="npm"></a>
  <a href="https://github.com/adamancyzhang/claude-orchestrator-server"><img src="https://img.shields.io/github/license/adamancyzhang/claude-orchestrator-server" alt="license"></a>
  <img src="https://img.shields.io/badge/node-18%2B-green" alt="node">
  <img src="https://img.shields.io/badge/typescript-5.6%2B-blue" alt="typescript">
  <img src="https://img.shields.io/badge/pnpm-workspaces-orange" alt="pnpm">
  <img src="https://img.shields.io/badge/ZooKeeper-3.8%2B-orange" alt="zookeeper">
  <img src="https://img.shields.io/badge/protocol-v0.5.0-purple" alt="protocol">
</p>

---

## What is this?

**Claude Orchestrator** runs multiple Claude Code instances as an AI team. Each Worker gets an isolated git worktree with humanized names (Tom, Jerry, Lucy...), auto-processes assigned tasks via `claude -p`, self-evaluates output via `--fork-session`, and sends a 4-variant `EvalDecision` back to the Leader. The Leader runs a read-only TUI and mechanically routes tasks through the **Plan → Build → Verify → Review → Accept** responsibility chain.

Under the hood, ZooKeeper handles coordination: ephemeral nodes for heartbeat, sequential nodes for FIFO task ordering, and watches for real-time notification. Zero external database — all state lives in ZooKeeper.

```
┌──────────────────────────────────────────────────────┐
│                     ZooKeeper                         │
│     /leader  /instances  /tasks  /messages            │
└────────┬────────────────┬────────────────┬────────────┘
         │                │                │
    ┌────┴────┐      ┌────┴────┐      ┌────┴────┐
    │ Leader  │      │ Worker  │      │ Worker  │
    │  (TUI)  │      │(worktree)│     │(worktree)│
    │  Tom    │      │  Jerry   │      │  Lucy   │
    │planner  │      │ builder  │      │verifier │
    └─────────┘      └─────────┘      └─────────┘
```

---

## What's new in v0.5

| Area | Change |
|------|--------|
| Engineering layout | Single `src/` → **8 strictly layered pnpm workspace packages** (`@co/contracts` → `@co/cli`) with `dependency-cruiser` enforcement |
| Type system | **Branded IDs** (`InstanceId / TaskId / MessageId / ChainId / SessionId / WorktreeName / ProjectId / ZkPath`) + `PROTOCOL_VERSION = "0.5.0"` handshake |
| EvalDecision | Extended to **4-variant discriminated union**: `activate_next` / `feedback` / `reject` / `close_chain` |
| MergeDecision | **New schema**: `merge` / `skip` / `review_first`, auto-aborts on conflict |
| MessageType | Expanded to 6 values (adds `task_dispatch`, `completion_report`, `user_input`) |
| Session continuity | ClaudeRunner supports `--resume` for main → commit → eval chain; `--fork-session` for evaluator format-retry |
| TUI | Split into `tui/renderer.ts` (pure) + `tui/input.ts` (event source) + `tui/controller.ts` (subscriptions + IO) |
| Worker isolation | `worktree-initializer` migrated from `@co/worker` to `@co/orchestrator`; new `ChildSupervisor` with max-3 restart + `process.kill(ppid, 0)` parent liveness check |
| TaskQueue | New `ITaskQueue.watchPending / watchClaimed / getPending` interfaces — Leader no longer touches `IZkClient` directly |
| Coordination | `ROLE_WEIGHTS` matrix replaces hard-coded role→link map; Leader (`role: leader`) is invisible to ordinary task claiming |
| Errors | `CoError` hierarchy with 11 stable `code` strings (`ZK_SESSION_EXPIRED`, `ORPHAN_RETRY_EXHAUSTED`, …) |
| Multi-project | `zkPaths` accepts optional `project_id` → switches root from `/claude-orchestrator` to `/co/{project_id}` |
| CLI | Reduced to 2 commands — `run` and `config`. Other operations move into the TUI input line |

---

## Quick Start

### 1. Install

```bash
# Recommended: from source (the package is currently a private workspace)
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server
pnpm install
pnpm -r build
```

### 2. Start ZooKeeper

```bash
docker-compose up -d
```

### 3. Launch Everything

```bash
node bin/claude-orchestrator run --worker 5
```

One command. It:
- Runs the 6-step `InitChecker` (Safe / Caution / Danger gates with `init_status` history)
- Creates isolated git worktrees for each Worker (`.claude-orchestrator/worktree/{name}/`)
- Assigns humanized names (Tom, Jerry, Lucy, Thomas, Jack...) and roles (planner, builder, verifier, reviewer, accepter)
- Copies agent templates and skills into each worktree
- Starts the Leader TUI
- Forks Worker child processes through `ChildSupervisor` (each in its own worktree, max 3 restarts on crash, exits when parent dies)

### 4. Use It

Type a requirement in the TUI input line and press Enter. The Leader forwards it to a Planner Worker (or self-processes via the `worker-decompose.md` template if available), which decomposes it into a `ChainDef`. Each Worker processes its link, self-evaluates with `--fork-session`, and the Leader routes the next link based on the `EvalDecision` JSON.

```bash
# Show resolved config (includes protocol_version)
node bin/claude-orchestrator config

# Show version + protocol tag
node bin/claude-orchestrator --version
# → 0.5.0 (protocol 0.5.0)
```

---

## Architecture

### 8-Package Workspace (v0.5)

Strict one-directional layering enforced by `dependency-cruiser`:

| Layer | Package | Responsibility | Allowed deps |
|-------|---------|---------------|--------------|
| 0 | `@co/contracts` | Branded IDs, Zod schemas, interfaces, errors, `ROLE_WEIGHTS`, `zkPaths` / `cachePaths`, `PROTOCOL_VERSION` | `zod` (peer) |
| 1 | `@co/infra` | `IZkClient` impl, `Logger`, exec utils, `ConfigLoader` | contracts, `node-zookeeper-client` |
| 2 | `@co/runtime` | `ClaudeRunner` (with `--resume` / `--fork-session`), `TemplateEngine`, `HookEngine` (closed `HookEvent` union) | contracts, infra |
| 3 | `@co/coordination` | `TaskQueue` (with `watchPending` / `watchClaimed`), `MessageRouter`, `InstanceRegistry` | contracts, infra |
| 4a | `@co/leader` | EventBus, State, ChainRouter, MergeValidator, Recovery, Monitor, TaskOrchestrator, Watcher, StreamTailer, TUI (renderer/input/controller) | contracts, runtime, coordination |
| 4b | `@co/worker` | WorkerWatcher (8-step pipeline), SelfEvaluator, CommitChecker | contracts, runtime, coordination |
| 5 | `@co/orchestrator` | `run.ts` 5-phase startup, `InitChecker`, `WorktreeInitializer`, `ChildSupervisor` | contracts, infra, runtime, coordination, leader, worker |
| 6 | `@co/cli` | `commander` entry, `run` + `config` commands | contracts, infra, coordination, orchestrator |

Leader (4a) and Worker (4b) are at the same layer and **must not import each other**; they talk only through ZK via the `@co/coordination` interfaces.

### Leader-Worker Model

| Component | What it does | ZK magic |
|-----------|-------------|----------|
| **Leader** | Read-only TUI, mechanical message/task routing, merge validation, orphan recovery. Self-processes decompose via claude-cli when the `worker-decompose.md` template is loaded; otherwise forwards to Planner. | `/leader` EPHEMERAL — exactly one Leader, carries `protocol_version` |
| **Worker** | Isolated git worktree, ZK watch loop, auto-processes messages via `claude -p`, self-evaluates output with `--fork-session`, auto-commits changes with `--resume` | `/instances/{id}` EPHEMERAL → auto-cleanup on disconnect |
| **Task Queue** | Push → Claim → Complete (or Block / Fail / Retry). `ROLE_WEIGHTS`-driven claim sorting. | Sequential nodes for FIFO, ephemeral claims for atomic locks. Claim payload embeds a `task_snapshot` for crash recovery. |
| **Message Router** | Point-to-point messaging via ZK watches | Persistent-sequential nodes, push notification |

### Worker 8-step pipeline

```
1. Parse incoming message (link, task_id, chain_id)
2. Select template by link (worker-{plan|build|verify|review|accept}.md)
3. Fire worker_message_start hook
4. Render template + identity prompt (via --append-system-prompt)
5. Execute main task → ClaudeRunner.run() → sessionId
6. CommitChecker.check() with --resume sessionId (auto-commit)
7. SelfEvaluator.evaluate() with --resume + --fork-session (3 retries on parse failure)
8. Send completion_report (EvalDecision JSON + commit info) to Leader
```

### Worktree Isolation

Each Worker runs in its own `git worktree` under `.claude-orchestrator/worktree/{name}/`. This gives every Worker:
- **Independent working directory** — no file conflicts
- **Dedicated git branch** — `claude-orchestrator/{name}-workspace`
- **Personal CLAUDE.md** — role-specific rules at `.claude-orchestrator/docs/{name}/CLAUDE.md`
- **Daily directory memory** — `.claude-orchestrator/docs/{name}/YYYY-MM-DD/CLAUDE.md` preserves session context across restarts

### Responsibility Chain

```
Plan → Build → Verify → Review → Accept
```

Each link is a dedicated role. One Worker produces, the next Worker verifies — forming a **closed-loop responsibility chain**. Every output is written to `.claude-orchestrator/docs/{name}/YYYY-MM-DD/` and the next link reads from there. Built-in self-evaluation after every link decides what happens next via `EvalDecision`:

| `EvalDecision.decision` | Effect |
|-------------------------|--------|
| `activate_next` | Leader creates the next link's task and dispatches it |
| `feedback` | Leader forwards feedback text to a target Worker for rework |
| `reject` | Chain terminates as failed |
| `close_chain` | Chain terminates as successful (final `accept` link) |

---

## CLI Commands (v0.5)

The CLI surface is intentionally minimal — orchestration is driven from the TUI:

| Command | Description |
|---------|-------------|
| `run --worker <n>` | One-shot orchestration: 6-step InitChecker, worktree creation, Leader TUI, fork N Workers |
| `config` | Print resolved configuration (ZK, cache dir, commands, protocol version) |

Common flags:
- `-z, --zookeeper <hosts>` — ZooKeeper connection string (env: `ZK_HOSTS`); defaults to `127.0.0.1:2181`
- `-d, --debug` — enable debug logging
- `-y, --yes` (run only) — skip interactive `InitChecker` prompts based on `init_status` history

---

## Directory Memory (CLAUDE.md)

Claude Orchestrator uses a three-layer **CLAUDE.md** system as directory memory:

| Layer | Location | Content |
|-------|----------|---------|
| **Team** | Worktree root `CLAUDE.md` | Team roles, directory structure, responsibility chain, git rules |
| **Personal** | `.claude-orchestrator/docs/{name}/CLAUDE.md` | Role-specific process, output standards, communication rules, prohibited behaviors |
| **Daily** | `.claude-orchestrator/docs/{name}/YYYY-MM-DD/CLAUDE.md` | Session context, task progress, decisions, blockers |

Layers 1 and 2 are seeded from `templates/claude-memory/` during worktree creation. Layer 3 is created and maintained by Workers themselves during task execution — guided by prompt templates that instruct Claude to manage its own daily memory.

---

## Template Structure

```
templates/
├── agents/                          ← Worker prompt templates
│   ├── worker-identity.md           #   --append-system-prompt identity card
│   ├── worker-decompose.md          #   Requirement → ChainDef decomposition
│   ├── worker-plan.md               #   Planner: blueprint design
│   ├── worker-build.md              #   Builder: traceable implementation
│   ├── worker-verify.md             #   Verifier: cross-check Plan vs Build
│   ├── worker-review.md             #   Reviewer: chain-level quality gate
│   ├── worker-accept.md             #   Accepter: final Go/No-Go decision
│   ├── worker-evaluate.md           #   Self-evaluation → EvalDecision JSON
│   ├── worker-evaluate-format-hint.md  # Appended on eval retry attempts ≥ 2
│   ├── worker-commit-message.md     #   Auto commit-message generation
│   ├── worker-merge-decision.md     #   MergeDecision JSON (Leader-side)
│   └── worker-task-doc.md           #   Per-task markdown doc generation
└── claude-memory/
    ├── team-claude.md               #   Workspace-level CLAUDE.md
    ├── personal-claude-planner.md   #   Planner role rules
    ├── personal-claude-builder.md   #   Builder role rules
    ├── personal-claude-verifier.md  #   Verifier role rules
    ├── personal-claude-reviewer.md  #   Reviewer role rules
    └── personal-claude-accepter.md  #   Accepter role rules
```

Worker templates are lean — they provide task context and key instructions, then guide Workers to read the corresponding skill file (`.claude/skills/{skill}/SKILL.md`) for detailed process. This keeps prompts focused and prevents LLM attention dispersion.

---

## Skills

| Skill | Role | Description |
|-------|------|-------------|
| `task-planning` | Planner | Analyze requirements, define blueprints, break down tasks |
| `task-execution` | Builder | Claim tasks, implement against blueprints, commit with traceability |
| `task-verification` | Verifier | Independently verify Builder output against Plan criteria |
| `task-review` | Reviewer | Review full chain (Plan→Build→Verify) for design consistency |
| `task-acceptance` | Accepter | Validate final deliverable against business criteria, sign Go/No-Go |
| `task-traceability` | Foundation | Trace → Execute → Map → Evidence → Record — all roles |
| `claude-orchestrator` | All | CLI reference |
| `claude-code-developer` | All | Claude Code developer reference |

---

## ZooKeeper Node Tree

```
/claude-orchestrator                      ← or /co/{project_id} when project_id is set
├── leader                                [EPHEMERAL] LeaderNodeData (incl. protocol_version)
├── instances/{id}                        [EPHEMERAL] Instance metadata (incl. protocol_version)
├── tasks/
│   ├── pending/task-NNNNN                [PERSISTENT_SEQUENTIAL]
│   ├── claimed/{insId}-task-NNNNN        [EPHEMERAL] ← atomic lock + ClaimRecord (with task_snapshot)
│   └── completed/task-NNNNN              [PERSISTENT]
└── messages/{instanceId}/msg-NNNNN       [PERSISTENT_SEQUENTIAL]
```

`PROTOCOL_VERSION` (currently `0.5.0`) is written to both `/leader` and every `/instances/{id}` node so cross-version handshakes fail loudly rather than silently corrupting payloads.

---

## Why ZooKeeper?

| Concern | ZooKeeper answer |
|---------|-----------------|
| Instance lifecycle | Ephemeral nodes → auto-cleanup on crash |
| Task ordering | Sequential nodes → guaranteed FIFO |
| Claim atomicity | `create(path, ephemeral=true)` is atomic — only one winner |
| Leader election | `/leader` EPHEMERAL → exactly one Leader |
| Change notification | Built-in watches → push, not poll (re-armed by `@co/coordination` for persistent semantics) |
| Dependencies | One dependency (ZK). No database, no HTTP server. |

---

## Roles & ROLE_WEIGHTS

`ITaskQueue.claim()` sorts pending tasks by:
1. Hard-assigned `assigned_to === claimer` first
2. `ROLE_WEIGHTS[claimer.role][task.link]` DESC (own link = 100, others 10-20, never 0 for chain workers)
3. `task.priority` ASC (HIGH = 0)
4. Task ID FIFO

| Role | Value | `ROLE_WEIGHTS` for own link | Typical behavior |
|------|-------|------------------------------|------------------|
| Leader | `leader` | 0 across the board | Runs TUI, mechanical routing, merge validation, orphan recovery — never claims ordinary tasks |
| Planner | `planner` | 100 on `plan` | Decomposes requirements, defines blueprints |
| Builder | `builder` | 100 on `build` | Implements per blueprint, produces traceability evidence |
| Verifier | `verifier` | 100 on `verify` | Cross-checks Builder output against Plan |
| Reviewer | `reviewer` | 100 on `review` | Quality gate for design consistency across full chain |
| Accepter | `accepter` | 100 on `accept` | Final Go/No-Go validation against business criteria |

Roles are **preferences, not identities** — any non-leader Worker can claim any chain link as a fallback.

---

## Installation & Development

### Prerequisites

- Node.js 18+
- pnpm 10+
- Docker (for ZooKeeper)
- Claude Code CLI (for real Worker message processing)

### From Source

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server

pnpm install
docker-compose up -d
pnpm -r build

# Start with 3 Workers
node bin/claude-orchestrator run --worker 3
```

### Build / Validate

```bash
pnpm -r build         # tsc -b across all 8 packages (project references)
pnpm typecheck        # pnpm -r exec tsc --noEmit
pnpm depcheck         # dependency-cruiser layer-isolation rules
pnpm pkgcheck         # per-package dependency whitelist
```

### Run Tests

Tests follow `tests/CLAUDE.md` — each package owns its `tests/CLAUDE.md` (verbatim copy) plus `tests/core/{unit,integration,e2e,manual}/` and a temporary `tests/scratch/YYYY-MM-DD/<feature>/` folder. Every file under `tests/core/` carries a `CORE-RETENTION` header; mocks carry `TRUST-JUSTIFICATION`.

```bash
pnpm test                                                # all packages (vitest run)
pnpm --filter @co/contracts test                         # one package
pnpm --filter @co/leader test:watch                      # watch mode
node packages/runtime/tests/core/manual/claude-cli-smoke.mjs   # manual smoke (requires real claude-cli)
```

---

## Project Structure

```
├── packages/                            # pnpm workspace packages (v0.5)
│   ├── contracts/                       #   Layer 0 — branded IDs, schemas, interfaces, errors, paths
│   ├── infra/                           #   Layer 1 — ZkClient, Logger, ConfigLoader, exec utils
│   ├── runtime/                         #   Layer 2 — TemplateEngine, ClaudeRunner, HookEngine
│   ├── coordination/                    #   Layer 3 — TaskQueue (with watch*), MessageRouter, InstanceRegistry
│   ├── leader/                          #   Layer 4a — EventBus, State, ChainRouter, MergeValidator,
│   │                                    #               Recovery, Monitor, TaskOrchestrator, Watcher,
│   │                                    #               StreamTailer, TUI (renderer / input / controller)
│   ├── worker/                          #   Layer 4b — WorkerWatcher (8-step pipeline), SelfEvaluator,
│   │                                    #               CommitChecker
│   ├── orchestrator/                    #   Layer 5 — run.ts 5 phases, InitChecker, WorktreeInitializer,
│   │                                    #               ChildSupervisor
│   └── cli/                             #   Layer 6 — commander entry, run + config commands
│
├── templates/                           # Prompt and memory templates
│   ├── agents/                          #   12 Worker prompt templates
│   └── claude-memory/                   #   6 CLAUDE.md directory memory templates
│
├── skills/                              # Claude Code skills (8 total)
│   ├── task-traceability/               #   Foundation layer
│   ├── task-planning/                   #   Planner skill
│   ├── task-execution/                  #   Builder skill
│   ├── task-verification/               #   Verifier skill
│   ├── task-review/                     #   Reviewer skill
│   ├── task-acceptance/                 #   Accepter skill
│   ├── claude-orchestrator/             #   CLI reference
│   └── claude-code-developer/           #   Claude Code developer reference
│
├── docs/
│   ├── v0.5/                            #   15 design documents (package-layout, contracts, protocol,
│   │                                    #     error-and-recovery, leader-design, worker-design, …)
│   └── v0.4/                            #   Archived v0.4 docs
│
├── tests/
│   └── CLAUDE.md                        #   Authoritative testing standards (copied into each package)
│
├── scripts/
│   └── check-pkg-deps.mjs               # Per-package dependency whitelist enforcement
│
├── .dependency-cruiser.cjs              # Layer-isolation rules (7 forbidden patterns)
├── pnpm-workspace.yaml                  # Workspace packages glob
├── tsconfig.base.json                   # Shared compiler options
├── tsconfig.json                        # Root references → 8 packages
├── docker-compose.yml                   # ZooKeeper
├── bin/claude-orchestrator              # CLI shim → packages/cli/dist/index.js
└── package.json                         # Root scripts: build / typecheck / depcheck / pkgcheck / test
```

---

## Configuration Reference

`@co/infra/ConfigLoader` merges five layers (highest priority first):

1. CLI flags (`-z`, `-d`)
2. Environment variables (`ZK_HOSTS`, `CO_CACHE_DIR`, …)
3. Worktree-local `.claude-orchestrator/config.json` (when invoked inside a worktree)
4. Project root `.claude-orchestrator/config.json`
5. Global `~/.claude-orchestrator/config.json`

| Config | Where | Default |
|--------|-------|---------|
| ZK hosts | `-z, --zookeeper` flag or `ZK_HOSTS` env | `127.0.0.1:2181` |
| Project namespace | `zookeeper.project_id` in config | unset → `/claude-orchestrator/...`; set → `/co/{project_id}/...` |
| Instance ID | Auto-generated per Worker | saved to `.claude-orchestrator/config.json` |
| Claude command | `commands.claude_cli` | `claude --dangerously-skip-permissions --permission-mode dontAsk` |
| Git command | `commands.git` | `git` |
| Cache directory | `cache_dir` | `.claude-orchestrator/sessions` |
| Hooks | `hooks[]` array | empty |

---

## License

MIT — use it, fork it, ship it.

---

<p align="center">
  <sub>Built with TypeScript, pnpm workspaces, and ZooKeeper. Orchestrate responsibly.</sub>
</p>
