# 02 — 协议与契约（schema 真相源）

> **DD 定位**：本文是 v0.7 所有跨进程数据结构（ZK 节点、ZK 消息、ChainAudit manifest、Worker 自评估输出、MergeValidator 输出、Task / ChainDef / Message）的**唯一真相源**。其它 DD 文件中出现的字段名必须与本文一致；遇到字段歧义以本文为准。
>
> **PRD 锚**：`docs/v0.7/prd/04-functional-requirements.md` FR-05 / FR-10 / FR-11 / FR-26 / FR-31 / FR-33 / FR-35；`docs/v0.7/prd/05-non-functional.md` §7（PROTOCOL_VERSION）。
>
> **v0.7 NEW 标记**：协议增量包括 `TaskLinkSchema.execute` 重命名、`TaskLinkSchema.explore` 新增、`InstanceRoleSchema.executor/explorer`、`EvalDecisionSchema.spawn_chain`、`ChainManifestSchema` 四个新字段、`PROTOCOL_VERSION` 升至 `"0.7.0"`。本文所有 v0.7 NEW 内容以 `**[v0.7 NEW]**` 标记。

---

## 1. PROTOCOL_VERSION 与跨版本拒连

### 1.1 常量

```ts
export const PROTOCOL_VERSION = "0.7.0" as const;
```

v0.7 相对 v0.6 的破坏性变更：

| 维度 | v0.6 | v0.7 |
|---|---|---|
| Task link 枚举 | `plan / build / verify / review / accept` | `plan / execute / verify / review / accept / explore` |
| Instance role 枚举 | `planner / builder / verifier / reviewer / accepter` | `planner / executor / verifier / reviewer / accepter / explorer` |
| EvalDecision 枚举 | 4 态 | 5 态（新增 `spawn_chain`） |
| ChainManifest 字段 | base + total_retry_count | base + 4 个新字段（见 §6） |

### 1.2 校验流程

Worker 子进程启动后第一步：

```ts
// 伪代码（Worker child-runner）
const leader = await zk.getJSON('/leader');
if (leader.protocol_version !== PROTOCOL_VERSION) {
  console.error(`Protocol mismatch: leader=${leader.protocol_version}, self=${PROTOCOL_VERSION}`);
  process.exit(2);
}
```

Leader 抢占 `/leader` 节点时把 `protocol_version` 写入 EPHEMERAL 节点 payload；任一 Worker 协议号不匹配立即退出，避免 v0.6 Worker 误连 v0.7 Leader（反之亦然）。

---

## 2. Branded ID

为防止字符串 ID 串用，所有 ID 用 brand 类型：

```ts
type Brand<K, T extends string> = K & { readonly __brand: T };

export type ChainId    = Brand<string, 'ChainId'>;     // 形如 "chain-<timestamp>-<rand6>"
export type TaskId     = Brand<string, 'TaskId'>;      // 形如 "task-NNNNN"（来自 ZK SEQUENTIAL）
export type InstanceId = Brand<string, 'InstanceId'>;  // Worker 全局唯一标识
export type MessageId  = Brand<string, 'MessageId'>;   // 形如 "msg-NNNNN"
```

构造函数（runtime 校验 + brand）：

```ts
export const ChainId    = (s: string): ChainId    => /* assert prefix "chain-" */ s as ChainId;
export const TaskId     = (s: string): TaskId     => /* assert prefix "task-"  */ s as TaskId;
export const InstanceId = (s: string): InstanceId => /* assert non-empty       */ s as InstanceId;
export const MessageId  = (s: string): MessageId  => /* assert prefix "msg-"   */ s as MessageId;
```

---

## 3. 责任链枚举

### 3.1 TaskLinkSchema **[v0.7 NEW]**

```ts
import { z } from 'zod';

export const TaskLinkSchema = z.enum([
  'plan',
  'execute',  // [v0.7 rename] was 'build'
  'verify',
  'review',
  'accept',
  'explore',  // [v0.7 NEW] only valid in --magic mode
]);
export type TaskLink = z.infer<typeof TaskLinkSchema>;

export const CHAIN_LINKS: readonly TaskLink[] = [
  'plan', 'execute', 'verify', 'review', 'accept', 'explore',
] as const;

export const NEXT_LINKS: Record<TaskLink, TaskLink | null> = {
  plan:    'execute',
  execute: 'verify',
  verify:  'review',
  review:  'accept',
  accept:  'explore',  // [v0.7 NEW] only used when magic_mode=true; else accept→close_chain
  explore: null,
};

export const PREV_LINKS: Record<TaskLink, TaskLink | null> = {
  plan:    null,
  execute: 'plan',
  verify:  'execute',
  review:  'verify',
  accept:  'review',
  explore: 'accept',
};
```

> 在默认模式（`magic_mode=false`）下，accept link 的合法 EvalDecision 只能是 `close_chain` / `reject` / `feedback`，不会用到 `NEXT_LINKS.accept`。详见 §5 决策合法性矩阵。

### 3.2 InstanceRoleSchema **[v0.7 NEW]**

```ts
export const InstanceRoleSchema = z.enum([
  'leader',
  'planner',
  'executor',  // [v0.7 rename] was 'builder'
  'verifier',
  'reviewer',
  'accepter',
  'explorer',  // [v0.7 NEW]
]);
export type InstanceRole = z.infer<typeof InstanceRoleSchema>;

export type WorkerRole = Exclude<InstanceRole, 'leader'>;
```

---

## 4. roleWeights 矩阵

PRD 02-personas-and-roles.md §4 中的精确数值，落到 TS 常量：

```ts
export const roleWeights: Record<InstanceRole, Record<TaskLink, number>> = {
  //         plan  execute  verify  review  accept  explore  [v0.7 NEW]
  planner:  { plan: 100, execute: 10,  verify: 10,  review: 20,  accept: 10,  explore: 20  },
  executor: { plan: 10,  execute: 100, verify: 20,  review: 10,  accept: 10,  explore: 10  },
  verifier: { plan: 10,  execute: 20,  verify: 100, review: 20,  accept: 10,  explore: 10  },
  reviewer: { plan: 20,  execute: 10,  verify: 20,  review: 100, accept: 20,  explore: 10  },
  accepter: { plan: 10,  execute: 10,  verify: 10,  review: 20,  accept: 100, explore: 20  },
  explorer: { plan: 20,  execute: 10,  verify: 10,  review: 20,  accept: 10,  explore: 100 }, // [v0.7 NEW]
  leader:   { plan: 0,   execute: 0,   verify: 0,   review: 0,   accept: 0,   explore: 0   },
};
```

> 不变量：每个 worker role 在其首选 link 上权重为 100，其它 link 落在 [10, 20] 区间；leader 全 0（leader 不认领任务）。
>
> 详见 `03-identity-and-roles.md` §3 的 `TaskQueue.claim()` 排序使用。

---

## 5. EvalDecision 五态

### 5.1 EvalDecisionSchema **[v0.7 NEW]**

```ts
const EvalDecisionBase = z.object({
  reason: z.string().min(1),
  feedback_target: InstanceIdSchema.optional(),
});

export const EvalDecisionSchema = z.discriminatedUnion('decision', [
  EvalDecisionBase.extend({ decision: z.literal('activate_next') }),
  EvalDecisionBase.extend({ decision: z.literal('feedback')      }),
  EvalDecisionBase.extend({ decision: z.literal('reject')        }),
  EvalDecisionBase.extend({ decision: z.literal('close_chain')   }),
  // [v0.7 NEW] —— spawn_chain：仅 explore link 合法；必须携带 next_requirement
  EvalDecisionBase.extend({
    decision: z.literal('spawn_chain'),
    next_requirement: z.string().min(1),
  }),
]);
export type EvalDecision = z.infer<typeof EvalDecisionSchema>;
```

### 5.2 Decision × Link 合法性矩阵

| decision \ link | plan | execute | verify | review | accept | **explore** |
|---|---|---|---|---|---|---|
| `activate_next` | ✅ → execute | ✅ → verify | ✅ → review | ✅ → accept | ⚠️ 仅 `magic_mode=true`：→ explore | ❌ explore 无下一环节 |
| `feedback`      | ❌（plan 无前置，PREV=null）→ FR-19 静默丢 | ✅ → plan | ✅ → execute | ✅ → verify | ✅ → review | ✅ → accept |
| `reject`        | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `close_chain`   | ⚠️ 只在 SelfEvaluator 三连失败 fallback 时被强制为 `reject`，正常路径不出现 | ⚠️ 同上 | ⚠️ 同上 | ⚠️ 同上 | ✅ 默认链终态 | ✅ Explorer 自主终止循环 |
| **`spawn_chain`** **[v0.7 NEW]** | ❌ ValidationError → reject | ❌ | ❌ | ❌ | ❌ | ✅ 仅此一处合法 |

> 实现纪律：ChainRouter 在分发前必须做 link × decision 合法性检查，违规决策 → audit `invalid_decision` + reject。详见 `05-chain-router-and-decisions.md` §4。

### 5.3 feedback_target 解析

```ts
// resolveFeedbackTarget(manifest, link, decision) → InstanceId | null
function resolveFeedbackTarget(
  manifest: ChainManifest,
  currentLink: TaskLink,
  decision: EvalDecision,
): InstanceId | null {
  // 1. explicit
  if (decision.feedback_target) return decision.feedback_target;
  // 2. previous link's owner
  const prev = PREV_LINKS[currentLink];
  if (prev && manifest.link_workers[prev]) {
    return manifest.link_workers[prev]!;
  }
  // 3. unresolvable → caller emits audit feedback_unresolved
  return null;
}
```

> commit failure 特例（FR-21）：CommitFailedError 时由 Worker 自己构造 `decision: 'feedback', feedback_target: <self instanceId>` → 步骤 1 直接返回 self。

---

## 6. ChainManifest schema **[v0.7 NEW 字段]**

### 6.0 LinkCommitRecord **[v0.7 NEW]**

```ts
// 每条 link 的双轨 commit 记录（rc1 worktree 工作流）
export const LinkCommitRecordSchema = z.object({
  worktree: z.string().nullable(),   // 项目仓 worker 分支上的 commit SHA（null = 该 link 无代码变更）
  docs:     z.string().nullable(),   // CO root 仓上对 docs/<worker_name>/ 的 commit SHA（null = 无 docs 变更或 commit 失败）
  branch:   z.string(),              // worker 分支名，close_chain 时 MergeValidator 用它定位待合并分支
});
export type LinkCommitRecord = z.infer<typeof LinkCommitRecordSchema>;
```

> 代码归属：`packages/leader/src/chain-audit.ts:29`（接口当前以 TS interface 形式定义，schema 层 v0.7 NEW 收敛为 Zod，方便 ZK/manifest 反序列化校验）。

> 字段语义：
> - `worktree` 与 `docs` 解耦：worktree commit 是任务"代码产出"的真相源；docs commit 是 best-effort 的归档（CO root 仓共享，并发写入可失败，详见 `06-tasks-and-workers.md` §4.5）。
> - `branch` 总是非空：即便 `worktree=null`（无代码变更），下游 link 的 pre-task rebase 仍可能用到该 branch 作为 fallback 起点。

### 6.1 ChainStatus

```ts
export const ChainStatusSchema = z.enum([
  'active',
  'completed',
  'aborted',
  'merge_failed',
  'failed',  // 保留位（孤儿任务超 MAX_RETRY 归档）
]);
export type ChainStatus = z.infer<typeof ChainStatusSchema>;
```

### 6.2 ChainManifestSchema

```ts
export const ChainManifestSchema = z.object({
  // —— 标识与时间
  chain_id:           ChainIdSchema,
  protocol_version:   z.literal(PROTOCOL_VERSION),
  created_at:         z.string().datetime(),
  completed_at:       z.string().datetime().nullable(),

  // —— 状态
  status:             ChainStatusSchema,
  abort_reason:       z.string().nullable(),  // 'retry_ceiling_exceeded' / 'self_eval_failed' / 'invalid_decision' / ...
  merge_failures:     z.array(z.object({
    link:           TaskLinkSchema,
    branch:         z.string(),
    error:          z.string(),
  })).default([]),  // 仅 status='merge_failed' 时有内容（FR-17）

  // —— 链节关联
  link_tasks:         z.record(TaskLinkSchema, TaskIdSchema).partial(),
  link_workers:       z.record(TaskLinkSchema, InstanceIdSchema).partial(),

  // —— rc1 worktree 工作流 **[v0.7 NEW]** ——
  link_commits:       z.record(TaskLinkSchema, LinkCommitRecordSchema).partial().default({}),
  // 每个 link 完成时由 ChainAudit.recordLinkCommit(chainId, link, {worktree, docs, branch}) 写入；
  // 下游 link dispatch 前由 ChainAudit.collectUpstreamCommits(chainId) 读取并注入 task_dispatch.upstream_commits；
  // feedback 决策时由 ChainAudit.clearLinkCommitsFrom(chainId, fromLink) 擦除 fromLink 及其下游记录，保证 retry 从干净的上游开始。

  // —— 反馈韧性（FR-18）
  total_retry_count:  z.number().int().nonnegative().default(0),
  max_total_retries:  z.number().int().positive().default(9),  // CO_CHAIN_MAX_RETRIES 覆写

  // —— 需求文本指针
  requirement_path:   z.string(),  // 形如 "<cache_dir>/chains/<chain_id>/requirement.md"

  // —— v0.7 NEW：链森林 ——
  parent_chain_id:    ChainIdSchema.nullable(),       // [v0.7 NEW] 顶层链为 null
  child_chain_ids:    z.array(ChainIdSchema).default([]), // [v0.7 NEW] spawn_chain 派生
  chain_depth:        z.number().int().nonnegative().default(0), // [v0.7 NEW] 顶层=0
  magic_mode:         z.boolean().default(false),     // [v0.7 NEW] 是否由 --magic 启动创建
});
export type ChainManifest = z.infer<typeof ChainManifestSchema>;
```

### 6.3 v0.7 NEW 字段语义

| 字段 | 顶层链（首链） | 子链（spawn_chain 派生） |
|---|---|---|
| `parent_chain_id` | `null` | 父链的 `chain_id` |
| `child_chain_ids` | 跑完后含所有 child（顺序 append） | 同上递归 |
| `chain_depth` | `0` | `parent.chain_depth + 1` |
| `magic_mode` | `false`（默认）/ `true`（`--magic` 启动） | 继承父链 `true` |
| `link_commits` | 每个 link 完成时 append；feedback 时擦除 fromLink 及下游 | 子链独立维护，**不**继承父链 link_commits |

> `magic_mode=false` 时 ChainDef 不含 explore 任务；`magic_mode=true` 时 ChainDef 必含 explore 任务且 NEXT_LINKS.accept 启用为 → explore。详见 `10-magic-loop.md` §3。
>
> `link_commits` 仅在 chain 内传递；子链 spawn 时 ChainAudit 为子链开新 manifest，`link_commits` 重置为空 `{}`，子链的 plan link 不感知父链 worktree commit（PRD §6.1 跨 chain 上下文受限）。

---

## 7. ChainDef schema（decompose 输出）

```ts
const TaskSpecSchema = z.object({
  title:       z.string(),
  description: z.string(),
  priority:    z.enum(['HIGH', 'NORMAL', 'LOW']).default('NORMAL'),
  link:        TaskLinkSchema,
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const ChainDefSchema = z.object({
  chain_id:  ChainIdSchema,
  plan:      TaskSpecSchema.nullable(),  // FR-11: 可 null（跳过 plan）
  execute:   TaskSpecSchema,
  verify:    TaskSpecSchema,
  review:    TaskSpecSchema,
  accept:    TaskSpecSchema,
  explore:   TaskSpecSchema.optional(),  // [v0.7 NEW] 仅 magic_mode=true 时存在
});
export type ChainDef = z.infer<typeof ChainDefSchema>;
```

> 校验规则（ChainRouter.handleRequirement）：
> - `magic_mode=false` && `def.explore` 存在 → ValidationError
> - `magic_mode=true`  && `def.explore` 缺失 → ValidationError（decompose 模板必须感知 magic 上下文）

---

## 8. Task schema

```ts
export const TaskStatusSchema = z.enum([
  'pending', 'claimed', 'completed', 'blocked', 'failed',
]);

export const TaskSchema = z.object({
  task_id:       TaskIdSchema,
  chain_id:      ChainIdSchema,
  link:          TaskLinkSchema,
  title:         z.string(),
  description:   z.string(),
  priority:      z.enum(['HIGH', 'NORMAL', 'LOW']).default('NORMAL'),
  status:        TaskStatusSchema,
  assigned_to:   InstanceIdSchema.nullable(),  // 显式指派（merge_failed retry / commit failure retry）
  claimed_by:    InstanceIdSchema.nullable(),
  retry_count:   z.number().int().nonnegative().default(0),
  created_at:    z.string().datetime(),
  claimed_at:    z.string().datetime().nullable(),
  completed_at:  z.string().datetime().nullable(),

  // —— v0.7 NEW —— rc1 worktree 工作流
  upstream_commits: UpstreamCommitsSchema.optional(),  // 见 §9
});
export type Task = z.infer<typeof TaskSchema>;
```

> ZK 落位：`/tasks/pending/task-NNNNN`（PERSISTENT_SEQUENTIAL）／`/tasks/claimed/<instance_id>-task-NNNNN`（EPHEMERAL，atomic claim lock）／`/tasks/completed/task-NNNNN`（PERSISTENT）。详见 `01-architecture.md` §3。
>
> `Task.upstream_commits` 与 `Message.upstream_commits`（§9）双写：ChainRouter 同时把 `UpstreamCommits` 写入新建 Task 和派发它的 task_dispatch message，Worker 优先用 message 字段（更新），fallback 到 task 字段。两处冗余保护"消息丢失但任务从 ZK pending 残留"的恢复路径。

---

## 9. Message schema

```ts
export const MessageTypeSchema = z.enum([
  'user_input',          // TUI 输入框 → Leader 自己的收件箱
  'task_dispatch',       // Leader → Worker
  'completion_report',   // Worker → Leader
  'memory_refresh',      // Worker → Leader（commit 后通知 refresh）
  'broadcast',           // Leader → all workers
  'direct',              // Worker → Worker（v0.7 保留，无默认调用方）
  'help',                // TUI 帮助态触发
]);

export const MessageSchema = z.object({
  message_id:   MessageIdSchema,
  type:         MessageTypeSchema,
  from:         InstanceIdSchema,
  to:           InstanceIdSchema,      // broadcast 时为 '*'
  content:      z.string(),            // 自由文本或 JSON 字符串（按 type 解析）
  created_at:   z.string().datetime(),

  // —— 任务相关 ——
  task_id:      TaskIdSchema.optional(),
  chain_id:     ChainIdSchema.optional(),
  link:         TaskLinkSchema.optional(),

  // —— v0.7 NEW —— spawn_chain 注入的 user_input 携带这两个字段
  spawned_from: ChainIdSchema.optional(),  // [v0.7 NEW]
  next_requirement: z.string().optional(),  // [v0.7 NEW] 与 spawned_from 配对

  // —— v0.7 NEW —— rc1 worktree 工作流：下游 link 的 pre-task rebase 用
  upstream_commits: UpstreamCommitsSchema.optional(),
});
export type Message = z.infer<typeof MessageSchema>;

// 上游 link 的 worktree SHA 映射（只携带 worktree，不携带 docs / branch — pre-task rebase 只需 sha）
export const UpstreamCommitsSchema = z.object({
  plan:   z.string().nullable().optional(),
  build:  z.string().nullable().optional(),
  verify: z.string().nullable().optional(),
  review: z.string().nullable().optional(),
});
export type UpstreamCommits = z.infer<typeof UpstreamCommitsSchema>;
```

> ZK 落位：`/messages/{instance_id}/msg-NNNNN`（PERSISTENT_SEQUENTIAL）。每个 Worker 一个独立目录。
>
> **upstream_commits 注入与消费**：
> - **注入**：ChainRouter 在 dispatchNextLink 前调用 `ChainAudit.collectUpstreamCommits(chain_id)`，将含 worktree SHA 的 `UpstreamCommits` 写入 `task_dispatch.upstream_commits`（详见 `09-audit-and-cache.md` §1.2 与 `06-tasks-and-workers.md` §3.7）。
> - **消费**：Worker 在执行任务前从 `msg.upstream_commits` 取出上一个 link 的 worktree SHA，执行 `git rebase <sha>`（详见 `06-tasks-and-workers.md` §3.5 pre-task rebase）。
> - **不含 `accept`**：accept link 是 close_chain 的合并目标，没有下游 link 需要 rebase 到它，schema 故意只列 plan/build/verify/review 四个。
> - 同名字段 `Task.upstream_commits` 同步存在于 `TaskSchema`（§8），由 TaskQueue.push 写入 ZK 并由 Worker 读出后转交 ClaudeRunner 模板渲染。代码归属：`packages/contracts/src/schemas/task.ts:26`。

---

## 10. MergeDecision schema

```ts
export const MergeDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('merge'),
    reason:   z.string(),
    merged_commit: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  z.object({
    decision: z.literal('skip'),
    reason:   z.string(),  // 已合并 / 无新 commit
  }),
  z.object({
    decision: z.literal('review_first'),
    reason:   z.string(),  // 冲突 / claude-cli 失败时的保守 fallback
  }),
]);
export type MergeDecision = z.infer<typeof MergeDecisionSchema>;
```

> 详见 `07-merge-validator-and-closure.md` §2。
>
> **rc1 调用模型（**[v0.7 NEW]**）**：close_chain 仅调 `MergeValidator.validate()` **一次**（针对 accept-link 分支），产生**一条** MergeDecision。schema 本身不变；语义层从"每 link 一个 decision"收敛为"每 close_chain 一个 decision"。legacy fallback（详见 `07-merge-validator-and-closure.md` §6.7）仍能产生多条 decision，schema 上向后兼容。

---

## 11. ZK 节点 payload schema

### 11.1 `/leader`（EPHEMERAL）

```json
{
  "instance_id":      "leader-<host>-<pid>-<rand>",
  "protocol_version": "0.7.0",
  "started_at":       "2026-05-18T05:08:00.000Z",
  "host":             "<hostname>",
  "pid":              12345,
  "magic_mode":       false,
  "magic_max_chains": null
}
```

> `magic_mode` 与 `magic_max_chains` 是 [v0.7 NEW] 字段。Worker 通过它感知"本次启动是否 --magic"，从而决定是否启用 explore link 与 spawn_chain 决策（详见 `10-magic-loop.md` §1）。

### 11.2 `/instances/{instance_id}`（EPHEMERAL）

```json
{
  "instance_id": "Tom",
  "name":        "Tom",
  "role":        "planner",
  "pid":         23456,
  "worktree":    "/path/to/.claude-orchestrator/worktree/Tom",
  "branch":      "claude-orchestrator/Tom-workspace",
  "started_at":  "2026-05-18T05:08:00.000Z",
  "protocol_version": "0.7.0"
}
```

### 11.3 `/tasks/pending/task-NNNNN`（PERSISTENT_SEQUENTIAL）

payload = Task JSON（见 §8）。

### 11.4 `/tasks/claimed/<instance_id>-task-NNNNN`（EPHEMERAL）

payload：

```json
{
  "task_id":       "task-00042",
  "claimed_by":    "Tom",
  "claimed_at":    "2026-05-18T05:08:30.000Z",
  "original_path": "/tasks/pending/task-00042"
}
```

> 利用 ZK `create(path, EPHEMERAL)` 的原子性实现 claim lock：只有第一个 create 成功的 Worker 拿到任务。详见 `06-tasks-and-workers.md` §2。

### 11.5 `/messages/{instance_id}/msg-NNNNN`（PERSISTENT_SEQUENTIAL）

payload = Message JSON（见 §9）。

---

## 12. 错误类目录

所有错误类继承自统一基类 `CoError`，携带 `code` 字符串与可选 `cause`。代码归属：`packages/contracts/src/errors.ts`。下表 14 个类按域分组：

```ts
export class CoError extends Error {
  public readonly code: string;
  public readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) { ... }
}

// —— ZK 域 ——
export class ZkError extends CoError {}
export class ZkSessionExpiredError extends ZkError {        // ZK_SESSION_EXPIRED
  constructor(message = "ZK session expired", cause?: unknown);
}
export class ZkNodeExistsError extends ZkError {            // ZK_NODE_EXISTS
  constructor(message = "ZK node exists", cause?: unknown);
}
export class ZkNodeNotFoundError extends ZkError {          // ZK_NODE_NOT_FOUND
  constructor(message = "ZK node not found", cause?: unknown);
}

// —— Protocol / Validation ——
export class ValidationError extends CoError {              // VALIDATION_FAILED — FR-10 / FR-33 spawn_chain 误用 / MergeDecision JSON 解析失败
  constructor(message: string, cause?: unknown);
}
export class ProtocolVersionMismatchError extends CoError { // PROTOCOL_VERSION_MISMATCH — §1.2 跨版本拒连
  constructor(expected: string, actual: string);
}

// —— Runtime ——
export class ClaudeRunnerError extends CoError {            // CLAUDE_RUNNER_FAILED
  constructor(message: string, cause?: unknown);
}
export class TemplateNotFoundError extends CoError {        // TEMPLATE_NOT_FOUND
  constructor(name: string);
}
export class HookError extends CoError {                    // HOOK_FAILED
  constructor(message: string, cause?: unknown);
}

// —— Business ——
export class ChainConflictError extends CoError {           // CHAIN_ID_CONFLICT — FR-20
  constructor(
    chainId: string,
    public readonly existing_status: string,
    public readonly existing_completed_at: string | null,
  );
}
export class CommitFailedError extends CoError {            // WORKER_COMMIT_FAILED — FR-21
  constructor(message: string, public readonly stderr: string, cause?: unknown);
}
export class OrphanRetryExhaustedError extends CoError {    // ORPHAN_RETRY_EXHAUSTED — FR-23
  constructor(taskId: string, retryCount: number);
}
export class MergeConflictError extends CoError {           // MERGE_CONFLICT — FR-17
  constructor(message: string, public readonly conflict_files: string[] = []);
}
export class WorktreeError extends CoError {                // WORKTREE_FAILED — FR-07 worktree 创建/初始化失败
  constructor(message: string, cause?: unknown);
}
export class MagicDepthExhaustedError extends CoError {     // MAGIC_DEPTH_EXHAUSTED — FR-34 **[v0.7 NEW]**
  constructor(public chainDepth: number, public maxChains: number);
}

// —— Git 五分类（rc1 worktree 工作流，**[v0.7 NEW]**） ——
export class WorktreeLockedError extends CoError {          // WORKTREE_LOCKED **[v0.7 NEW]**
  constructor(message: string, public readonly stderr: string = "", cause?: unknown);
}
export class GitPermissionError extends CoError {           // GIT_PERMISSION_DENIED **[v0.7 NEW]**
  constructor(message: string, public readonly stderr: string = "", cause?: unknown);
}
export class GitNetworkError extends CoError {              // GIT_NETWORK_FAILED **[v0.7 NEW]**
  constructor(message: string, public readonly stderr: string = "", cause?: unknown);
}
export class RebaseConflictError extends CoError {          // REBASE_CONFLICT — pre-task rebase 冲突 **[v0.7 NEW]**
  constructor(message: string, public readonly conflict_files: string[] = [], cause?: unknown);
}
```

> 处理位置见各 DD 文件：
> - ZkError / ZkSessionExpiredError / ZkNodeExistsError / ZkNodeNotFoundError → `01-architecture.md` §7（ZK 断连重试）
> - ProtocolVersionMismatchError → §1.2 校验流程
> - ClaudeRunnerError → `06-tasks-and-workers.md` §3（任务执行）
> - TemplateNotFoundError → `03-identity-and-roles.md` §4（模板加载）
> - HookError → `09-audit-and-cache.md` §6（HookEngine）
> - ValidationError → `05-chain-router-and-decisions.md` §5.2 + `07-merge-validator-and-closure.md` §6
> - ChainConflictError → `09-audit-and-cache.md` §3.2 + `05-chain-router-and-decisions.md` §3
> - CommitFailedError → `06-tasks-and-workers.md` §4
> - OrphanRetryExhaustedError → `06-tasks-and-workers.md` §8
> - MergeConflictError → `07-merge-validator-and-closure.md` §4.2（merge_failed 触发 retry）
> - WorktreeError → `03-identity-and-roles.md` §3（worktree 隔离创建）
> - MagicDepthExhaustedError → `10-magic-loop.md` §5
> - WorktreeLockedError / GitPermissionError / GitNetworkError → `07-merge-validator-and-closure.md` §6.6 + `06-tasks-and-workers.md` §3.6（五分类）
> - RebaseConflictError → `06-tasks-and-workers.md` §3.5（pre-task rebase 失败 → 强制 feedback）

---

## 13. AuditEvent 类型（与 `09-audit-and-cache.md` §4 协同）

```ts
export const AuditEventTypeSchema = z.enum([
  // —— 默认（v0.6 继承）
  'chain_opened',
  'requirement_received',
  'task_dispatch',
  'task_claimed',
  'task_completed',
  'completion_report',
  'feedback_sent',
  'feedback_unresolved',       // FR-19
  'chain_id_conflict',          // FR-20
  'retry_ceiling_exceeded',     // FR-18
  'merge_validation_started',
  'merge_validation_completed',
  'chain_closed',
  'chain_merge_failed',         // FR-17
  'worker_left',
  'task_recovered',
  'task_failed',
  'invalid_decision',           // FR-10 link×decision 合法性
  // —— [v0.7 NEW]
  'chain_spawned',              // FR-33 父链 audit
  'chain_spawned_from',         // FR-33 子链 audit
  'magic_depth_exhausted',      // FR-34
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  event_id:   z.string(),
  timestamp:  z.string().datetime(),
  event_type: AuditEventTypeSchema,
  chain_id:   ChainIdSchema,
  detail:     z.record(z.string(), z.unknown()),  // 自由 JSON
});
```

> audit.jsonl 一行一个 `AuditEvent`。详见 `09-audit-and-cache.md` §4。

---

## 14. 字段引用纪律

| 字段名 | 主定义文件 | 主定义位置 |
|---|---|---|
| `PROTOCOL_VERSION` | `02-contracts-and-protocol.md` | §1 |
| `TaskLink` / `CHAIN_LINKS` / `NEXT_LINKS` / `PREV_LINKS` | `02-contracts-and-protocol.md` | §3 |
| `InstanceRole` / `WorkerRole` | `02-contracts-and-protocol.md` | §3.2 |
| `roleWeights` | `02-contracts-and-protocol.md` | §4 |
| `EvalDecision` | `02-contracts-and-protocol.md` | §5 |
| `ChainManifest` / `ChainStatus` | `02-contracts-and-protocol.md` | §6 |
| `ChainDef` / `TaskSpec` | `02-contracts-and-protocol.md` | §7 |
| `Task` / `TaskStatus` | `02-contracts-and-protocol.md` | §8 |
| `Message` / `MessageType` | `02-contracts-and-protocol.md` | §9 |
| `MergeDecision` | `02-contracts-and-protocol.md` | §10 |
| 错误类 | `02-contracts-and-protocol.md` | §12 |
| `AuditEventType` | `02-contracts-and-protocol.md` | §13（事件细则见 09 §4） |

其它 DD 文件出现以上字段时一律引用本文 §N，不重复 schema 定义；如发现实际实现需要新字段，必须先回到本文新增章节，再在引用文件中追加说明。
