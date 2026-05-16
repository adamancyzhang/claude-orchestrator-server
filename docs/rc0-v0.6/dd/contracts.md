# Contracts — v0.6 类型系统与跨层接口规范

> **文档定位**：`@co/contracts` 包的完整说明书。定义全部跨包共享的类型、Zod schema、判别联合、跨层接口、角色权重表、错误层级。
> 任何对 `@co/contracts` 的破坏性变更视为 v0.7 候选。

## 1. 契约权威性

`@co/contracts` 是唯一的"协议真相源"。所有其他包必须从这里取类型。

- **版本字段**：`PROTOCOL_VERSION = "0.6.0"`
- **不可破坏性变更**（minor）：新增 optional 字段、新增 enum 值（后端兼容）、新增接口方法（带默认实现）
- **破坏性变更**（major，升 v0.7）：删字段、改字段名、收窄类型、改语义

## 2. Branded IDs

所有 ID 是 brand 过的 `string`，编译期防止误传：

```ts
type Brand<T, B> = T & { readonly __brand: B };

type InstanceId   = Brand<string, "InstanceId">;
type TaskId       = Brand<string, "TaskId">;
type MessageId    = Brand<string, "MessageId">;
type ChainId      = Brand<string, "ChainId">;
type SessionId    = Brand<string, "SessionId">;
type WorktreeName = Brand<string, "WorktreeName">;
type ProjectId    = Brand<string, "ProjectId">;
type ZkPath       = Brand<string, "ZkPath">;
```

Cast 边界：经 Zod parse 通过 ✅ | `crypto.randomUUID()` ✅ | CLI 参数（必须先 Zod 校验）❌

## 3. Zod Schema

字段名一律 snake_case（与 ZK wire-format 一致）。

### 3.1 Instance

```ts
const InstanceRoleSchema = z.enum([
  "planner", "builder", "verifier", "reviewer", "accepter", "leader",
]);

const InstanceSchema = z.object({
  id:               z.string(),
  name:             z.string(),
  role:             InstanceRoleSchema.default("builder"),
  status:           z.enum(["idle", "busy"]).default("idle"),
  current_task_id:  z.string().nullable().default(null),
  connected_since:  z.string().datetime(),
  work_dir:         z.string().nullable().default(null),
  worktree_name:    z.string().nullable().default(null),
  worktree_path:    z.string().nullable().default(null),
  worktree_branch:  z.string().nullable().default(null),
  pid:              z.number().int().nullable().default(null),
  protocol_version: z.string(),
});
```

### 3.2 Task

```ts
const TaskLinkSchema = z.enum(["plan", "build", "verify", "review", "accept"]);
const TaskStatusSchema = z.enum(["pending", "claimed", "completed", "blocked", "failed"]);

const TaskSchema = z.object({
  id:                z.string(),
  title:             z.string(),
  description:       z.string().default(""),
  priority:          z.number().int().min(0).max(2).default(1),
  status:            TaskStatusSchema.default("pending"),
  link:              TaskLinkSchema.nullable().default(null),
  chain_id:          z.string().nullable().default(null),
  task_doc_path:     z.string().nullable().default(null),
  result_path:       z.string().nullable().default(null),
  retry_count:       z.number().int().min(0).default(0),
  depends_on:        z.array(z.string()).default([]),
  blocked_by:        z.array(z.string()).default([]),
  blocked_reason:    z.string().nullable().default(null),
  fail_reason:       z.string().nullable().default(null),
  created_by:        z.string().nullable().default(null),
  created_by_name:   z.string().default(""),
  assigned_to:       z.string().nullable().default(null),
  assigned_to_name:  z.string().nullable().default(null),
  claimed_by:        z.string().nullable().default(null),
  completed_by_name: z.string().nullable().default(null),
  created_at:        z.string().datetime(),
  claimed_at:        z.string().datetime().nullable().default(null),
  completed_at:      z.string().datetime().nullable().default(null),
  duration_seconds:  z.number().nullable().default(null),
  leader_only:       z.boolean().default(false),
});
```

### 3.3 Message

```ts
const MessageTypeSchema = z.enum([
  "direct", "broadcast", "task_dispatch", "completion_report", "user_input", "help",
]);

const MessageSchema = z.object({
  id:               z.string(),
  type:             MessageTypeSchema.default("direct"),
  from_instance:    z.string(),
  from_name:        z.string(),
  from_role:        z.string().default(""),
  to_instance:      z.string().nullable().default(null),
  to_name:          z.string().nullable().default(null),
  content:          z.string(),
  link:             TaskLinkSchema.nullable().default(null),
  task_id:          z.string().nullable().default(null),
  chain_id:         z.string().nullable().default(null),
  task_title:       z.string().nullable().default(null),
  task_description: z.string().nullable().default(null),
  task_criteria:    z.string().nullable().default(null),
  task_doc_path:    z.string().nullable().default(null),
  result_path:      z.string().nullable().default(null),
  reply_to:         z.string().nullable().default(null),
  read:             z.boolean().default(false),
  created_at:       z.string().datetime(),
});
```

### 3.4 ChainDef

```ts
const ChainTaskDefSchema = z.object({
  title: z.string(), description: z.string(), criteria: z.string(),
  priority: z.number().int().min(0).max(2),
});

const ChainDefSchema = z.object({
  chain_id:    z.string(),
  chain_title: z.string(),
  tasks: z.object({
    plan:   ChainTaskDefSchema.nullable(),  // null → 跳过 plan
    build:  ChainTaskDefSchema,
    verify: ChainTaskDefSchema,
    review: ChainTaskDefSchema,
    accept: ChainTaskDefSchema,
  }),
});
```

### 3.5 EvalDecision（四态判别联合）

```ts
const EvalDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision:          z.literal("activate_next"),
    reason:            z.string(),
    next_link:         TaskLinkSchema,
    suggested_worker:  z.string().nullable().optional(),
  }),
  z.object({
    decision:           z.literal("feedback"),
    reason:             z.string(),
    feedback_to_worker: z.string(),
    feedback_target:    z.string().nullable().optional(),
  }),
  z.object({
    decision: z.literal("reject"),
    reason:   z.string(),
  }),
  z.object({
    decision: z.literal("close_chain"),
    reason:   z.string(),
  }),
]);
```

| decision | Leader 处理 |
|----------|------------|
| `activate_next` | 激活 `next_link` 任务 |
| `feedback` | 经 `resolveFeedbackTarget` 解析 target，回退给原 Worker 或上一 link 的 worker 补充修正；不可解析时静默丢弃（详见 `core/03-chain-progression.md` §unresolved-target） |
| `reject` | 链失败，`chain_audit.closeChain(chainId, "aborted")`；也是 Worker self-evaluation 三次失败的强制 fallback（详见 `dd/error-and-recovery.md`） |
| `close_chain` | 触发 MergeValidator；全部 commit 合并成功 → `status="completed"`；任一冲突 → `status="merge_failed"` + builder retry（详见 §3.7） |

### 3.6 MergeDecision

```ts
const MergeDecisionSchema = z.object({
  decision: z.enum(["merge", "skip", "review_first"]),
  reason:   z.string(),
  conflict_files:     z.array(z.string()).default([]),
  reviewed_branches:  z.array(z.string()).default([]),
});
```

### 3.7 ChainManifest 与 ChainStatus

ChainAudit 在 `<co_root>/chains/<chain_id>/manifest.json` 持久化以下结构（运行时类型，非 wire-format）：

```ts
type ChainStatus =
  | "running"        // 链开放中
  | "completed"      // close_chain + 全部 commit 合并成功
  | "failed"         // 业务失败（保留）
  | "aborted"        // 评估器 reject 或反馈超 max_total_retries
  | "merge_failed";  // close_chain 命中合并冲突，链不视为成功

interface ChainManifest {
  chain_id: ChainId;
  created_at: string;
  completed_at: string | null;
  status: ChainStatus;
  leader_id: InstanceId;
  leader_name: string;
  requirement_path: string;
  link_tasks:   Record<TaskLink, TaskId | null>;
  link_workers: Record<TaskLink, InstanceId | null>;
  total_retry_count: number;       // 反馈次数累计
  max_total_retries: number;       // 反馈硬上限（默认 DEFAULT_MAX_TOTAL_RETRIES = 9；CO_CHAIN_MAX_RETRIES 覆写）
}
```

`incrementRetry(chainId)` 原子递增 `total_retry_count` 并返回新值；ChainRouter 据此熔断反馈循环。详见 `core/03-chain-progression.md` §retry-ceiling。

### 3.8 LeaderEvent（事件总线）

```ts
type LeaderEvent =
  | { type: "worker_joined" | "worker_left" | "worker_status_changed" | "worker_message_received"; /* … */ }
  | { type: "task_created" | "task_claimed" | "task_completed"; /* … */ }
  | { type: "task_blocked" | "task_failed" | "task_recovered" | "task_dependency_resolved"; /* … */ }
  | { type: "message_sent" | "message_received" | "message_processed"; /* … */ }
  | { type: "chain_activated"; chain_id: ChainId }
  | { type: "chain_closed"; chain_id: ChainId }
  | {
      type: "chain_merge_failed";
      chain_id: ChainId;
      failures: ReadonlyArray<{
        link: TaskLink;
        sha: string;
        branch: string;
        message: string;
        error: string;
      }>;
    }
  | { type: "debug_info"; message: string }
  | { type: "stream_chunk"; instance_id: InstanceId; chunk: string };
```

`chain_merge_failed` 是 RC0 引入的新事件，TUI EVENT LOG 中以 `MERGE_FAILED chain <id>: N branch(es) [...] — retry tasks pushed` 渲染（详见 `dd/architecture.md` §2.5）。

## 4. Input vs Record 双类型

- `XxxSchema` / `Xxx` —— **Record 类型**：ZK 中已存在的完整记录，含 `id`、`created_at` 等运行时字段
- `CreateXxxInput` / `SendXxxInput` —— **Input 类型**：调用方构造的子集；ZK 写入流程补齐缺省字段

## 5. 跨层接口

### 5.1 IZkClient

```ts
interface IZkClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  exists(path: ZkPath): Promise<boolean>;
  createPersistent(path: ZkPath, data: Buffer): Promise<ZkPath>;
  createPersistentSequential(parent: ZkPath, prefix: string, data: Buffer): Promise<ZkPath>;
  createEphemeral(path: ZkPath, data: Buffer): Promise<ZkPath>;
  setData(path: ZkPath, data: Buffer): Promise<ZkStat>;
  getData(path: ZkPath): Promise<{ data: Buffer; stat: ZkStat }>;
  getChildren(path: ZkPath): Promise<string[]>;
  watchChildren(path: ZkPath, cb: (children: string[]) => void): Promise<string[]>;
  watchData(path: ZkPath, cb: (data: Buffer | null) => void): Promise<Buffer | null>;
  delete(path: ZkPath): Promise<void>;
  mkdirp(path: ZkPath): Promise<void>;
  readonly state: "connecting" | "connected" | "disconnected" | "expired";
  on(event: "expired" | "disconnected" | "reconnected", cb: () => void): void;
}
```

### 5.2 ITaskQueue

```ts
interface ITaskQueue {
  push(input: CreateTaskInput): Promise<Task>;
  claim(claimer: InstanceId, role: InstanceRole): Promise<Task | null>;
  complete(taskId: TaskId, result: string, by: InstanceId, completedByName: string,
           durationSeconds: number | null): Promise<void>;
  block(taskId: TaskId, reason: string): Promise<void>;
  fail(taskId: TaskId, reason: string): Promise<void>;
  retry(taskId: TaskId): Promise<Task>;
  listPending(): Promise<Task[]>;
  listClaimed(): Promise<ClaimRecord[]>;
  watchPending(cb: (children: TaskId[]) => void): Promise<TaskId[]>;
  watchClaimed(cb: (records: ClaimRecord[]) => void): Promise<ClaimRecord[]>;
}
```

### 5.3 IMessageRouter

```ts
interface IMessageRouter {
  send(input: SendMessageInput): Promise<Message>;
  poll(instanceId: InstanceId): Promise<Message[]>;
  waitForMessage(instanceId: InstanceId, cb: (msg: Message) => void): Promise<void>;
  dismiss(instanceId: InstanceId, messageId: MessageId): Promise<void>;
}
```

### 5.4 IInstanceRegistry

```ts
interface IInstanceRegistry {
  register(input: CreateInstanceInput): Promise<Instance>;
  unregister(instanceId: InstanceId): Promise<void>;
  heartbeat(instanceId: InstanceId, patch: Partial<Instance>): Promise<void>;
  list(): Promise<Instance[]>;
  get(instanceId: InstanceId): Promise<Instance | null>;
  watch(cb: (instances: Instance[]) => void): Promise<Instance[]>;
}
```

### 5.5 IClaudeRunner / ITemplateEngine / IHookEngine

```ts
interface RunOptions {
  prompt: string; log_path: string;
  system_prompt?: string;
  resume_session_id?: SessionId;
  fork_session?: boolean;
  cwd?: string;
  on_chunk?: (chunk: StreamChunk) => void;
  quiet?: boolean;
}

interface RunResult { exit_code: number; session_id: SessionId | null; log_path: string; }

interface IClaudeRunner { run(opts: RunOptions): Promise<RunResult>; }
interface ITemplateEngine { load(name: string): string; render(name: string, vars: Record<string, string>): string; }
interface IHookEngine { fire(event: HookEvent): Promise<void>; }
```

## 6. 角色权重表

```ts
const ROLE_WEIGHTS: Record<InstanceRole, Record<TaskLink, number>> = {
  planner:  { plan: 100, build:  10, verify:  10, review:  20, accept:  10 },
  builder:  { plan:  10, build: 100, verify:  20, review:  10, accept:  10 },
  verifier: { plan:  10, build:  20, verify: 100, review:  20, accept:  10 },
  reviewer: { plan:  20, build:  10, verify:  20, review: 100, accept:  20 },
  accepter: { plan:  10, build:  10, verify:  10, review:  20, accept: 100 },
  leader:   { plan:   0, build:   0, verify:   0, review:   0, accept:   0 },
};
```

`ITaskQueue.claim` 排序键：
1. `task.assigned_to === claimer`（硬指派）
2. `ROLE_WEIGHTS[claimer.role][task.link]` 越大越优先
3. `task.priority`（0 = HIGH）
4. 创建顺序（FIFO）

## 7. 错误类层级

```ts
class CoError extends Error {
  constructor(public readonly code: string, message: string, public readonly cause?: unknown);
}

// ZK
class ZkError extends CoError {}
class ZkSessionExpiredError extends ZkError {}
class ZkNodeExistsError extends ZkError {}
class ZkNodeNotFoundError extends ZkError {}

// 协议
class ValidationError extends CoError {}
class ProtocolVersionMismatchError extends CoError {}

// 运行时
class ClaudeRunnerError extends CoError {}
class TemplateNotFoundError extends CoError {}
class HookError extends CoError {}

// 业务
class MergeConflictError extends CoError {}
class WorktreeError extends CoError {}
class OrphanRetryExhaustedError extends CoError {}
class ChainConflictError extends CoError {
  // 抛出于 ChainAudit.openChain：当目标 chain_id 已存在且 status !== "running"
  // 时拒绝覆盖，附带 existing_status 与 existing_completed_at。
  constructor(chainId: string,
    public readonly existing_status: string,
    public readonly existing_completed_at: string | null);
}
class CommitFailedError extends CoError {
  // 抛出于 CommitChecker.check：`git commit` 真实失败时（与"无变更可提交"区
  // 分；后者仍返回 null）。携带 stderr 供 watcher 写入 forced feedback 决策。
  constructor(message: string, public readonly stderr: string, cause?: unknown);
}
```

## 8. 判别联合一览

| 判别字段 | 取值 |
|---------|------|
| `Task.status` | `pending / claimed / completed / blocked / failed` |
| `Instance.status` | `idle / busy` |
| `Instance.role` | `planner / builder / verifier / reviewer / accepter / leader` |
| `Task.link` | `plan / build / verify / review / accept` |
| `MessageType` | `direct / broadcast / task_dispatch / completion_report / user_input / help / memory_refresh` |
| `EvalDecisionKind` | `activate_next / feedback / reject / close_chain` |
| `MergeDecisionKind` | `merge / skip / review_first` |
| `ChainStatus` | `running / completed / failed / aborted / merge_failed` |
| `ChainAuditEventType` | `requirement_received / chain_opened / task_dispatch / completion_report / feedback_sent / feedback_unresolved / chain_id_conflict / merge_failure / retry_ceiling_exceeded / chain_closed / validation_failure` |
