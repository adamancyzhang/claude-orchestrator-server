# 09 — ChainAudit、Cache 与可观测

> **DD 定位**：v0.7 的"持久化与可观测"层 —— ChainAudit 的 API、manifest 字段全表、audit.jsonl 事件类型、Cache 目录布局、4 类 lifecycle hook 与 `CO_*` env、TUI 渲染挂钩。
>
> **PRD 锚**：`docs/v0.7/prd/04-functional-requirements.md` FR-14 / FR-20 / FR-26 / FR-27 / FR-35；`docs/v0.7/prd/05-non-functional.md` §5（可观测性）。
>
> **Schema 真相源**：所有结构以 `02-contracts-and-protocol.md` §6 / §13 为准。本文聚焦"如何写 / 何时写 / 写在哪"。

---

## 1. ChainAudit 模块

### 1.1 三件套布局

每条 chain 占一个目录：

```
<cache_dir>/projects/<leader_id>/chains/<chain_id>/
├── manifest.json     ← 单文件 JSON，原子覆写（write to *.tmp + rename）
├── audit.jsonl       ← append-only，一行一个 AuditEvent
└── requirement.md    ← 用户原始需求文本（首链：TUI 输入；子链：Explorer 的 next_requirement）
```

> 写入时序保证：`appendAudit` 必须先 fsync 落盘，再触发对应的 LeaderEventBus 事件。这避免"事件已 emit 但 audit 缺失"的不一致。

### 1.2 ChainAudit 公共 API

```ts
export interface ChainAudit {
  // —— 创建与读取
  openChain(
    chainId: ChainId,
    requirement: string,
    options: {
      magic_mode: boolean;                  //
      parent_chain_id: ChainId | null;      //
      chain_depth: number;                  //
      max_total_retries?: number;           // 默认 9，CO_CHAIN_MAX_RETRIES 覆写
    },
  ): Promise<ChainManifest>;
  // ↑ 若 chains/<chain_id>/manifest.json 已存在且 status ∈ {completed, aborted, merge_failed, failed}
  //   抛 ChainConflictError（FR-20）。

  readManifest(chainId: ChainId): Promise<ChainManifest | null>;

  closeChain(
    chainId: ChainId,
    status: 'completed' | 'aborted' | 'merge_failed' | 'failed',
    extra?: {
      reason?: string;                                            // aborted 时落 audit.jsonl `chain_closed.detail.reason`
      failures?: Array<{ link: TaskLink; branch: string; error: string; category?: string }>;
                                                                  // merge_failed 时落 audit.jsonl `merge_failure` 事件 payload
      child_chain_id?: ChainId;                                   // spawn_chain 时同步 append 到 manifest.child_chain_ids
    },
  ): Promise<ChainManifest>;

  // —— 中间态修改
  recordLinkTask(chainId: ChainId, link: TaskLink, taskId: TaskId): Promise<void>;
  recordLinkWorker(chainId: ChainId, link: TaskLink, instanceId: InstanceId): Promise<void>;
  incrementRetry(chainId: ChainId): Promise<number>;             // 返回新的 total_retry_count
  appendChildChain(chainId: ChainId, child: ChainId): Promise<void>; //

  // —— worktree 工作流（，与 02 §6.0 LinkCommitRecord 协同）
  recordLinkCommit(
    chainId: ChainId,
    link: TaskLink,
    commits: LinkCommitRecord,                         // { worktree, docs, branch }
  ): Promise<void>;
  // ↑ 由 Worker 完成任务后通过 completion_report 把 LinkCommitRecord 携带回 Leader，
  //   ChainRouter.handleCompletionReport 调用此方法落到 manifest.link_commits[link]。
  //   幂等：同 (chainId, link) 二次调用直接覆盖。

  collectUpstreamCommits(
    chainId: ChainId,
  ): Promise<UpstreamCommits>;
  // ↑ ChainRouter dispatchNextLink 前调用，构造仅含 worktree SHA 的 UpstreamCommits
  //   注入到 task_dispatch.upstream_commits + Task.upstream_commits。
  //   遍历顺序固定 plan → execute → verify → review → accept（accept 仅在 `--magic` 模式下供 explore link 消费）。
  //   `worktree == null` 的 link 自动跳过（典型：plan/verify/review 不动代码）。

  clearLinkCommitsFrom(
    chainId: ChainId,
    fromLink: TaskLink,
  ): Promise<void>;
  // ↑ feedback 决策时由 ChainRouter 调用：擦除 fromLink 及其下游 link 的 link_commits 记录，
  //   保证重试从干净的上游基线开始。顺序 plan → execute → verify → review → accept。
  //   例：fromLink='verify' → 擦除 verify / review / accept 三条记录。

  // —— 审计事件
  appendAudit(event: AuditEvent): Promise<void>;
}
```

> **三方法的代码归属**：`packages/leader/src/chain-audit.ts:218`（recordLinkCommit）/`:249`（collectUpstreamCommits）/`:268`（clearLinkCommitsFrom）。`LinkCommitRecord` 定义见 `02-contracts-and-protocol.md` §6.0；`UpstreamCommits` 定义见 §9。

### 1.3 manifest.json 字段全表

| 字段 | 类型 | 写入时机 | 写入者 |
|---|---|---|---|
| `chain_id` | ChainId | openChain | ChainAudit |
| `created_at` | ISO-8601 | openChain | ChainAudit |
| `completed_at` | ISO-8601 \| null | closeChain | ChainAudit |
| `status` | ChainStatus | open / close | ChainAudit |
| `link_tasks[link]` | TaskId | ChainRouter push 任务后 | ChainRouter |
| `link_workers[link]` | InstanceId | task_claimed 事件后 | ChainRouter（订阅 `task_claimed`） |
| **`link_commits[link]`** | LinkCommitRecord | Worker 任务完成 → completion_report 到达 | ChainRouter.handleCompletionReport（调 `recordLinkCommit`） |
| `total_retry_count` | int | incrementRetry | ChainRouter（feedback 派发前） |
| `max_total_retries` | int | openChain | ChainAudit（读 env） |
| `requirement_path` | string | openChain | ChainAudit |
| **`parent_chain_id`** | ChainId \| null | openChain | ChainAudit |
| **`child_chain_ids[]`** | ChainId[] | appendChildChain | ChainRouter（spawn_chain 时） |
| **`chain_depth`** | int | openChain | ChainAudit |
| **`magic_mode`** | boolean | openChain | ChainAudit |

> manifest 收窄为"链元数据 + 当前状态"。终态原因（如 abort reason、merge 冲突明细）只进 audit.jsonl：abort → `chain_closed.payload.reason`；merge 冲突 → `merge_failure.payload.{category,branch,sha,error}`。这样 manifest 字段集合保持稳定，所有 forensics 走 append-only 的 audit。

> Schema 见 `02-contracts-and-protocol.md` §6.2。

### 1.4 openChain 算法

```text
openChain(chainId, requirement, opts):
  ensureDir(<cache>/chains/<chainId>/)
  existing = readManifest(chainId)
  if existing != null:
    if existing.status == 'running':
      // 同 chain_id 复用（极少见，理论上 chain_id 由时间戳+随机串保证唯一）
      // 但 v0.7 仍保留对幂等 reopen 的拒绝
      throw ChainConflictError(chainId, 'running')
    if existing.status ∈ {completed, aborted, merge_failed, failed}:
      throw ChainConflictError(chainId, existing.status)   // FR-20
  manifest = {
    chain_id: chainId,
    created_at: now(),
    completed_at: null,
    status: 'running',
    link_tasks: {},
    link_workers: {},
    total_retry_count: 0,
    max_total_retries: opts.max_total_retries ?? envInt('CO_CHAIN_MAX_RETRIES', 9),
    requirement_path: '<cache>/chains/<chainId>/requirement.md',
    parent_chain_id: opts.parent_chain_id,
    child_chain_ids: [],
    chain_depth: opts.chain_depth,
    magic_mode: opts.magic_mode,
  }
  writeFile(<cache>/chains/<chainId>/requirement.md, requirement)
  writeManifestAtomic(manifest)
  appendAudit({ event_type: 'chain_opened', chain_id, detail: { magic_mode, parent_chain_id, chain_depth } })
  return manifest
```

> `writeManifestAtomic` = `fs.writeFile(path + '.tmp', json); fs.rename(path + '.tmp', path)`。

### 1.5 closeChain 算法

```text
closeChain(chainId, status, extra):
  manifest = readManifest(chainId)  // 必须存在且 status='running'
  manifest.status = status
  manifest.completed_at = now()
  if extra.child_chain_id:
    manifest.child_chain_ids.push(extra.child_chain_id)
  writeManifestAtomic(manifest)
  // extra.reason / extra.failures 不进 manifest，仅落 audit.jsonl 的 chain_closed.detail
  appendAudit({ event_type: 'chain_closed', chain_id, detail: { status, ...extra } })
  emit LeaderEventBus 'chain_closed' { chain_id, status }
  if status == 'merge_failed':
    emit LeaderEventBus 'chain_merge_failed' { chain_id, failures: extra.failures ?? [] }
  return manifest
```

> 调用者：
> - `close_chain` EvalDecision → ChainRouter.runMergeValidation（详见 `07-merge-validator-and-closure.md` §3）
> - `spawn_chain` EvalDecision → 与 close_chain 同链路，额外传 `child_chain_id`（详见 `10-magic-loop.md` §4）
> - SelfEvaluator 三连失败 / 任意 link `reject` → ChainRouter 直接 `closeChain(chainId, 'aborted', { reason })`（详见 `05-chain-router-and-decisions.md` §4.3）
> - 反馈累计超 `max_total_retries` → `closeChain(chainId, 'aborted', { reason: 'retry_ceiling_exceeded' })`（FR-18）

---

## 2. ChainConflictError 处理路径

```mermaid
sequenceDiagram
  participant TUI as TUI / user_input
  participant CR as ChainRouter
  participant CA as ChainAudit
  participant EB as LeaderEventBus

  TUI->>CR: handleRequirement(content, chain_id?=X)
  CR->>CA: openChain(X, content, ...)
  alt manifest 已存在且终态
    CA-->>CR: throw ChainConflictError
    CR->>CA: appendAudit('chain_id_conflict', { existing_status })
    CR->>EB: emit debug_info("chain X already <status>; new requirement dropped")
    Note over CR: 不创建新 manifest，不 push 任何 task
  else manifest 不存在
    CA-->>CR: ChainManifest
    CR->>CR: decompose → push tasks
  end
```

> 触发条件：用户输入显式 `chain_id` 与已 completed 链相同（罕见，操作员手工指定）。系统自动生成的 chain_id 用 `chain-<unix_ms>-<rand6>` 几乎不会碰撞。

---

## 3. requirement.md

| 来源 | 内容 |
|---|---|
| 默认（TUI 输入） | 用户在 INPUT 框内打的原文（多行也保留） |
| spawn_chain 派生 | Explorer 输出的 `next_requirement` 字段原文；可在文件头追加 `> Spawned from: <parent_chain_id>` 一行作为可读性补充（非必须） |
| memory_refresh 不创建 requirement.md（不是 chain） |  |

文件以 UTF-8 写盘，无 BOM。

---

## 4. audit.jsonl 事件类型

### 4.1 一行一个 AuditEvent JSON

```json
{"event_id":"evt-0001","timestamp":"2026-05-18T05:08:00.123Z","event_type":"chain_opened","chain_id":"chain-1747547280000-a3b1c2","detail":{"magic_mode":true,"parent_chain_id":null,"chain_depth":0}}
```

### 4.2 事件触发表（默认）

下表事件由 `ChainAudit.record(chain_id, ...)` 写入对应 chain 的 `audit.jsonl`。事件本身必有 chain 上下文；纯全局事件（`worker_joined` / `worker_status_changed` / `message_*` / `stream_chunk` / `debug_info` / `magic_mode_configured`）只发到 `LeaderEventBus` 供 TUI 渲染，不入 audit。

| event_type | 触发位置 | detail 必含 |
|---|---|---|
| `chain_opened` | ChainAudit.openChain | `magic_mode`, `parent_chain_id`, `chain_depth` |
| `requirement_received` | ChainRouter.handleRequirement | `requirement_path` |
| `task_dispatch` | ChainRouter push 任务到 ZK | `task_id`, `link`, `assigned_to?` |
| `task_claimed` | TaskOrchestrator 监听 `/tasks/claimed` 变化 | `task_id`, `link`, `worker_id` |
| `task_completed` | TaskOrchestrator 在 claimed → 消失时记录 | `task_id`, `link`, `worker_id` |
| `task_recovered` | TaskRecovery.recoverOrphan 重排成功 | `task_id`, `retry_count` |
| `task_failed` | TaskRecovery.recoverOrphan 超 MAX_RETRIES 归档 | `task_id`, `retry_count`, `reason` |
| `worker_left` | TaskRecovery 重排时记录被中断 worker | `instance_id`, `phase` |
| `completion_report` | LeaderWatcher 收到 Worker 完成消息 | `task_id`, `decision`, `link` |
| `feedback_sent` | ChainRouter.dispatchFeedbackAsRetry / pushMergeConflictRetries 成功 push | `from_link`, `to_link`, `target_worker`, `total_retry_count` |
| `feedback_unresolved` | resolveFeedbackTarget 返回 null（FR-19） | `chain_id`, `link`, `reason` |
| `chain_id_conflict` | ChainConflictError 被捕获（FR-20） | `existing_status` |
| `retry_ceiling_exceeded` | total_retry_count > max_total_retries（FR-18） | `total_retry_count`, `max_total_retries` |
| `merge_validation_started` | MergeValidator.validate 入口 | `sha`, `branch`, `mode` |
| `merge_validation_completed` | MergeValidator.validate 决策落定 | `sha`, `branch`, `decision`, `mode` |
| `merge_failure` | runCloseChainMerge 捕获到 git 失败（FR-17 / FR-36） | `category`, `branch`, `sha`, `error` |
| `validation_failure` | ChainRouter 解析 ChainDef / decompose 输出失败（FR-11） | `reason` |
| `chain_closed` | ChainAudit.closeChain | `status`, `reason?` |
| `invalid_decision` | ChainRouter 检测到 link × decision 非法组合 | `link`, `decision`, `expected_links` |

### 4.3 事件触发表

| event_type | 触发位置 | detail 必含 |
|---|---|---|
| **`chain_spawned`** | ChainRouter spawn_chain 分支，父链 audit | `child_chain_id`, `parent_chain_id` |
| **`chain_spawned_from`** | ChainRouter spawn_chain 分支，子链 audit | `parent_chain_id`, `chain_depth` |
| **`magic_depth_exhausted`** | ChainRouter 检测 chain_depth ≥ max_chains，spawn_chain 降级 close_chain（FR-34） | `chain_depth`, `max_chains` |

> `chain_spawned` 与 `chain_spawned_from` 是同一次 spawn 在两个 chain 的 audit.jsonl 中各记一条；通过这两条事件 + manifest 的 parent/child 字段可重建链森林。详见 `10-magic-loop.md` §6。

---

## 5. Cache 目录详解

完整布局见 `01-architecture.md` §4。本节说明每个子目录的写入纪律：

### 5.1 `chains/<chain_id>/`

| 文件 | 写入者 | 是否覆写 |
|---|---|---|
| `manifest.json` | ChainAudit | atomic overwrite |
| `audit.jsonl` | ChainAudit | append-only |
| `requirement.md` | ChainAudit.openChain | 一次性写入，不修改 |

### 5.2 `tasks/<task_id>/`

| 文件 | 写入者 | 内容 |
|---|---|---|
| `result.md` | Worker.TaskExecutor（claude -p 完成后） | 任务产出（链内共享，下游 link 读此文件） |
| `exec-<ts>.log` | ClaudeRunner（execWithTee） | claude -p stdout/stderr 流，时间戳 = 调用开始时刻 |
| `eval-<N>.log` | SelfEvaluator 第 N 次重试（N=1..3） | 每次评估的 claude -p stdout |

> 链内多个 link 任务的 result.md 不互相覆盖：每个 task 一个 task_id 一个目录。下游任务读取上游的逻辑 = `<cache>/tasks/<link_tasks[prev_link]>/result.md`（ChainRouter 在 task_dispatch payload 中传路径）。

### 5.3 `merges/`

```
merges/
└── chain-<chain_id>/
    ├── merge-<link>-<ts>.log     # 每 link 一次 worker-merge-decision.md 调用日志
    └── final-<ts>.log            # runMergeValidation 完整聚合
```

> 详见 `07-merge-validator-and-closure.md` §6。

### 5.4 `docs/<worker_name>/<YYYY-MM-DD>/`

Worker 个人备份：每完成一条 link-task 抄一份内容到自己的 docs 目录（前缀 = link 名）。不参与链共享读取，仅用于"操作员事后审计某个 Worker 的产出历史"。

文件名规则：`<link>-<chain_id>.md`，如 `execute-chain-1747547280000-a3b1c2.md`。

### 5.5 `memory/`

详见 `08-memory-and-bootstrap.md` §3 / §4。

### 5.6 超大 result 落盘

ZK 节点 payload 上限 1 MiB。Worker 完成任务的 EvalDecision 如果某 reason 字段非常大（通常 < 4 KiB 不会触发），或 task description 复杂超 64 KiB，统一遵守：

- task payload 仅含必要字段；result.md 全文落盘到 `tasks/<task_id>/result.md`
- 跨进程仅传 `file://<absolute_path>` 引用
- ChainRouter / Worker 双方按约定从该路径读取

---

## 6. Lifecycle Hooks（FR-14）

### 6.1 8 类钩子事件

| 事件 | 触发位置 | 阻塞主流程？ |
|---|---|---|
| `leader_message_start` | `packages/leader/src/chain-router.ts:454`（Leader 调 `claude -p` 跑 decompose 之前） | 否（fire-and-forget + 5s 超时） |
| `leader_message_end` | `chain-router.ts:466`（decompose 返回后） | 否 |
| `worker_message_start` | `packages/worker/src/watcher.ts:322-333`（Worker 调 `claude -p` 跑任务之前） | 否 |
| `worker_message_end` | `watcher.ts:424-436`（claude -p 返回后，无论成败） | 否 |
| `task_claimed` | `watcher.ts:239-248`（`task_queue.claimById` 成功之后） | 否 |
| `task_completed` | `watcher.ts:590-600`（`task_queue.complete` 之后） | 否 |
| `chain_activated` | `chain-router.ts:702-707`（openChain + push tasks 之后） | 否 |
| `merge_decision_made` | `packages/leader/src/merge-validator.ts:122-130`（决策落定后，merge 执行前） | 否 |

> `task_recovered` / `task_failed` 不再是 hook 事件，而是 LeaderEventBus 内存事件 + ChainAudit 持久化事件（写 `audit.jsonl`）；详见 §4.2。

### 6.2 配置

全局 `~/.claude-orchestrator/config.json`：

```json
{
  "hooks": [
    { "event": "worker_message_start", "command": "/path/to/notify.sh", "enabled": true },
    { "event": "task_claimed",         "command": "echo $CO_TASK_ID >> /tmp/claimed.log", "enabled": true },
    { "event": "merge_decision_made",  "command": "echo $CO_DECISION $CO_BRANCH >> /tmp/merge.log", "enabled": true }
  ]
}
```

> 数组元素 `{ event, command, enabled }`：未列出的事件即禁用；`enabled: false` 也禁用；`command` 为 shell 字符串 → `sh -c <command>` 执行。事件名必须落在 §6.1 的 8 类之一。

### 6.3 CO_* 环境变量按事件类型

所有事件都自带 `CO_EVENT=<event_type>`（`hook-engine.ts:45`）。其余字段按事件类型如下（schema：`packages/contracts/src/hooks.ts:9-58`）：

| 事件 | env 字段 |
|------|---------|
| `leader_message_start` | `CO_LEADER_ID, CO_MESSAGE_ID, CO_LINK, CO_LOG_PATH` |
| `leader_message_end` | 上 + `exit_code: number` |
| `worker_message_start` | `CO_WORKER_NAME, CO_WORKER_ID, CO_WORKER_ROLE, CO_LEADER_ID, CO_MESSAGE_ID, CO_TASK_ID, CO_LINK, CO_CHAIN_ID, CO_LOG_PATH, CO_RESULT_PATH` |
| `worker_message_end` | 上 + `exit_code: number` |
| `task_claimed` | `CO_WORKER_NAME, CO_WORKER_ID, CO_WORKER_ROLE, CO_LEADER_ID, CO_MESSAGE_ID, CO_TASK_ID, CO_LINK, CO_CHAIN_ID` |
| `task_completed` | 上 + `duration_seconds: number \| null` |
| `chain_activated` | `CO_CHAIN_ID`（仅一个） |
| `merge_decision_made` | `CO_DECISION, CO_BRANCH, CO_REASON` |

> `flattenEnv`（`hook-engine.ts:78-85`）把 env 字典里的 null/undefined 转换为空串后并入 `process.env`，所以 shell 脚本里读到的总是 string。
>
> v0.7 不再注入 `CO_INSTANCE_ID`（统一用 `CO_WORKER_ID`）与 `CO_PROTOCOL_VERSION`（协议号仅作 ZK payload 诊断元数据，详见 §02-contracts §1.2）。

### 6.4 HookEngine 实现要点

```text
HookEngine.fire(event):
  cmd = handlers.get(event.type)        // 来自 5 层合并后的 ResolvedConfig.hooks
  if cmd == null: return                 // 未配置即跳过
  spawn sh -c <cmd> with env merged      // stdio: 'ignore', detached: true, child.unref()
  startTimer 5s
  on exit:        clearTimer; resolve()  // 不区分 exit code，不 emit 任何事件
  on error:       clearTimer; log warn; resolve()
  on timer fire:  SIGKILL child; log warn 'hook <event.type> timeout'; resolve()
```

> 失败 / 超时不会传播到主流程也不污染 LeaderEventBus：hook 是 fire-and-forget 的辅助通知。spawn 选项见 `packages/runtime/src/hook-engine.ts:44-47`。

---

## 7. TUI 渲染挂钩与 debug_info

LeaderEventBus 发出的事件按类型映射到 EVENT LOG 行（详见 `04-tui-and-input.md` §4）：

| 事件 | EVENT LOG 文案 | 颜色 |
|---|---|---|
| `chain_opened` | `chain <id> opened (depth=N, magic=B)` | 默认 |
| `task_dispatch` | `task_dispatch <task_id> → <worker>` | 默认 |
| `task_completed` | `task_completed <task_id> decision=<d>` | 默认 |
| `chain_closed` (completed) | `chain <id> completed` | 绿 |
| `chain_closed` (aborted) | `chain <id> aborted (<reason>)` | 黄 |
| `chain_merge_failed` | `MERGE_FAILED chain <id>: N branch(es)` | 红 |
| `worker_left` | `worker_left <name> (<reason>)` | 黄 |
| `worker_restarted` | `restart N/3 <name>` | 默认 |
| **`chain_spawned`** | `chain_spawned <parent> → <child>` | 青 |
| **`magic_depth_exhausted`** | `[debug] magic loop depth N reached: spawn_chain demoted to close_chain` | 黄 |
| `feedback_unresolved` | `feedback for chain <id>/<link> dropped: no resolvable target` | 灰 |
| `chain_id_conflict` (debug_info) | `chain <id> already <status>; new requirement dropped` | 灰 |
| `invalid_decision` (debug_info) | `invalid decision <d> on link <l>; chain aborted` | 红 |
| `debug_info`（其它） | 原文 | 灰 |

> 100 条滚动窗口；超过则丢最早。详见 `04-tui-and-input.md` §4。

### 7.1 stream_chunk 不渲染（PRD §6 已知边界）

Worker `claude -p` 通过 `execWithStreaming` 按行回调时会产生 `stream_chunk` 事件，但 v0.7 TUI 不订阅渲染（候选 v0.8）；用户需 `tail -f <exec-log>` 自行观察实时输出。

---

## 8. 与其它 DD 文件的引用关系

| 主题 | 主文件 | 本文交叉 |
|---|---|---|
| openChain 触发链路 | `05-chain-router-and-decisions.md` §3 | §1 / §2 |
| closeChain 触发链路 | `05-chain-router-and-decisions.md` §4 + `07-merge-validator-and-closure.md` §3 | §1.5 |
| incrementRetry 调用 | `05-chain-router-and-decisions.md` §4.2 | §1.2 |
| appendChildChain | `10-magic-loop.md` §4 | §1.2 / §4.3 |
| merge 失败明细写入（仅 audit.jsonl） | `07-merge-validator-and-closure.md` §4 | §4.2 `merge_failure` |
| memory 卡片 / source_hash | `08-memory-and-bootstrap.md` §3 | §5.5 |
| hook 调用点 | `06-tasks-and-workers.md` §3 / §8 | §6 |
