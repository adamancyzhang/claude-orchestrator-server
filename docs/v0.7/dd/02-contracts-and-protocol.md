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

> `magic_mode=false` 时 ChainDef 不含 explore 任务；`magic_mode=true` 时 ChainDef 必含 explore 任务且 NEXT_LINKS.accept 启用为 → explore。详见 `10-magic-loop.md` §3。

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
});
export type Task = z.infer<typeof TaskSchema>;
```

> ZK 落位：`/tasks/pending/task-NNNNN`（PERSISTENT_SEQUENTIAL）／`/tasks/claimed/<instance_id>-task-NNNNN`（EPHEMERAL，atomic claim lock）／`/tasks/completed/task-NNNNN`（PERSISTENT）。详见 `01-architecture.md` §3。

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
});
export type Message = z.infer<typeof MessageSchema>;
```

> ZK 落位：`/messages/{instance_id}/msg-NNNNN`（PERSISTENT_SEQUENTIAL）。每个 Worker 一个独立目录。

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

```ts
export class ChainConflictError extends Error {           // FR-20
  constructor(public chainId: ChainId, public existingStatus: ChainStatus) {
    super(`chain ${chainId} already in terminal state: ${existingStatus}`);
  }
}

export class CommitFailedError extends Error {            // FR-21
  constructor(public worktreePath: string, public gitStderr: string) {
    super(`commit failed in ${worktreePath}: ${gitStderr}`);
  }
}

export class OrphanRetryExhaustedError extends Error {    // FR-23
  constructor(public taskId: TaskId, public retryCount: number) {
    super(`task ${taskId} exceeded MAX_RETRY=3 (retry_count=${retryCount})`);
  }
}

export class MagicDepthExhaustedError extends Error {     // FR-34
  constructor(public chainDepth: number, public maxChains: number) {
    super(`magic chain depth ${chainDepth} >= --magic-max-chains ${maxChains}`);
  }
}

export class ValidationError extends Error {              // FR-10/FR-33 spawn_chain 误用
  constructor(public schemaName: string, public detail: unknown) {
    super(`validation failed: ${schemaName}`);
  }
}
```

> 处理位置见各 DD 文件：
> - ChainConflictError → `09-audit-and-cache.md` §3.2 + `05-chain-router-and-decisions.md` §3
> - CommitFailedError → `06-tasks-and-workers.md` §4
> - OrphanRetryExhaustedError → `06-tasks-and-workers.md` §6
> - MagicDepthExhaustedError → `10-magic-loop.md` §5
> - ValidationError（spawn_chain 误用） → `05-chain-router-and-decisions.md` §5.2

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
