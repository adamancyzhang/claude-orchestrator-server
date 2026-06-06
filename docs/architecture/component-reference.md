# Component Reference

Detailed description of each package's classes, interfaces, and responsibilities.

---

## @co/contracts (Layer 0)

The foundation package. Defines all shared types, schemas, interfaces, and error classes.

### Key Exports

| Export | Type | Description |
|--------|------|-------------|
| `ITaskQueue` | Interface | Task lifecycle: push, claim, complete, fail, retry, watch |
| `IMessageRouter` | Interface | Point-to-point messaging: send, poll, waitForMessage, ack |
| `IInstanceRegistry` | Interface | Worker registration: register, unregister, heartbeat, list, watch |
| `IEventBus<T>` | Interface | Typed pub/sub: emit, on, onAny |
| `IClaudeRunner` | Interface | Claude CLI wrapper: run with prompt, log_path, session resume/fork |
| `ITemplateEngine` | Interface | Template loading and rendering with variable interpolation |
| `IHookEngine` | Interface | Lifecycle hook firing |
| `ILogger` | Interface | Structured logging: debug, info, warn, error, child |
| `LeaderEvent` | Union type | 20+ discriminated event types for the entire system |
| `EvalDecision` | Schema | Worker self-evaluation result: activate_next, feedback, reject, close_chain, spawn_chain |
| `MergeDecision` | Schema | Merge validation result: merge, skip, review_first |
| `ChainDef` | Schema | Task chain definition with plan/execute/verify/review/accept/explore tasks |
| `Task` | Schema | Task with id, title, status, link, chain_id, priority, assigned_to |
| `Message` | Schema | Message with type, from/to, content, link, chain_id |
| `Instance` | Schema | Worker instance with id, name, role, status, worktree info |

### Error Classes

| Error | Usage |
|-------|-------|
| `ValidationError` | Schema parse failures |
| `MergeConflictError` | Git merge conflicts with conflict file list |
| `WorktreeLockedError` | Git index.lock contention |
| `GitPermissionError` | Permission denied on git operations |
| `GitNetworkError` | Network failures during fetch/push |
| `OrphanRetryExhaustedError` | Max retries exceeded for orphan recovery |
| `ChainConflictError` | Duplicate chain_id detection |
| `TemplateNotFoundError` | Missing template in TemplateEngine |

### Enums

| Enum | Values |
|------|--------|
| `InstanceRole` | planner, executor, verifier, reviewer, accepter, explorer, leader |
| `TaskLink` | plan, execute, verify, review, accept, explore |
| `TaskStatus` | pending, claimed, completed, failed |
| `MessageType` | direct, broadcast, task_dispatch, completion_report, user_input, help, memory_refresh, worker_activity |
| `EvalDecisionKind` | activate_next, feedback, reject, close_chain, spawn_chain |

---

## @co/infra (Layer 1)

Infrastructure utilities: logging, configuration, and ZooKeeper abstractions.

### Classes

| Class | Description |
|-------|-------------|
| `Logger` | Structured JSON logger with child namespaces. Supports debug/info/warn/error levels |
| `ConfigLoader` | 5-layer config merge: CLI flags > env > worktree config > project config > global config |
| `ZkClient` | ZooKeeper client for leader election and distributed coordination |
| `InMemoryZkClient` | In-memory ZK implementation for single-process mode |

### Key Functions

| Function | Description |
|----------|-------------|
| `loadConfig()` | Merges all config layers into ResolvedConfig |
| `captureConsoleToFile()` | Redirects console output to a file for Worker process isolation |
| `restoreConsole()` | Restores console after capture |

---

## @co/runtime (Layer 2)

Claude CLI integration and template rendering.

### Classes

| Class | Description |
|-------|-------------|
| `ClaudeRunner` | Wraps `claude` CLI. Supports `--resume` (session continuation), `--fork-session` (evaluation), streaming via `--output-format stream-json` |
| `TemplateEngine` | Loads markdown templates from `templates/` directory, renders with variable interpolation |
| `HookEngine` | Fires lifecycle hooks (leader_message_start/end, worker_message_start/end, chain_activated, merge_decision_made) |

### Key Interfaces

| Interface | Description |
|-----------|-------------|
| `RunOptions` | prompt, log_path, system_prompt, resume_session_id, fork_session, cwd, on_chunk, quiet |
| `RunResult` | exit_code, session_id, log_path |
| `StreamChunk` | raw, text, is_final, event (text/thinking/tool_use/result/system/other) |

---

## @co/coordination (Layer 3)

In-memory coordination primitives.

### Classes

| Class | Description |
|-------|-------------|
| `TaskQueue` | FIFO task queue with claim locks. ROLE_WEIGHTS-driven claim sorting. Supports watch callbacks for pending/claimed changes |
| `MessageRouter` | Per-instance message queues. Push notification via waitForMessage. Supports ack/dismiss for message lifecycle |
| `InstanceRegistry` | Instance registration with heartbeat. Watch callback for instance list changes. Auto-cleanup on disconnect |

### Key Methods

#### TaskQueue

| Method | Description |
|--------|-------------|
| `push(input)` | Create a new pending task |
| `claim(claimer, role)` | Atomically claim the highest-priority pending task matching the claimer's role |
| `claimById(taskId, claimer)` | Claim a specific task by ID (for directed dispatch) |
| `assign(taskId, instanceId, name)` | Pin a pending task to a specific Worker without claiming |
| `complete(taskId, result, by, name, duration)` | Mark task as completed with result |
| `fail(taskId, reason)` | Mark task as failed |
| `retry(taskId, snapshot)` | Requeue a failed task with incremented retry count |
| `watchPending(cb)` | Subscribe to pending task changes |
| `watchClaimed(cb)` | Subscribe to claimed task changes |

#### MessageRouter

| Method | Description |
|--------|-------------|
| `send(input)` | Send a message to an instance (or broadcast) |
| `poll(instanceId)` | Get all pending messages for an instance |
| `waitForMessage(instanceId, cb)` | Block until a message arrives, then call cb |
| `ack(instanceId, messageId)` | Acknowledge message processing complete |
| `dismiss(instanceId, messageId)` | Dismiss a message without processing |

#### InstanceRegistry

| Method | Description |
|--------|-------------|
| `register(input)` | Register a new Worker instance |
| `unregister(instanceId)` | Remove instance from registry |
| `heartbeat(instanceId, patch)` | Update instance status/metadata |
| `list()` | Get all registered instances |
| `watch(cb)` | Subscribe to instance list changes |

---

## @co/leader (Layer 4a)

Leader-side components for coordination, routing, and TUI.

### Classes

| Class | Description |
|-------|-------------|
| `LeaderEventBus` | EventEmitter-based IEventBus implementation for LeaderEvent |
| `LeaderState` | In-memory state view. Tracks workers, tasks, events, messages. Implements ILeaderStateView |
| `ChainRouter` | Core routing logic. Decomposes requirements, dispatches tasks, processes completion reports, manages chain lifecycle |
| `MergeValidator` | Git merge validation on chain close. Handles conflict detection, abort, retry |
| `TaskRecovery` | Orphan detection and task requeue. Listens for worker_left events |
| `TaskOrchestrator` | Watches task queue for pending/claimed changes, emits task_created/task_claimed/task_completed events |
| `WorkerMonitor` | Watches instance registry for worker_joined/worker_left events |
| `ChainAudit` | Per-chain audit trail. Persists manifest.json + audit.jsonl + requirement.md |
| `MemoryBootstrap` | Workspace memory tree generation and refresh |
| `CommandWatcher` | Watches commands.jsonl for headless mode input |
| `StateWriter` | Serializes LeaderState to state.json for CLI inspection |
| `StreamTailer` | Watches log files for new content (used for Worker output streaming) |
| TUI (React/Ink) | 7-panel terminal UI with Tab/1-9 worker switching |

### ChainRouter Key Methods

| Method | Description |
|--------|-------------|
| `route(msg)` | Main entry point. Routes messages to handleRequirement, handleCompletionReport, or handleMemoryRefresh |
| `handleRequirement(msg)` | Decomposes requirement via ClaudeRunner, creates ChainDef, dispatches first task |
| `handleCompletionReport(msg)` | Processes EvalDecision: activate_next, feedback, close_chain, reject, spawn_chain |
| `handleSpawnChain(msg, decision)` | Closes parent chain, injects synthetic user_input for child chain |

### EvalDecision Routing

| Decision | Effect |
|----------|--------|
| `activate_next` | Leader creates next link's task, dispatches to idle Worker |
| `feedback` | Leader forwards feedback to previous link's Worker for rework |
| `close_chain` | Leader runs MergeValidator, closes chain as completed |
| `reject` | Leader aborts chain |
| `spawn_chain` | Leader closes parent, creates child chain (magic mode only) |

---

## @co/worker (Layer 4b)

Worker-side pipeline and evaluation.

### Classes

| Class | Description |
|-------|-------------|
| `WorkerWatcher` | 8-step pipeline: parse -> template -> hooks -> render -> execute -> commit -> evaluate -> report |
| `SelfEvaluator` | Evaluates Worker output via --fork-session, returns EvalDecision JSON |
| `CommitChecker` | Auto-commits changes with generated commit messages via --resume |
| `WorkerDocsCommitter` | Commits documentation changes to the CO root docs directory |
| `WorkerActivityReporter` | Batches and sends worker_activity messages to Leader |
| `OutputValidator` | Classifies Worker output (success, generation_failure, etc.) |

### WorkerWatcher 8-Step Pipeline

```
1. Parse incoming message (extract link, task_id, chain_id)
2. Select template by link (worker-{plan|execute|verify|review|accept|explore}.md)
3. Fire worker_message_start hook
4. Render template + identity prompt (via --append-system-prompt)
5. Execute main task -> ClaudeRunner.run() -> sessionId
6. CommitChecker.check() with --resume sessionId (auto-commit)
7. SelfEvaluator.evaluate() with --resume + --fork-session (3 retries on parse failure)
8. Send completion_report (EvalDecision JSON + commit info) to Leader
```

---

## @co/orchestrator (Layer 5)

Startup orchestration and process management.

### Classes

| Class | Description |
|-------|-------------|
| `runOrchestrator(input)` | 5-phase startup: init check -> worktree creation -> leader startup -> worker spawning -> shutdown handling |
| `InitChecker` | Validates config, skills, CLAUDE.md before startup |
| `WorktreeInitializer` | Creates isolated git worktrees for each Worker |
| `ChildSupervisor` | Forks Worker child processes with auto-restart (max 3 retries) |
| `InProcessSupervisor` | Runs Workers in-process (for testing and single-process mode) |
| `GracefulShutdown` | Phase-based shutdown with timeout enforcement |

### runOrchestrator() Phases

```
1. Load config, create logger, validate protocol version
2. Run InitChecker (config, skills, CLAUDE.md verification)
3. Create isolated git worktrees for each Worker
4. Initialize Leader components (EventBus, State, ChainRouter, etc.)
5. Start Leader TUI
6. Fork Worker child processes via ChildSupervisor
7. Register signal handlers for graceful shutdown
```

### GracefulShutdown Phases

```
1. Stop task dispatch (TaskOrchestrator.stop())
2. Wait for in-flight tasks
3. Shutdown Workers (ChildSupervisor.shutdown())
4. Stop TUI
5. Stop state writer and command watcher
6. Restore console
7. Unregister from InstanceRegistry
8. Close ZkClient connection
```

---

## @co/cli (Layer 6)

CLI entry point using Commander.

### Commands

| Command | Description |
|---------|-------------|
| `run --worker <n>` | Launch orchestrator with N Workers |
| `config` | Print resolved configuration |
| `status` | Display full orchestrator state (headless) |
| `workers` | Display workers table (headless) |
| `tasks` | Display pending and in-progress tasks (headless) |
| `events [--tail <n>]` | Display event log (headless) |
| `messages <worker>` | Display message history for a worker (headless) |
| `chains` | Display active and completed chains (headless) |
| `send <message>` | Send a message to the orchestrator (headless) |
| `wait --task <id>` | Poll state until a task completes (headless) |
