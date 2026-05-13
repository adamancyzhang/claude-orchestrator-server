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
  <img src="https://img.shields.io/badge/ZooKeeper-3.8%2B-orange" alt="zookeeper">
</p>

---

## What is this?

**Claude Orchestrator** runs multiple Claude Code instances as an AI team. Each Worker gets an isolated git worktree with humanized names (Tom, Jerry, Lucy...), auto-processes assigned tasks via `claude -p`, self-evaluates output, and sends structured decisions back to the Leader. The Leader runs a read-only TUI and mechanically routes tasks through the Plan → Build → Verify → Review → Accept responsibility chain.

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

## Quick Start

### 1. Install the CLI

```bash
npm install -g @adamancyzhang/claude-orchestrator
```

### 2. Start ZooKeeper

```bash
docker-compose up -d
```

### 3. Launch Everything

```bash
claude-orchestrator run --worker 5
```

One command. It:
- Creates isolated git worktrees for each Worker (`.claude-orchestrator/worktree/{name}/`)
- Assigns humanized names (Tom, Jerry, Lucy, Thomas, Jack...) and roles (planner, builder, verifier, reviewer, accepter)
- Copies agent templates and skills into each worktree
- Starts the Leader TUI
- Forks Worker child processes (each in its own worktree)

### 4. Use It

Type a requirement in the TUI input line and press Enter. The Leader forwards it to a Planner Worker, which decomposes it into a responsibility chain. Each Worker processes its link, self-evaluates, and the Leader routes the next link.

```bash
# CLI commands (from any terminal)
claude-orchestrator push-task --title "Implement login endpoint" --priority 0
claude-orchestrator send-message --to-name Jerry --content "Starting on the auth module?"
claude-orchestrator poll-task --status pending
```

---

## Architecture

### Leader-Worker Model (v0.4)

| Component | What it does | ZK magic |
|-----------|-------------|----------|
| **Leader** | Read-only TUI, mechanical message/task routing, merge validation, orphan recovery. Self-processes decompose via claude-cli when template available; otherwise forwards to Planner. | `/leader` EPHEMERAL — exactly one Leader |
| **Worker** | Isolated git worktree, ZK watch loop, auto-processes messages via `claude -p`, self-evaluates output, auto-commits changes | EPHEMERAL nodes → auto-cleanup on disconnect |
| **Task Queue** | Push → Claim → Complete (or Block/Fail/Retry). Role-link priority sorting. | Sequential nodes for FIFO, ephemeral claims for atomic locks |
| **Message Router** | Point-to-point messaging via ZK watches | Persistent-sequential nodes, push notification |

### Worktree Isolation

Each Worker runs in its own `git worktree` under `.claude-orchestrator/worktree/{name}/`. This gives every Worker:
- **Independent working directory** — no file conflicts
- **Dedicated git branch** — `claude-orchestrator/{name}-workspace`
- **Personal CLAUDE.md** — role-specific rules at `.claude-orchestrator/docs/{name}/CLAUDE.md`
- **Daily directory memory** — `.claude-orchestrator/docs/{name}/YYYY-MM-DD/CLAUDE.md` preserves session context across restarts

### CLI-Native — Zero MCP Server

Leader and Workers each connect directly to ZooKeeper. The Leader is primarily a router: self-processes decompose when template available (otherwise forwards to Planner), creates tasks from ChainDef JSON, mechanically executes EvalDecision JSON. All other AI intelligence runs on Workers via `claude -p`. No HTTP, no SSE, no MCP protocol.

### Responsibility Chain

```
Plan → Build → Verify → Review → Accept
```

Each link is a dedicated role. One Worker produces, the next Worker verifies — forming a **closed-loop responsibility chain**. Every output is written to `.claude-orchestrator/docs/{name}/YYYY-MM-DD/` and the next link reads from there. Built-in self-evaluation after every link ensures quality at each step.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `run --worker <n>` | Start full orchestration: Leader TUI + N Workers with worktree isolation |
| `unregister` | Explicitly unregister an instance |
| `push-task` | Create a task (optionally assign to someone) |
| `claim-task` | Grab the next task — atomic, no two instances can claim the same one |
| `complete-task` | Mark a task done with results |
| `poll-task` | List tasks, optionally filtered by status |
| `task-block` | Mark a claimed task as blocked (with reason) |
| `task-fail` | Mark a claimed task as failed (with reason) |
| `task-retry` | Re-queue a failed task (retry_count + 1, max 3) |
| `send-message` | Send a message to a specific instance |
| `poll-message` | Check your inbox |
| `delete-message` | Delete a message from your inbox |
| `config` | Show current configuration |

---

## Directory Memory (CLAUDE.md)

Claude Orchestrator uses a three-layer **CLAUDE.md** system as directory memory:

| Layer | Location | Content |
|-------|----------|---------|
| **Team** | Worktree root `CLAUDE.md` | Team roles, directory structure, responsibility chain, git rules |
| **Personal** | `.claude-orchestrator/docs/{name}/CLAUDE.md` | Role-specific process, output standards, communication rules, prohibited behaviors |
| **Daily** | `.claude-orchestrator/docs/{name}/YYYY-MM-DD/CLAUDE.md` | Session context, task progress, decisions, blockers |

Layers 1 and 2 are seeded from templates during worktree creation. Layer 3 is created and maintained by Workers themselves during task execution — guided by prompt templates that instruct Claude to manage its own daily memory.

---

## Template Structure

```
templates/
├── agents/                          ← Worker prompt templates
│   ├── worker-decompose.md          #   Requirement → chain decomposition
│   ├── worker-plan.md               #   Planner: blueprint design
│   ├── worker-build.md              #   Builder: traceable implementation
│   ├── worker-verify.md             #   Verifier: cross-check Plan vs Build
│   ├── worker-review.md             #   Reviewer: chain-level quality gate
│   ├── worker-accept.md             #   Accepter: final Go/No-Go decision
│   └── worker-evaluate.md           #   Self-evaluation after each link
└── claude-memory/                   ← Directory memory templates
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

---

## ZooKeeper Node Tree

```
/claude-orchestrator
├── leader                     [EPHEMERAL] Leader metadata
├── instances/{id}             [EPHEMERAL] Instance metadata
├── tasks/
│   ├── pending/task-NNNNN     [PERSISTENT_SEQUENTIAL]
│   ├── claimed/{insId}-task-NNNNN [EPHEMERAL] ← atomic lock
│   └── completed/task-NNNNN   [PERSISTENT]
└── messages/{instanceId}/msg-NNNNN [PERSISTENT_SEQUENTIAL]
```

---

## Why ZooKeeper?

| Concern | ZooKeeper answer |
|---------|-----------------|
| Instance lifecycle | Ephemeral nodes → auto-cleanup on crash |
| Task ordering | Sequential nodes → guaranteed FIFO |
| Claim atomicity | `create(path, ephemeral=true)` is atomic — only one winner |
| Leader election | `/leader` EPHEMERAL → exactly one Leader |
| Change notification | Built-in watches → push, not poll |
| Dependencies | One dependency (ZK). No database, no HTTP server. |

---

## Roles

| Role | Value | Typical behavior |
|------|-------|-----------------|
| Leader | `leader` | Runs TUI, mechanical routing, merge validation, orphan recovery |
| Planner | `planner` | Decomposes requirements, defines blueprints |
| Builder | `builder` | Implements per blueprint, produces traceability evidence |
| Verifier | `verifier` | Cross-checks Builder output against Plan |
| Reviewer | `reviewer` | Quality gate for design consistency across full chain |
| Accepter | `accepter` | Final Go/No-Go validation against business criteria |

---

## Installation & Development

### Prerequisites

- Node.js 18+
- Docker (for ZooKeeper)
- Claude Code CLI (for Worker message processing)

### From Source

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server

npm install
docker-compose up -d
npm run build

# Start with 3 Workers
node dist/index.js run --worker 3
```

### Run Tests

```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
npx vitest run tests/unit/worker-prompt-rendering.test.ts  # Prompt rendering verification
```

---

## Project Structure

```
├── src/
│   ├── index.ts                   # CLI entry point (commander)
│   ├── config.ts                  # Configuration layering (global + project)
│   ├── orchestrator/
│   │   └── run.ts                 # Unified run orchestrator (5-phase startup)
│   ├── leader/                    # Leader node
│   │   ├── index.ts               #   Startup / shutdown orchestration
│   │   ├── tui.ts                 #   ANSI TUI with Worker Messages panel
│   │   ├── event-bus.ts           #   Typed EventEmitter (17 events)
│   │   ├── state.ts               #   Centralized LeaderState
│   │   ├── monitor.ts             #   WorkerMonitor — join/leave detection
│   │   ├── orchestrator.ts        #   TaskOrchestrator — lifecycle tracking
│   │   ├── recovery.ts            #   TaskRecovery — orphan recovery (max 3 retries)
│   │   ├── watcher.ts             #   LeaderWatcher — message processing
│   │   ├── chain-router.ts        #   ChainRouter — mechanical routing (self or forward decompose)
│   │   ├── merge-validator.ts     #   Cross-verify + merge worker branches
│   │   └── stream-tailer.ts       #   StreamTailer — live worker log display
│   ├── worker/                    # Worker node
│   │   ├── worktree-initializer.ts#   Name generation, worktree creation, role assignment
│   │   ├── child.ts               #   Child process entry point
│   │   ├── child-runner.ts        #   Child process core (chdir → ZK → Watcher)
│   │   ├── watcher.ts             #   WorkerWatcher — ZK watch loop + orchestration
│   │   ├── evaluator.ts           #   SelfEvaluator — built-in self-evaluation (max 3 retries)
│   │   └── commit-checker.ts      #   Auto-commit after task completion
│   ├── executor/                  # Template execution engine
│   │   ├── template.ts            #   TemplateEngine — loading + identity card + rendering
│   │   └── runner.ts              #   ClaudeRunner — CLI execution wrapper
│   ├── zk/
│   │   ├── client.ts              # ZooKeeper connection management
│   │   ├── paths.ts               # ZK path constants
│   │   └── watcher.ts             # ZK watch callback wrapper
│   ├── modules/
│   │   ├── registry.ts            # Instance registry
│   │   ├── task-queue.ts          # Task queue (push/claim/complete/block/fail/retry)
│   │   └── message-router.ts      # Message routing + template rendering
│   ├── hooks/
│   │   └── engine.ts              # HookEngine — pre/post lifecycle hooks
│   ├── models/
│   │   └── schemas.ts             # Zod schemas (Instance, Task, Message, ChainDef, EvalDecision)
│   └── utils/
│       ├── exec.ts                # Shell execution (execWithTee, execWithStreaming, execAndCapture)
│       ├── logger.ts              # Tagged logger (+ --debug mode)
│       ├── output.ts              # JSON output helper
│       └── console-capture.ts     # Console redirect to file (for TUI)
├── templates/                     # Prompt and memory templates (v0.4)
│   ├── agents/                    #   7 Worker prompt templates
│   └── claude-memory/             #   6 CLAUDE.md directory memory templates
├── skills/                        # Claude Code skills (8 total)
│   ├── task-traceability/         #   Foundation layer
│   ├── task-planning/             #   Planner skill
│   ├── task-execution/            #   Builder skill
│   ├── task-verification/         #   Verifier skill
│   ├── task-review/               #   Reviewer skill
│   ├── task-acceptance/           #   Accepter skill
│   ├── claude-orchestrator/       #   CLI reference
│   └── claude-code-developer/     #   Claude Code developer reference
├── docs/
│   ├── v0.4/
│   │   ├── design.md              #   v0.4 full design document
│   │   ├── CLAUDE.md              #   v0.4 changelog summary
│   │   └── worker-init/
│   │       └── design.md          #   Worker initialization + directory memory design
│   └── v0.3/                      #   Archived v0.3 docs
├── tests/
│   ├── unit/                      #   11 test files
│   │   └── worker-prompt-rendering.test.ts  # Prompt variable substitution verification
│   └── integration/               #   7 integration test files
├── examples-workspace/            # Reference implementation of multi-agent patterns
├── docker-compose.yml             # ZooKeeper
├── package.json
└── tsconfig.json
```

---

## Configuration Reference

| Config | Where | Default |
|--------|-------|---------|
| ZK hosts | `-z, --zookeeper` flag or `ZK_HOSTS` env | `127.0.0.1:2181` |
| Instance ID | Auto-generated per Worker | saved to `.claude-orchestrator/config.json` |
| Claude command | `config.json` → `commands.claude-cli` | `claude --dangerously-skip-permissions --permission-mode dontAsk` |
| Cache directory | `config.json` → `cache_dir` | `~/.claude-orchestrator/sessions` |

---

## License

MIT — use it, fork it, ship it.

---

<p align="center">
  <sub>Built with TypeScript and ZooKeeper. Orchestrate responsibly.</sub>
</p>
