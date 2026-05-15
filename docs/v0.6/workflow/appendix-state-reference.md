# 附录 — 状态速查（ZK 路径 / cache 文件 / Schema / 对照表 / hook）

> 纯结构化速查，方便实现/调试时快速定位。所有路径与字段都对照 `packages/` 源码现状。

## A. ZK 节点路径速查

来源：`packages/contracts/src/paths/zkPaths.ts`。

| 节点 | 路径模板 | 类型 | 写入方 | 读/Watch 方 |
|------|---------|------|--------|------------|
| 项目根 | `/claude-orchestrator`（默认）/ `/co/{project_id}` | PERSISTENT | mkdirp on connect | — |
| Leader 元数据 | `/claude-orchestrator/leader` | EPHEMERAL | Leader 启动时 | TUI / 监控 |
| Instances 容器 | `/claude-orchestrator/instances` | PERSISTENT | mkdirp on connect | WorkerMonitor |
| Instance 节点 | `/claude-orchestrator/instances/{instance_id}` | EPHEMERAL | 各 instance 启动时（含 `WorkerWatcher.processMessage` 入/出口的 `heartbeat({status:busy/idle})` 更新） | WorkerMonitor (child watch), ChainRouter findIdleWorkerByRole |
| Tasks 容器 | `/claude-orchestrator/tasks/{pending,claimed,completed}` | PERSISTENT | mkdirp on connect | TaskOrchestrator |
| Pending task | `/claude-orchestrator/tasks/pending/task-{NNNNNNNNNN}` | PERSISTENT_SEQUENTIAL | `TaskQueue.push()` | TaskQueue.claim/listPending, TaskOrchestrator watchPending |
| Claimed task | `/claude-orchestrator/tasks/claimed/{instance_id}-task-{NNNN}` | EPHEMERAL | `TaskQueue.claim()` / `claimById()` | TaskOrchestrator watchClaimed, TaskRecovery |
| Completed task | `/claude-orchestrator/tasks/completed/task-{NNNN}` | PERSISTENT | `TaskQueue.complete()` / `.fail()` | TaskQueue.retry, audit |
| Messages 容器 | `/claude-orchestrator/messages` | PERSISTENT | mkdirp on connect | — |
| Message dir | `/claude-orchestrator/messages/{instance_id}` | PERSISTENT | `MessageRouter.send()` mkdirp | LeaderWatcher / WorkerWatcher waitForMessage |
| Message 节点 | `/claude-orchestrator/messages/{instance_id}/msg-{NNNNNNNNNN}` | PERSISTENT_SEQUENTIAL | `MessageRouter.send()` | Watcher 拉取，poll 标 read=true |

ZK 文件常量：`packages/contracts/src/paths/zkPaths.ts`。

## B. Cache 文件路径速查

来源：`packages/contracts/src/paths/cachePaths.ts`，路径基底 `{projects_root}/{leader_instance_id}/`（默认 `projects_root = ~/.claude-orchestrator/projects`）。

### B.1 路径函数

| 函数 | 路径模板 | 写入方 |
|------|---------|--------|
| `coRootDir(o)` | `<projects_root>/<leader_instance_id>` | 顶层目录 |
| `chainDir(o, chainId)` | `<root>/chains/<chain_id>` | ChainAudit / ChainRouter |
| `chainRequirementPath(o, chainId)` | `<chainDir>/requirement.md` | `ChainRouter.handleTaskDefinitions` 持久化原始需求 |
| `chainManifestPath(o, chainId)` | `<chainDir>/manifest.json` | `ChainAudit.openChain` / `setLinkTask` / `setLinkWorker` / `closeChain` |
| `chainAuditPath(o, chainId)` | `<chainDir>/audit.jsonl` | `ChainAudit.record` append-only |
| `taskDir(o, taskId)` | `<root>/tasks/<task_id>` | 每个 task 独立子目录 |
| `taskDefinitionPath(o, taskId)` | `<taskDir>/definition.md` | （函数已定义；当前未在主路径写入，预留给未来 task 文档生成） |
| `taskLogPath(o, taskId, ts)` | `<taskDir>/exec-<ts>.log` | `WorkerWatcher.processTask` 主执行 stream-json |
| `taskResultPath(o, taskId)` | `<taskDir>/result.md` | Worker → claude 写入 |
| `evalLogPath(o, taskId, n)` | `<taskDir>/eval-<n>.log` | `SelfEvaluator.evaluate` |
| `commitLogPath(o, taskId)` | `<taskDir>/commit.log` | `CommitChecker.generateMessage` |
| `messageDir(o, msgId)` | `<root>/messages/<message_id>` | 每条入站消息独立子目录 |
| `messageLogPath(o, msgId)` | `<messageDir>/inbound.log` | `ChainRouter.handleRequirement` decompose claude-cli 日志 |
| `decomposeResultPath(o, msgId)` | `<messageDir>/decompose.md` | `ChainRouter.handleRequirement` decompose 产物（issue #5）|
| `workerLocalDocPath(o, name, date, prefix, key)` | `<root>/docs/<name>/<date>/<prefix>-<key>.md` | Worker 写自留备份（local_doc_path）|

✅ **issue #8 修复**：cache 路径函数不再附加 `task-` 前缀（taskId 自带）。锁定行为见 `packages/contracts/tests/core/unit/paths.test.ts`。

✅ **本轮治理**：原 `taskDocPath(seq)` 已不再用（task_doc_path 字段已从 schema 移除）。

### B.2 一次链路的 cache 终态（贯穿样例 `chain-pagination-001`）

```
~/.claude-orchestrator/projects/leader-01/
├── chains/chain-pagination-001/
│   ├── requirement.md                   ← 原始用户需求
│   ├── manifest.json                    ← link_tasks + link_workers + status="completed"
│   └── audit.jsonl                      ← 全程事件流（~15 行）
├── messages/msg-0000000001/             ← 一条入站消息一个子目录
│   ├── inbound.log                       ← decompose claude-cli stream-json
│   └── decompose.md                     ← ChainDef JSON
├── tasks/task-0000000001/                ← plan (Tom)
│   ├── exec-<ts>.log                     ← 主执行 claude-cli 日志
│   ├── result.md                        ← blueprint.md
│   ├── commit.log                       ← commit message claude 调用日志
│   ├── eval-0.log, eval-0.log.result.md ← self-eval 第 1 次
│   ├── eval-1.log, eval-1.log.result.md ← self-eval 第 2 次（视重试）
│   └── eval-2.log, eval-2.log.result.md ← self-eval 第 3 次（视重试）
├── tasks/task-0000000002/                ← build (Jerry)
├── tasks/task-0000000003/                ← verify (Lucy)
├── tasks/task-0000000004/                ← review (Mia)
├── tasks/task-0000000005/                ← accept (Leo)
│   (结构同 task-0000000001/)
└── docs/<worker>/<date>/                 ← workerLocalDocPath 副本
    ├── Leader/2026-05-14/chain-def.json
    ├── Tom/2026-05-14/plan-chain-pagination-001.md
    ├── Jerry/2026-05-14/build-chain-pagination-001.md
    ├── Lucy/2026-05-14/verify-chain-pagination-001.md
    ├── Mia/2026-05-14/review-chain-pagination-001.md
    └── Leo/2026-05-14/accept-chain-pagination-001.md
```

## C. Zod Schema 速查

来源：`packages/contracts/src/schemas/*.ts`，`enums.ts`。

### C.1 Message — `packages/contracts/src/schemas/message.ts`

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| id | string → MessageId | "" | ZK 节点名 |
| type | enum | "direct" | direct / broadcast / task_dispatch / completion_report / user_input / help |
| from_instance | string → InstanceId | （必填） | |
| from_name | string | （必填） | |
| from_role | string | "" | |
| to_instance | string → InstanceId / null | null | |
| to_name | string / null | null | |
| content | string | （必填） | 主体 / JSON 字符串 |
| link | enum / null | null | plan / build / verify / review / accept |
| task_id | string → TaskId / null | null | |
| chain_id | string → ChainId / null | null | |
| task_title | string / null | null | |
| task_description | string / null | null | ✅ #9 修复后 ChainDef.description 透传到 task_dispatch |
| task_criteria | string / null | null | ✅ #9 修复后同 task_description |
| result_path | string / null | null | |
| original_requirement_path | string / null | null | 指向 `chains/<id>/requirement.md`，让 worker 读原始需求 |
| reply_to | string → MessageId / null | null | |
| read | boolean | false | poll 时回写 true |
| created_at | string (ISO8601) | （必填） | |

✅ **本轮治理**：`task_doc_path` 字段已删除。Zod strip 模式：旧 ZK 节点反序列化时多余的 `task_doc_path` 字段会被静默丢弃。

### C.2 Task — `packages/contracts/src/schemas/task.ts`

| 字段 | 类型 | 默认 |
|------|------|------|
| id | string → TaskId | "" |
| title | string | （必填） |
| description | string | "" |
| criteria | string | "" | ✅ #9 新增——把 ChainDef 的 criteria 持久化到 Task |
| priority | int 0..2 | 1 |
| status | enum | "pending"（pending / claimed / completed / failed） |
| link | enum / null | null |
| chain_id | string → ChainId / null | null |
| result_path | string / null | null |
| retry_count | int >=0 | 0 |
| fail_reason | string / null | null |
| created_by | InstanceId / null | null |
| created_by_name | string | "" |
| assigned_to | InstanceId / null | null |
| assigned_to_name | string / null | null |
| claimed_by | InstanceId / null | null |
| completed_by_name | string / null | null |
| created_at | string | （必填） |
| claimed_at | string / null | null |
| completed_at | string / null | null |
| duration_seconds | number / null | null |
| leader_only | boolean | false |
| result | string / null | null |

✅ **本轮治理**：`task_doc_path` / `depends_on` / `blocked_by` / `blocked_reason` 字段已删除，`TaskStatus.blocked` 也已删除（`ITaskQueue.block()` 方法同步移除）。

### C.3 ChainDef — `packages/contracts/src/schemas/chain.ts`

```typescript
ChainDefSchema = {
  chain_id: string → ChainId,
  chain_title: string,
  tasks: {
    plan: ChainTaskDef | null,           // 可空
    build: ChainTaskDef,                 // 必填
    verify: ChainTaskDef,                // 必填
    review: ChainTaskDef,                // 必填
    accept: ChainTaskDef,                // 必填
  }
}
ChainTaskDefSchema = {
  title: string,
  description: string,
  criteria: string,
  priority: int 0..2,
}
```

### C.4 EvalDecision — `packages/contracts/src/schemas/eval.ts`

Discriminated union by `decision`：

```typescript
| { decision: "activate_next", reason, next_link, suggested_worker?: InstanceId | null }
| { decision: "feedback",      reason, feedback_to_worker, feedback_target?: InstanceId | null }
| { decision: "reject",        reason }
| { decision: "close_chain",   reason }
```

✅ **issue #3 修复**：模板 `worker-evaluate.md` 与 `worker-evaluate-format-hint.md` 已统一为 snake_case (`next_link / suggested_worker / feedback_to_worker / feedback_target`)，并补 `reject` 选项。

### C.5 ChainManifest — `packages/leader/src/chain-audit.ts`

`<co_root>/chains/<chain_id>/manifest.json` 内容：

| 字段 | 类型 | 说明 |
|------|------|------|
| chain_id | ChainId | 链 id |
| created_at | string | openChain 时刻 |
| completed_at | string / null | closeChain 时刻；running 状态为 null |
| status | "running" / "completed" / "failed" / "aborted" | reject → aborted；close_chain → completed |
| leader_id | InstanceId | 创建该链的 Leader 实例 |
| leader_name | string | 同上 |
| requirement_path | string | `chains/<id>/requirement.md` 绝对路径 |
| link_tasks | Record<TaskLink, TaskId \| null> | 每个 link 当前对应的 task_id（feedback retry 后会被替换为新 task_id） |
| link_workers | Record<TaskLink, InstanceId \| null> | 每个 link 当前对应的 worker_id（本轮新增；replaces 内存 chainWorkers Map） |

ChainAudit 事件类型（`ChainAuditEventType`）：

```
requirement_received | chain_opened | task_dispatch |
completion_report | feedback_sent | chain_closed | validation_failure
```

每条事件 append 到 `<co_root>/chains/<chain_id>/audit.jsonl` 一行 JSON：

```json
{
  "ts": "...",
  "chain_id": "...",
  "event": "...",
  "link": "plan" | "build" | ... | null,
  "worker_id": "tom-01" | null,
  "worker_name": "Tom" | null,
  "task_id": "task-..." | null,
  "payload": { ... } | null
}
```

### C.6 CommitResult — `packages/worker/src/commit-checker.ts`

```typescript
{
  sha: string,
  message: string,
  changed_files: string[],
  untracked_files: string[],
}
```

完成报告把 `commit` 字段合并到 EvalDecision JSON 中（见 `02` §5.8.4）。

### C.7 MergeDecision — `packages/contracts/src/schemas/merge.ts`

```typescript
{
  decision: "merge" | "skip" | "review_first",
  reason: string,
}
```

## D. link ↔ template ↔ role ↔ skill 对照

| link | role | system prompt | per-task wrapper | skill | 典型产出 | 最优 role 权重 |
|------|------|---------------|------------------|-------|---------|---------------|
| plan | planner | `worker-planner.md` | `worker-planner-task.md` | `task-planning` | `blueprint.md` | planner=100 |
| build | builder | `worker-builder.md` | `worker-builder-task.md` | `task-execution` | `traceability-map.md` + `evidence/` | builder=100 |
| verify | verifier | `worker-verifier.md` | `worker-verifier-task.md` | `task-verification` | `verification-map.md` + `evidence/` | verifier=100 |
| review | reviewer | `worker-reviewer.md` | `worker-reviewer-task.md` | `task-review` | `review-judgment.md` | reviewer=100 |
| accept | accepter | `worker-accepter.md` | `worker-accepter-task.md` | `task-acceptance` | `acceptance-report.md` | accepter=100 |

`LINK_TO_TASK_TEMPLATE` 映射定义在 `packages/worker/src/watcher.ts:30-37`。每个 worker 启动时（boot）一次性载入 `worker-{role}.md`（system prompt 第二段，常驻）+ `personal-claude-{role}.md`（已渲染 `{{name}}`，作为 identity 第三段）。每次任务再渲染 per-task wrapper 作为 user message。

辅助模板（不直接对应某个 link 的主任务）：

| 模板 | 调用方 | 用途 |
|------|--------|------|
| `worker-identity.md` | `ClaudeRunner.buildIdentityPrompt` | 拼接 system prompt 第一段（身份卡） |
| `worker-decompose.md` | `ChainRouter.handleRequirement`（Leader 自处理） | 需求拆解为 ChainDef |
| `worker-evaluate.md` | `SelfEvaluator.evaluate` | 每个 link 完成后自评估 |
| `worker-evaluate-format-hint.md` | `SelfEvaluator.evaluate`（attempt > 0） | 校正格式 |
| `worker-commit-message.md` | `CommitChecker.generateMessage` | 生成 git commit message |
| `worker-merge-decision.md` | `MergeValidator.askDecision` | 合并决策（close_chain 时自动遍历调用） |

✅ **本轮治理**：`worker-task-doc.md` 模板已删除。

Claude memory 模板（在 worktree-initializer 时拷贝到 worker worktree、`{{name}}`/`{{role}}` 已替换）：

| 文件 | 用途 |
|------|------|
| `templates/claude-memory/personal-claude-planner.md` | Planner 角色规则 |
| `personal-claude-builder.md` | Builder 角色规则 |
| `personal-claude-verifier.md` | Verifier 角色规则 |
| `personal-claude-reviewer.md` | Reviewer 角色规则 |
| `personal-claude-accepter.md` | Accepter 角色规则 |
| `team-claude.md` | 团队整体规则（所有角色共享） |
| `templates/user-global-claude.md` | 全局工作空间规则 |

## E. Hook 事件速查

来源：`packages/contracts/src/hooks.ts`。

| HookEventType | 触发方 | 主要环境变量 |
|---------------|--------|------------|
| `leader_message_start` | Leader 处理消息开始 | CO_LEADER_ID, CO_MESSAGE_ID, CO_LINK, CO_LOG_PATH |
| `leader_message_end` | Leader 处理消息结束 | 同上 + exit_code |
| `worker_message_start` | `WorkerWatcher.processTask` 渲染 prompt 前 | CO_WORKER_NAME, CO_WORKER_ID, CO_TASK_ID, CO_LINK, CO_CHAIN_ID, CO_LOG_PATH, CO_RESULT_PATH |
| `worker_message_end` | `WorkerWatcher.processTask` 在 runner.run 之后 commit/eval 之前 | 同上 + exit_code |
| `task_claimed` | `WorkerWatcher.processTask` 在 `task_queue.claimById` 成功后 ✅ 本轮新增触发 | CO_WORKER_NAME, CO_WORKER_ID, CO_TASK_ID, CO_LINK, CO_CHAIN_ID |
| `task_completed` | `WorkerWatcher.processTask` 在 `task_queue.complete` 成功后 ✅ 本轮新增触发 | 同上 + duration_seconds |
| `chain_activated` | `ChainRouter.handleTaskDefinitions` | CO_CHAIN_ID |
| `merge_decision_made` | `MergeValidator.validate` 决策完成（按需触发） | CO_DECISION, CO_BRANCH, CO_REASON |

`HookEngine` 实现：`packages/runtime/src/hook-engine.ts`。

✅ **本轮治理**：`TaskHookEnv` 扩展加 `CO_WORKER_NAME` / `CO_WORKER_ID`，与 `WorkerMessageEnv` 对齐，shell 脚本可直接消费 worker 上下文。

### E.1 Hook 触发顺序（一次 Worker 任务）

```
1. heartbeat({status:"busy", current_task_id})  ← Worker 心跳 ZK（非 hook）
2. task_claimed                                 ← claimById 成功后
3. worker_message_start                         ← prompt 渲染前
4. <claude-cli main execution>
5. worker_message_end                           ← runner.run 完成 + 校验后
6. <commit-checker + self-evaluator>
7. <sendCompletionReport → ZK 写入>
8. task_completed                               ← task_queue.complete 成功后
9. heartbeat({status:"idle", current_task_id:null})  ← Worker 心跳 ZK（非 hook，finally 兜底）
```

## F. ChainRouter 路由判定速查

`packages/leader/src/chain-router.ts` `route()`：

```
if (!msg.link)                                              → handleRequirement
else if (link === "plan" && type === "completion_report")   → handleCompletionReport
else if (looksLikeChainDef(msg.content))                    → handleTaskDefinitions
else                                                        → handleCompletionReport
```

判定以 `msg.link` 为首要字段（null link 视为需求；非 null link 进一步看 type / 内容）。这是有意的设计简化，对应消息类型在 `type` 字段已唯一编码（task_dispatch / completion_report / user_input），不需要按内容嗅探。

## G. ClaudeRunner 命令形态速查

`packages/runtime/src/runner.ts` + `@co/infra`(execWithStreaming)：

```bash
[cd <cwd>]
<command> \
  [--append-system-prompt '<system_prompt>'] \
  [--resume <resume_session_id>] \
  [--fork-session] \
  -p '<prompt>' \
  --output-format stream-json --verbose \
  > <log_path>
```

返回：

```
{
  exit_code: number,
  session_id: SessionId | null,    // 从 stream-json 第一行 system/init 抽取
  log_path: string,
}
```

参数来源：

| 参数 | 字段 |
|------|------|
| `--append-system-prompt` | `RunOptions.system_prompt`（Worker 处理时 = identity card；Leader decompose 时无） |
| `--resume` | `RunOptions.resume_session_id`（CommitChecker / SelfEvaluator 复用主任务 session） |
| `--fork-session` | `RunOptions.fork_session`（SelfEvaluator 每次重试都 true） |
| `cwd` | Worker 主执行用 `worktree_path`；Leader 自处理 decompose 用 `process.cwd()` |
| `quiet` | Worker 主执行 / commit / eval 都 true（不打印到 stdout，只走 log） |

## H. ChainRouter 内部状态

`ChainRouter` 实例字段（`packages/leader/src/chain-router.ts`）：

| 字段 | 类型 | 持久化 | 用途 |
|------|------|-------|------|
| `chainCommits` | `Map<ChainId, CommitInfo[]>` | 内存（leader 进程内）| 收集每环 commit envelope，`close_chain` 时按 plan→build→verify→review→accept 顺序遍历调 `MergeValidator.validate` |

✅ **本轮治理**：原 `chainWorkers: Map<ChainId, Map<TaskLink, InstanceId>>` 已**删除**，统一改写到 ChainAudit manifest 的 `link_workers` 字段（持久化到 `chains/<chain_id>/manifest.json`）；`resolveFeedbackTarget` 读 manifest 决定 prev-link worker，Leader 重启可恢复映射。

`chainCommits` 仍是内存的（commit 数据从 worker 的 `completion_report` 拿到，本身随消息处理在线推进）。Leader 重启会丢失尚未触发 close_chain 的 commit 记录；这是已知接受的边界（重启后需要重新跑链或人工补 merge）。

## I. 完成报告 envelope

Worker 在 `sendCompletionReport` 中，把 EvalDecision JSON 与 commit 信息合并：

```json
{
  "decision": "activate_next" | "feedback" | "reject" | "close_chain",
  "reason": "...",
  /* discriminated union fields ... */
  "commit": {
    "sha": "...",
    "message": "...",
    "branch": "co/<worker>",
    "changed_files": [...],
    "untracked_files": [...]
  }
}
```

ChainRouter 端 `EvalDecisionSchema.safeParse` 走 zod strip 模式，`commit` 字段被静默丢弃，仅解析出 decision/reason/discriminated-union 字段；同时 `recordCommit` 从原始 raw object 中抽取 commit 入 chainCommits。

## J. ZK Watch 监听清单

| Watcher | 路径 | 回调 |
|---------|------|------|
| LeaderWatcher | `/messages/{leader_id}` | `processMessage → ChainRouter.route` |
| WorkerWatcher | `/messages/{worker_id}` | `processMessage → processTask` |
| WorkerMonitor | `/instances` | emit `worker_joined` / `worker_left` |
| TaskOrchestrator (pending) | `/tasks/pending` | emit `task_created` |
| TaskOrchestrator (claimed) | `/tasks/claimed` | emit `task_claimed` / `task_completed`（基于子节点出现/消失） |
| TaskRecovery | `/tasks/claimed` 通过 ephemeral 自动清理感知 worker 离线 | re-push 或 fail |

LeaderEventBus 事件（`packages/contracts/src/events.ts`）：

```
worker_joined / worker_left / task_created / task_claimed / task_completed /
chain_activated / chain_closed / message_received / message_processed / debug_info
```

ChainRouter 仅 emit `chain_activated`（handleTaskDefinitions 首次入队 5 个 task 时）和 `chain_closed`（reject / close_chain 时）。链路推进的细粒度事件（task_dispatch、feedback_sent 等）记录在 `chains/<chain_id>/audit.jsonl`，需要时可按 ts 时间戳线性回放。
