# System Architecture Overview

Claude Orchestrator coordinates multiple Claude Code instances as an AI team. One Leader manages N Workers through an in-memory message passing protocol, with each Worker running in an isolated git worktree.

## High-Level Component Diagram

```
                         CLI Entry Point
                              |
                    +---------v---------+
                    |   @co/cli          |
                    |   (commander)      |
                    +---------+---------+
                              |
                    +---------v---------+
                    | @co/orchestrator   |
                    | (runOrchestrator)  |
                    +---+----+----+-----+
                        |    |    |
            +-----------+    |    +-----------+
            |                |                |
   +--------v------+  +-----v------+  +------v--------+
   | @co/leader     |  | @co/worker |  | ChildSupervisor|
   | (TUI, routing) |  | (pipeline) |  | (process mgmt) |
   +---+--------+---+  +-----+-----+  +----------------+
       |        |            |
       v        v            v
   +---+--------+------------+---+
   |     @co/coordination         |
   |  TaskQueue / MessageRouter   |
   |  / InstanceRegistry          |
   +--------------+---------------+
                  |
   +--------------v---------------+
   |        @co/infra              |
   |  Logger / ConfigLoader / Zk  |
   +--------------+---------------+
                  |
   +--------------v---------------+
   |       @co/contracts           |
   |  IDs / Schemas / Interfaces  |
   |  / Events / Errors           |
   +------------------------------+
```

## Package Layering (Dependency Direction: Downward Only)

| Layer | Package | Purpose |
|-------|---------|---------|
| 0 | `@co/contracts` | Branded IDs, Zod schemas, interfaces, error types, event definitions |
| 1 | `@co/infra` | Logger, ConfigLoader (5-layer merge), ZkClient, exec utilities |
| 2 | `@co/runtime` | ClaudeRunner (`--resume`/`--fork-session`), TemplateEngine, HookEngine |
| 3 | `@co/coordination` | TaskQueue, MessageRouter, InstanceRegistry (in-memory abstractions) |
| 4a | `@co/leader` | EventBus, State, ChainRouter, MergeValidator, Recovery, TaskOrchestrator, TUI |
| 4b | `@co/worker` | WorkerWatcher (8-step pipeline), SelfEvaluator, CommitChecker |
| 5 | `@co/orchestrator` | runOrchestrator() 5-phase startup, InitChecker, WorktreeInitializer, ChildSupervisor |
| 6 | `@co/cli` | Commander entry point: `run` + `config` + headless state commands |

**Critical constraint:** Layer 4a (leader) and Layer 4b (worker) must never import each other. They communicate exclusively through Layer 3 (coordination) interfaces.

## Core Components

### Leader

The Leader is the central coordinator. It runs a React/Ink TUI with 7 panels and handles:

- **Chain routing** (`ChainRouter`): Decomposes requirements into task chains, dispatches tasks to Workers, processes completion reports, and manages the Plan -> Execute -> Verify -> Review -> Accept flow
- **Merge validation** (`MergeValidator`): Validates git merges on chain close, handles conflicts and retry logic
- **Orphan recovery** (`TaskRecovery`): Detects disconnected Workers and requeues their tasks
- **State management** (`LeaderState`): Maintains in-memory view of all Workers, tasks, and events
- **Task orchestration** (`TaskOrchestrator`): Watches task queue for pending/claimed changes and emits events
- **Event bus** (`LeaderEventBus`): Pub/sub for all system events (worker_joined, task_completed, etc.)

### Worker

Each Worker runs in an isolated git worktree and executes an 8-step pipeline:

1. **Parse** incoming message (link, task_id, chain_id)
2. **Select template** by link type (worker-{plan|execute|verify|review|accept|explore}.md)
3. **Fire hooks** (worker_message_start)
4. **Render prompt** via TemplateEngine + identity system prompt
5. **Execute** main task via ClaudeRunner.run()
6. **Commit check** — CommitChecker auto-commits changes with generated messages
7. **Self-evaluate** — SelfEvaluator evaluates output via --fork-session, returns EvalDecision
8. **Report** — sends completion_report with EvalDecision JSON to Leader

### Coordination Layer

All coordination runs through in-memory abstractions (no external database):

- **TaskQueue**: Push -> Claim -> Complete/Fail flow. Role-weighted claim sorting (ROLE_WEIGHTS). Atomic claim locks.
- **MessageRouter**: Point-to-point messaging with push notification. Persistent queues per instance.
- **InstanceRegistry**: Register/unregister with heartbeat. Watch for instance changes.

### Orchestration Layer

The `runOrchestrator()` function manages the 5-phase startup:

1. **Init checking** — validates config, skills, CLAUDE.md
2. **Worktree creation** — creates isolated git worktrees for each Worker
3. **Leader startup** — initializes all leader components and TUI
4. **Worker spawning** — forks Worker child processes via ChildSupervisor
5. **Shutdown handling** — phase-based graceful shutdown with timeout

## Data Flow

### Task Lifecycle

```
User types requirement in TUI
  |
  v
Leader decomposes requirement (via ClaudeRunner + decompose template)
  |
  v
ChainDef created with plan/execute/verify/review/accept tasks
  |
  v
TaskQueue.push() for each task
  |
  v
ChainRouter dispatches first task to idle Worker via MessageRouter
  |
  v
Worker claims task, runs 8-step pipeline
  |
  v
Worker sends completion_report with EvalDecision
  |
  v
ChainRouter processes decision:
  - activate_next: dispatch next link's task
  - feedback: retry previous link with feedback
  - close_chain: merge and close
  - reject: abort chain
  - spawn_chain: close parent, create child chain (magic mode)
```

### Message Flow

```
Leader -> MessageRouter -> Worker (task_dispatch)
Worker -> MessageRouter -> Leader (completion_report)
Worker -> MessageRouter -> Leader (worker_activity)
Leader -> EventBus -> TUI (all events)
```

## Key Design Decisions

1. **In-memory coordination**: No external database. All state lives in TaskQueue, MessageRouter, and InstanceRegistry. Survives only within a single session.

2. **Git worktree isolation**: Each Worker gets its own worktree with a dedicated branch. Prevents file conflicts between Workers.

3. **Closed-loop responsibility chain**: Every output is verified by the next role. Plan -> Execute -> Verify -> Review -> Accept forms a quality gate.

4. **Self-evaluation**: Workers evaluate their own output via --fork-session, returning structured EvalDecision JSON that drives routing.

5. **Chain forest (magic mode)**: Explorer Worker can spawn sub-chains, creating a tree of task chains rather than a single pipeline.
