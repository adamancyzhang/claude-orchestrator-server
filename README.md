# Claude Orchestrator

<p align="center">
  <strong>Turn Claude Code instances into a multi-agent swarm — coordinated through in-memory message passing.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@adamancyzhang/claude-orchestrator"><img src="https://img.shields.io/npm/v/@adamancyzhang/claude-orchestrator?color=blue" alt="npm"></a>
  <a href="https://github.com/adamancyzhang/claude-orchestrator-server"><img src="https://img.shields.io/github/license/adamancyzhang/claude-orchestrator-server" alt="license"></a>
  <img src="https://img.shields.io/badge/node-18%2B-green" alt="node">
  <img src="https://img.shields.io/badge/typescript-5.6%2B-blue" alt="typescript">
  <img src="https://img.shields.io/badge/pnpm-workspaces-orange" alt="pnpm">
  <img src="https://img.shields.io/badge/protocol-v0.7.0-purple" alt="protocol">
</p>

---

## What is this?

**Claude Orchestrator** runs multiple Claude Code instances as an AI team. Each Worker gets an isolated git worktree with humanized names (Tom, Jerry, Lucy...), auto-processes assigned tasks via `claude -p`, self-evaluates output via `--fork-session`, and sends a 5-variant `EvalDecision` back to the Leader. The Leader runs an interactive TUI (React/Ink v7, Tab/1–9 worker switching) and mechanically routes tasks through the **Plan -> Execute -> Verify -> Review -> Accept** responsibility chain.

Optional **magic mode** (`--magic`) adds an Explorer Worker and an `explore` chain link. The Explorer autonomously analyzes the codebase, spawns sub-chains for discovered work, and the leader manages a forest of chains rather than a single linear pipeline.

All coordination — leader election, task queuing, message routing, instance registry — runs through an in-memory message passing protocol. No external database or service required.

```
┌──────────────────────────────────────────────────────────┐
│              In-Memory Message Protocol                   │
│     TaskQueue  /  MessageRouter  /  InstanceRegistry      │
└────────┬────────────────┬────────────────┬────────────────┘
         │                │                │
    ┌────┴────┐      ┌────┴────┐      ┌────┴────┐
    │ Leader  │      │ Worker  │      │ Worker  │
    │  (TUI)  │      │(worktree)│     │(worktree)│
    │  Tom    │      │  Jerry   │      │  Lucy   │
    │planner  │      │ executor │      │verifier │
    └─────────┘      └─────────┘      └─────────┘
```

---

## Quick Start

### 1. Install

```bash
npm install -g @adamancyzhang/claude-orchestrator
```

Requires Node.js 18+ and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`).

### 2. Launch

```bash
claude-orchestrator run --worker 6
```

One command. It:
- Runs the `InitChecker` (config, skills, CLAUDE.md verification)
- Creates isolated git worktrees for each Worker (`.claude-orchestrator/worktree/{name}/`)
- Assigns humanized names (Tom, Jerry, Lucy, Thomas, Jack...) and roles (planner, executor, verifier, reviewer, accepter, explorer)
- Copies agent templates and skills into each worktree
- Starts the Leader TUI
- Forks Worker child processes through `ChildSupervisor` (each in its own worktree, max 3 restarts on crash, exits when parent dies)

### 3. Use It

Type a requirement in the TUI input line and press Enter. The Leader forwards it to a Planner Worker (or self-processes via the `worker-decompose.md` template), which decomposes it into a `ChainDef`. Each Worker processes its link, self-evaluates with `--fork-session`, and the Leader routes the next link based on the `EvalDecision` JSON.

```bash
# Show resolved config (includes protocol_version)
claude-orchestrator config

# Show version + protocol tag
claude-orchestrator --version
# -> 0.7.0 (protocol 0.7.0)
```

---

## Architecture

### 8-Package Workspace

Strict one-directional layering enforced by `dependency-cruiser`:

| Layer | Package | Responsibility | Allowed deps |
|-------|---------|---------------|--------------|
| 0 | `@co/contracts` | Branded IDs, Zod schemas, interfaces, errors, `ROLE_WEIGHTS`, `PROTOCOL_VERSION` | `zod` |
| 1 | `@co/infra` | `Logger`, `ConfigLoader` (5-layer merge), exec utils, in-memory messaging primitives | contracts |
| 2 | `@co/runtime` | `ClaudeRunner` (`--resume`/`--fork-session`), `TemplateEngine`, `HookEngine` | contracts, infra |
| 3 | `@co/coordination` | `TaskQueue`, `MessageRouter`, `InstanceRegistry` — in-memory message passing abstractions | contracts, infra |
| 4a | `@co/leader` | EventBus, State, ChainRouter, MergeValidator, Recovery, TaskOrchestrator, TUI (React/Ink v7, 7 panels) | contracts, runtime, coordination |
| 4b | `@co/worker` | WorkerWatcher (8-step pipeline), SelfEvaluator, CommitChecker | contracts, runtime, coordination |
| 5 | `@co/orchestrator` | `runOrchestrator()` 5-phase startup, `InitChecker`, `WorktreeInitializer`, `ChildSupervisor` | contracts, infra, runtime, coordination, leader, worker |
| 6 | `@co/cli` | `commander` entry point: `run` + `config` commands | contracts, infra, coordination, orchestrator |

Leader (4a) and Worker (4b) are at the same layer and **must not import each other**; they communicate only through the `@co/coordination` interfaces.

### Leader-Worker Model

| Component | What it does | Mechanism |
|-----------|-------------|-----------|
| **Leader** | Interactive TUI (React/Ink v7, Tab/1–9 worker switching), mechanical message/task routing, merge validation, orphan recovery, chain forest management | Exclusive leader election — exactly one Leader per session |
| **Worker** | Isolated git worktree, message watch loop, auto-processes messages via `claude -p`, self-evaluates output with `--fork-session`, auto-commits changes with `--resume` | Instance registry — auto-cleanup on disconnect |
| **Task Queue** | Push -> Claim -> Complete (or Fail). `ROLE_WEIGHTS`-driven claim sorting. | FIFO ordering, atomic claim locks |
| **Message Router** | Point-to-point messaging with push notification | Persistent message queues per instance |

### Worker 8-step pipeline

```
1. Parse incoming message (link, task_id, chain_id)
2. Select template by link (worker-{plan|execute|verify|review|accept|explore}.md)
3. Fire worker_message_start hook
4. Render template + identity prompt (via --append-system-prompt)
5. Execute main task -> ClaudeRunner.run() -> sessionId
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
Plan -> Execute -> Verify -> Review -> Accept
```

With magic mode (`--magic`), the chain extends to:

```
Plan -> Execute -> Verify -> Review -> Explore -> Accept
                                          |
                                          v
                                    spawn_chain -> Plan -> Execute -> ...
```

Each link is a dedicated role. One Worker produces, the next Worker verifies — forming a **closed-loop responsibility chain**. Every output is written to `.claude-orchestrator/docs/{name}/YYYY-MM-DD/` and the next link reads from there. Built-in self-evaluation after every link decides what happens next via `EvalDecision`:

| `EvalDecision.decision` | Effect |
|-------------------------|--------|
| `activate_next` | Leader creates the next link's task and dispatches it |
| `feedback` | Leader forwards feedback text to a target Worker for rework |
| `reject` | Chain terminates as failed |
| `close_chain` | Chain terminates as successful |
| `spawn_chain` | Explorer requests the Leader spawn a new sub-chain (magic mode) |

---

## Magic Mode

Pass `--magic` to enable autonomous exploration. The 6th Worker is assigned the `explorer` role and the responsibility chain gains an `explore` link. The Explorer Worker autonomously analyzes the codebase for improvement opportunities and returns `spawn_chain` decisions. The Leader then creates new chains, building a **chain forest** rather than a single pipeline.

```bash
# Enable magic mode with a max chain depth of 10
claude-orchestrator run --worker 6 --magic --magic-max-chains 10
```

| Flag | Description |
|------|-------------|
| `--magic` | Enable the Explorer role and `spawn_chain` decision path |
| `--magic-max-chains <m>` | Hard cap on chain forest depth. Omit for unlimited. |

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `run --worker <n>` | One-shot orchestration: InitChecker, worktree creation, Leader TUI, fork N Workers |
| `config` | Print resolved configuration (commands, hooks, protocol version) |

Common flags:
- `-d, --debug` — enable debug logging
- `-y, --yes` (run only) — skip interactive `InitChecker` prompts

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
├── agents/                              <- Worker prompt templates
│   ├── worker-identity.md               #   --append-system-prompt identity card
│   ├── worker-decompose.md              #   Requirement -> ChainDef decomposition
│   ├── worker-planner.md                #   Planner: standing role description (system prompt)
│   ├── worker-planner-task.md           #   Planner: per-task user-message wrapper
│   ├── worker-executor.md               #   Executor: standing role description
│   ├── worker-executor-task.md          #   Executor: per-task user-message wrapper
│   ├── worker-verifier.md               #   Verifier: standing role description
│   ├── worker-verifier-task.md          #   Verifier: per-task user-message wrapper
│   ├── worker-reviewer.md               #   Reviewer: standing role description
│   ├── worker-reviewer-task.md          #   Reviewer: per-task user-message wrapper
│   ├── worker-accepter.md               #   Accepter: standing role description
│   ├── worker-accepter-task.md          #   Accepter: per-task user-message wrapper
│   ├── worker-explorer.md               #   Explorer: standing role description (magic mode)
│   ├── worker-explorer-task.md          #   Explorer: per-task user-message wrapper
│   ├── worker-evaluate.md               #   Self-evaluation -> EvalDecision JSON
│   ├── worker-evaluate-format-hint.md   #   Appended on eval retry attempts >= 2
│   ├── worker-commit-message.md         #   Auto commit-message generation
│   ├── worker-merge-decision.md         #   MergeDecision JSON (Leader-side)
│   ├── worker-memorize-dir.md           #   Directory memory generation
│   └── worker-memorize-file.md          #   File-level memory generation
├── claude-memory/
│   ├── team-claude.md                   #   Workspace-level CLAUDE.md
│   ├── personal-claude-planner.md       #   Planner role rules
│   ├── personal-claude-executor.md      #   Executor role rules
│   ├── personal-claude-verifier.md      #   Verifier role rules
│   ├── personal-claude-reviewer.md      #   Reviewer role rules
│   ├── personal-claude-accepter.md      #   Accepter role rules
│   └── personal-claude-explorer.md      #   Explorer role rules
└── user-global-claude.md                #   Behavioral guidelines for Workers
```

---

## Skills

| Skill | Role | Description |
|-------|------|-------------|
| `task-planning` | Planner | Analyze requirements, define blueprints, break down tasks |
| `task-execution` | Executor | Claim tasks, implement against blueprints, commit with traceability |
| `task-verification` | Verifier | Independently verify Executor output against Plan criteria |
| `task-review` | Reviewer | Review full chain (Plan->Execute->Verify) for design consistency |
| `task-acceptance` | Accepter | Validate final deliverable against business criteria, sign Go/No-Go |
| `task-exploration` | Explorer | Autonomous codebase analysis, spawn sub-chains for discovered work |
| `task-traceability` | Foundation | Trace -> Execute -> Map -> Evidence -> Record — all roles |
| `test-driven-development` | Foundation | TDD workflow: red-green-refactor cycle |
| `claude-orchestrator` | All | CLI reference |
| `claude-code-developer` | All | Claude Code developer reference |

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
| Executor | `executor` | 100 on `execute` | Implements per blueprint, produces traceability evidence |
| Verifier | `verifier` | 100 on `verify` | Cross-checks Executor output against Plan |
| Reviewer | `reviewer` | 100 on `review` | Quality gate for design consistency across full chain |
| Accepter | `accepter` | 100 on `accept` | Final Go/No-Go validation against business criteria |
| Explorer | `explorer` | 100 on `explore` | Autonomous codebase analysis, spawns sub-chains (magic mode) |

Roles are **preferences, not identities** — any non-leader Worker can claim any chain link as a fallback.

---

## Development

### Prerequisites

- Node.js 18+
- pnpm 10+
- Claude Code CLI (`claude`)

### From Source

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server

pnpm install
pnpm -r build

# Start with 6 Workers (minimum)
node bin/claude-orchestrator run --worker 6
```

### Build / Validate

```bash
pnpm -r build         # tsc -b across all 8 packages (project references)
pnpm typecheck        # tsc --noEmit across all packages
pnpm depcheck         # dependency-cruiser layer-isolation rules
pnpm pkgcheck         # per-package dependency whitelist enforcement
```

---

## Project Structure

```
├── packages/                            # pnpm workspace packages
│   ├── contracts/                       #   Layer 0 — branded IDs, schemas, interfaces, errors, paths
│   ├── infra/                           #   Layer 1 — Logger, ConfigLoader, exec utils
│   ├── runtime/                         #   Layer 2 — TemplateEngine, ClaudeRunner, HookEngine
│   ├── coordination/                    #   Layer 3 — TaskQueue, MessageRouter, InstanceRegistry
│   ├── leader/                          #   Layer 4a — EventBus, State, ChainRouter, MergeValidator,
│   │                                    #             Recovery, TaskOrchestrator, TUI (React/Ink v7)
│   ├── worker/                          #   Layer 4b — WorkerWatcher, SelfEvaluator, CommitChecker
│   ├── orchestrator/                    #   Layer 5 — runOrchestrator, InitChecker, WorktreeInitializer,
│   │                                    #             ChildSupervisor
│   └── cli/                             #   Layer 6 — commander entry, run + config commands
│
├── templates/                           # Prompt and memory templates
│   ├── agents/                          #   20 Worker prompt templates
│   ├── claude-memory/                   #   7 CLAUDE.md directory memory templates
│   └── user-global-claude.md            #   Behavioral guidelines
│
├── skills/                              # Claude Code skills (10 total)
│   ├── task-traceability/               #   Foundation layer
│   ├── test-driven-development/         #   TDD workflow
│   ├── task-planning/                   #   Planner skill
│   ├── task-execution/                  #   Executor skill
│   ├── task-verification/               #   Verifier skill
│   ├── task-review/                     #   Reviewer skill
│   ├── task-acceptance/                 #   Accepter skill
│   ├── task-exploration/                #   Explorer skill (magic mode)
│   ├── claude-orchestrator/             #   CLI reference
│   └── claude-code-developer/           #   Claude Code developer reference
│
├── scripts/
│   ├── check-pkg-deps.mjs               #   Per-package dependency whitelist enforcement
│   ├── publish.sh                       #   Package publishing
│   ├── start-leader.sh                  #   Start leader process
│   ├── start-server.sh                  #   Start server
│   ├── start-worker.sh                  #   Start worker process
│   └── stop-all.sh                      #   Stop all processes
│
├── .dependency-cruiser.cjs              # Layer-isolation rules (7 forbidden patterns)
├── pnpm-workspace.yaml                  # Workspace packages glob
├── tsconfig.base.json                   # Shared compiler options
├── tsconfig.json                        # Root references -> 8 packages
├── bin/claude-orchestrator              # CLI shim -> packages/cli/dist/index.js
└── package.json                         # Root scripts: build / typecheck / depcheck / pkgcheck / test
```

---

## Configuration Reference

`@co/infra/ConfigLoader` merges five layers (highest priority first):

1. CLI flags (`-d`)
2. Environment variables
3. Worktree-local `.claude-orchestrator/config.json` (when invoked inside a worktree)
4. Project root `.claude-orchestrator/config.json`
5. Global `~/.claude-orchestrator/config.json`

| Config | Where | Default |
|--------|-------|---------|
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
  <sub>Built with TypeScript and pnpm workspaces. Orchestrate responsibly.</sub>
</p>
