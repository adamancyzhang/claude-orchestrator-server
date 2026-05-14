# 附录 — 状态速查（ZK 路径 / cache 文件 / Schema / 对照表 / hook）

> 纯结构化速查，方便实现/调试时快速定位。所有路径与字段都对照 `packages/` 源码现状。

## A. ZK 节点路径速查

来源：`packages/contracts/src/paths/zkPaths.ts`。

| 节点 | 路径模板 | 类型 | 写入方 | 读/Watch 方 |
|------|---------|------|--------|------------|
| 项目根 | `/claude-orchestrator`（默认）/ `/co/{project_id}` | PERSISTENT | mkdirp on connect | — |
| Leader 元数据 | `/claude-orchestrator/leader` | EPHEMERAL | Leader 启动时 | TUI / 监控 |
| Instances 容器 | `/claude-orchestrator/instances` | PERSISTENT | mkdirp on connect | WorkerMonitor |
| Instance 节点 | `/claude-orchestrator/instances/{instance_id}` | EPHEMERAL | 各 instance 启动时 | WorkerMonitor (child watch), ChainRouter findIdleWorkerByRole |
| Tasks 容器 | `/claude-orchestrator/tasks/{pending,claimed,completed}` | PERSISTENT | mkdirp on connect | TaskOrchestrator |
| Pending task | `/claude-orchestrator/tasks/pending/task-{NNNNNNNNNN}` | PERSISTENT_SEQUENTIAL | `TaskQueue.push()` | TaskQueue.claim/list, TaskOrchestrator watchPending |
| Claimed task | `/claude-orchestrator/tasks/claimed/{instance_id}-task-{NNNN}` | EPHEMERAL | `TaskQueue.claim()` | TaskOrchestrator watchClaimed, TaskRecovery |
| Completed task | `/claude-orchestrator/tasks/completed/task-{NNNN}` | PERSISTENT | `TaskQueue.complete()` / `.fail()` | TaskQueue.retry, audit |
| Messages 容器 | `/claude-orchestrator/messages` | PERSISTENT | mkdirp on connect | — |
| Message dir | `/claude-orchestrator/messages/{instance_id}` | PERSISTENT | `MessageRouter.send()` mkdirp | LeaderWatcher / WorkerWatcher waitForMessage |
| Message 节点 | `/claude-orchestrator/messages/{instance_id}/msg-{NNNNNNNNNN}` | PERSISTENT_SEQUENTIAL | `MessageRouter.send()` | Watcher 拉取，poll 标 read=true |

ZK 文件常量：`packages/contracts/src/paths/zkPaths.ts`。

## B. Cache 文件路径速查

来源：`packages/contracts/src/paths/cachePaths.ts`，路径基底 `{cache_dir}/{leader_instance_id}/`。

| 函数 | 路径模板 | 写入方 |
|------|---------|--------|
| `taskDocPath(seq)` | `tasks/task-{seq}.md` | ⚠️ 当前 ChainRouter 没有调用（task_doc 未实现） |
| `taskLogPath(taskId, ts)` | `logs/{taskId}-{ts}.log` | `WorkerWatcher.processMessage` |
| `taskResultPath(taskId)` | `results/{taskId}.md` | Worker → claude 写入 |
| `evalLogPath(taskId, attempt)` | `evals/{taskId}-attempt-{N}.log` | `SelfEvaluator.evaluate` |
| `commitLogPath(taskId)` | `commits/{taskId}.log` | `CommitChecker.generateMessage` |
| `messageLogPath(messageId)` | `messages/{messageId}.log` | `ChainRouter.handleRequirement`（Leader 自处理 decompose） |

✅ **issue #8 修复**：cache 路径函数原本在模板里硬编码 `task-` 前缀，叠加 task_queue 生成的 `task-NNNN` 形成双前缀（`task-task-NNNN`）。修复后 cache 函数不再附加 `task-`，直接拼 `${taskId}`；`taskDocPath(seq)` 例外，因为 seq 是数字。锁定行为见 `packages/contracts/tests/core/unit/paths.test.ts`。

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
| task_description | string / null | null | ✅ #9 修复后 chain 首环 task_dispatch 携带；activate_next 派发的后续 link 在 #4 落地前为空字符串 |
| task_criteria | string / null | null | ✅ #9 修复后同 task_description |
| task_doc_path | string / null | null | ⚠️ 当前 ChainRouter 仍未生成 task 文档，详见现状⚠️ 残留 |
| result_path | string / null | null | |
| reply_to | string → MessageId / null | null | |
| read | boolean | false | poll 时回写 true |
| created_at | string (ISO8601) | （必填） | |

### C.2 Task — `packages/contracts/src/schemas/task.ts`

| 字段 | 类型 | 默认 |
|------|------|------|
| id | string → TaskId | "" |
| title | string | （必填） |
| description | string | "" |
| criteria | string | "" | ✅ #9 新增——把 ChainDef 的 criteria 持久化到 Task |
| priority | int 0..2 | 1 |
| status | enum | "pending"（pending / claimed / completed / blocked / failed） |
| link | enum / null | null |
| chain_id | string → ChainId / null | null |
| task_doc_path | string / null | null |
| result_path | string / null | null |
| retry_count | int >=0 | 0 |
| depends_on | TaskId[] | [] |
| blocked_by | TaskId[] | [] |
| blocked_reason | string / null | null |
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

### C.5 CommitResult — `packages/worker/src/commit-checker.ts:13-18`

```typescript
{
  sha: string,
  message: string,
  changed_files: string[],
  untracked_files: string[],
}
```

完成报告把 `commit` 字段合并到 EvalDecision JSON 中（见 `02` §5.8）。

### C.6 MergeDecision — `packages/contracts/src/schemas/merge.ts`

```typescript
{
  decision: "merge" | "skip" | "review_first",
  reason: string,
}
```

## D. link ↔ template ↔ role ↔ skill 对照

| link | role | 主任务模板 | skill | 典型产出 | role-link 权重表（最优 role） |
|------|------|-----------|-------|---------|------------------------------|
| plan | planner | `worker-plan.md` | `task-planning` | `blueprint.md` | planner=100 |
| build | builder | `worker-build.md` | `task-execution` | `traceability-map.md` + `evidence/` | builder=100 |
| verify | verifier | `worker-verify.md` | `task-verification` | `verification-map.md` + `evidence/` | verifier=100 |
| review | reviewer | `worker-review.md` | `task-review` | `review-judgment.md` | reviewer=100 |
| accept | accepter | `worker-accept.md` | `task-acceptance` | `acceptance-report.md` | accepter=100 |

辅助模板（不直接对应某个 link 的主任务）：

| 模板 | 调用方 | 用途 |
|------|--------|------|
| `worker-identity.md` | `ClaudeRunner.buildIdentityPrompt` | 拼接 system prompt 第一段（身份卡） |
| `worker-decompose.md` | `ChainRouter.handleRequirement`（Leader 自处理） / WorkerWatcher.processMessage（link=decompose 转发分支） | 需求拆解为 ChainDef |
| `worker-evaluate.md` | `SelfEvaluator.evaluate` | 每个 link 完成后自评估 |
| `worker-evaluate-format-hint.md` | `SelfEvaluator.evaluate`（attempt > 0） | 校正格式 |
| `worker-commit-message.md` | `CommitChecker.generateMessage` | 生成 git commit message |
| `worker-task-doc.md` | ⚠️ 当前未在 ChainRouter 中调用 | 任务文档生成（设计预期） |
| `worker-merge-decision.md` | `MergeValidator.askDecision` | 合并决策（按需触发） |

Claude memory 模板（拼接到 identity system prompt 中）：

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
| `worker_message_start` | `WorkerWatcher.processMessage` 开始 | CO_WORKER_NAME, CO_WORKER_ID, CO_TASK_ID, CO_LINK, CO_CHAIN_ID, CO_LOG_PATH, CO_RESULT_PATH |
| `worker_message_end` | `WorkerWatcher.processMessage` 在 runner.run 之后 commit/eval 之前 | 同上 + exit_code |
| `task_claimed` | `TaskQueue.claim` 成功（⚠️ 现状未在主路径触发） | CO_TASK_ID, CO_LINK, CO_CHAIN_ID |
| `task_completed` | `TaskQueue.complete` 成功（⚠️ 现状未在主路径触发） | 同上 + duration_seconds |
| `chain_activated` | `ChainRouter.handleTaskDefinitions` | CO_CHAIN_ID |
| `merge_decision_made` | `MergeValidator.validate` 决策完成（按需触发） | CO_DECISION, CO_BRANCH, CO_REASON |

`HookEngine` 实现：`packages/runtime/src/hook-engine.ts`。

## F. ChainRouter 路由判定速查

`packages/leader/src/chain-router.ts:58-72` `route()`：

```
if (!msg.link)                                              → handleRequirement
else if (link === "plan" && type === "completion_report")   → handleCompletionReport
else if (looksLikeChainDef(msg.content))                    → handleTaskDefinitions
else                                                        → handleCompletionReport
```

⚠️ 这一判定**与 `core/01-requirement-to-tasks.md` §4 描述的"三优先级 EvalDecision → ChainDef → 自由文本"不一致**。当前以 `msg.link` 字段为首要判别。

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

## H. 一次链路的 Cache 文件总览（贯穿样例 `chain-pagination-001`）

```
~/.claude-orchestrator/cache/leader-01/
├── messages/
│   └── msg-0000000001.log
├── decompose/
│   └── msg-0000000001.md
├── results/
│   ├── task-0000000001.md
│   ├── task-0000000006.md
│   ├── task-0000000007.md
│   ├── task-0000000008.md
│   └── task-0000000009.md
├── logs/
│   ├── task-0000000001-<ts>.log
│   ├── task-0000000006-<ts>.log
│   ├── task-0000000007-<ts>.log
│   ├── task-0000000008-<ts>.log
│   └── task-0000000009-<ts>.log
├── commits/
│   ├── task-0000000001.log
│   ├── task-0000000006.log
│   ├── task-0000000007.log
│   ├── task-0000000008.log
│   └── task-0000000009.log
└── evals/
    ├── task-0000000001-attempt-{0,1,2}.log
    ├── task-0000000001-attempt-{0,1,2}.log.result.md
    ├── task-0000000006-attempt-{0,1,2}.log[.result.md]
    ├── task-0000000007-attempt-{0,1,2}.log[.result.md]
    ├── task-0000000008-attempt-{0,1,2}.log[.result.md]
    └── task-0000000009-attempt-{0,1,2}.log[.result.md]
```

约 35 个文件（按每个 task 最多 6 个 cache 文件 + 全局 decompose 计算）。
