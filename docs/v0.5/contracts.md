# Contracts — v0.5 类型系统与跨层接口规范

> **文档定位**：本文是 `@co/contracts` 包的**完整说明书**。它定义全部跨包共享的类型、Zod schema、判别联合、跨层接口、角色权重表、错误层级、日志契约、路径函数。
>
> 任何对 `@co/contracts` 的破坏性变更（重命名 / 删字段 / 改语义）都视为 **v0.6 候选**，必须升级 `PROTOCOL_VERSION`。
>
> 相关文档：包归属与依赖见 [`package-layout.md`](package-layout.md)；ZK wire-format 见 [`protocol.md`](protocol.md)；错误使用规约见 [`error-and-recovery.md`](error-and-recovery.md)。

---

## 1. 契约权威性与版本策略

`@co/contracts` 是 v0.5 中唯一的"协议真相源"。**所有其他包**必须从这里取类型、不允许自定义同名类型。

- **版本字段**：`protocol.ts` 导出常量 `PROTOCOL_VERSION = "0.5.0"`。Leader 与 Worker 启动时把它写入 `/leader` 与 `/instances/{id}` 的 metadata；不匹配则启动失败（详见 [`protocol.md`](protocol.md) §1）。
- **不可破坏性变更**（minor）：新增字段（带 `.optional()` 或 `.default(...)`)、新增 enum 值（向后兼容位置）、新增接口方法（带默认实现声明）。
- **破坏性变更**（major，升 v0.6）：删字段、改字段名、收窄类型、改字段语义、删除/重命名接口方法。

---

## 2. Branded IDs（`packages/contracts/src/ids.ts`）

所有 ID 是 brand 过的 `string`，编译期防止误传。运行时本质仍是 `string`，唯一允许 cast 到 brand 的位置是 **Zod parse 之后**与**已知字面量构造**两处。

```ts
export type Brand<T, B> = T & { readonly __brand: B };

export type InstanceId   = Brand<string, "InstanceId">;
export type TaskId       = Brand<string, "TaskId">;
export type MessageId    = Brand<string, "MessageId">;
export type ChainId      = Brand<string, "ChainId">;
export type SessionId    = Brand<string, "SessionId">;
export type WorktreeName = Brand<string, "WorktreeName">;
export type ProjectId    = Brand<string, "ProjectId">;
export type ZkPath       = Brand<string, "ZkPath">;

export const asInstanceId   = (s: string): InstanceId   => s as InstanceId;
export const asTaskId       = (s: string): TaskId       => s as TaskId;
export const asMessageId    = (s: string): MessageId    => s as MessageId;
export const asChainId      = (s: string): ChainId      => s as ChainId;
export const asSessionId    = (s: string): SessionId    => s as SessionId;
export const asWorktreeName = (s: string): WorktreeName => s as WorktreeName;
export const asProjectId    = (s: string): ProjectId    => s as ProjectId;
export const asZkPath       = (s: string): ZkPath       => s as ZkPath;
```

**Cast 边界规则**：

| 来源 | 允许 cast |
|------|-----------|
| 经 Zod schema `.parse()` 通过的字段 | ✅ |
| `crypto.randomUUID()` / 序列号构造器 | ✅ |
| 命令行参数（必须先 Zod 校验） | ❌（必须先 parse） |
| ZK 节点读出的 raw string（必须先 Zod 校验） | ❌（必须先 parse） |
| 其他 brand 直接互转 | ❌ |

---

## 3. Zod Schema 目录

> 字段名一律使用 **snake_case**（与 ZK wire-format 一致）；TypeScript 类型字段保持 snake_case 以避免 marshal 函数。

### 3.1 Instance（`instance.ts`）

```ts
export const InstanceStatusSchema = z.enum(["idle", "busy"]);
export const InstanceRoleSchema = z.enum([
  "planner", "builder", "verifier", "reviewer", "accepter", "leader",
]);

export const InstanceSchema = z.object({
  id:               z.string().transform(asInstanceId),
  name:             z.string(),
  role:             InstanceRoleSchema.default("builder"),
  status:           InstanceStatusSchema.default("idle"),
  current_task_id:  z.string().transform(asTaskId).nullable().default(null),
  connected_since:  z.string().datetime(),
  work_dir:         z.string().nullable().default(null),
  worktree_name:    z.string().transform(asWorktreeName).nullable().default(null),
  worktree_path:    z.string().nullable().default(null),
  worktree_branch:  z.string().nullable().default(null),
  pid:              z.number().int().nullable().default(null),
  protocol_version: z.string(), // 必须等于 PROTOCOL_VERSION
});
export type Instance = z.infer<typeof InstanceSchema>;

export interface CreateInstanceInput {
  name:           string;
  role?:          InstanceRole;
  work_dir?:      string;
  worktree_name?: WorktreeName;
  worktree_path?: string;
  worktree_branch?: string;
}
```

### 3.2 Task（`task.ts`）

```ts
export const TaskLinkSchema = z.enum(["plan", "build", "verify", "review", "accept"]);
export const TaskStatusSchema = z.enum(["pending", "claimed", "completed", "blocked", "failed"]);
export const TaskPrioritySchema = z.number().int().min(0).max(2);

export const TaskSchema = z.object({
  id:                z.string().transform(asTaskId),
  title:             z.string(),
  description:       z.string().default(""),
  priority:          TaskPrioritySchema.default(1),
  status:            TaskStatusSchema.default("pending"),
  link:              TaskLinkSchema.nullable().default(null),
  chain_id:          z.string().transform(asChainId).nullable().default(null),
  task_doc_path:     z.string().nullable().default(null),
  result_path:       z.string().nullable().default(null),
  retry_count:       z.number().int().min(0).default(0),
  depends_on:        z.array(z.string().transform(asTaskId)).default([]),
  blocked_by:        z.array(z.string().transform(asTaskId)).default([]),
  blocked_reason:    z.string().nullable().default(null),
  fail_reason:       z.string().nullable().default(null),
  created_by:        z.string().transform(asInstanceId).nullable().default(null),
  created_by_name:   z.string().default(""),
  assigned_to:       z.string().transform(asInstanceId).nullable().default(null),
  assigned_to_name:  z.string().nullable().default(null),
  claimed_by:        z.string().transform(asInstanceId).nullable().default(null),
  completed_by_name: z.string().nullable().default(null),
  created_at:        z.string().datetime(),
  claimed_at:        z.string().datetime().nullable().default(null),
  completed_at:      z.string().datetime().nullable().default(null),
  duration_seconds:  z.number().nullable().default(null),
  leader_only:       z.boolean().default(false),
});
export type Task = z.infer<typeof TaskSchema>;

export interface CreateTaskInput {
  title:            string;
  description?:     string;
  priority?:        TaskPriority;
  link?:            TaskLink | null;
  chain_id?:        ChainId | null;
  task_doc_path?:   string | null;
  depends_on?:      readonly TaskId[];
  blocked_by?:      readonly TaskId[];
  created_by?:      InstanceId | null;
  created_by_name?: string;
  assigned_to?:     InstanceId | null;
  assigned_to_name?: string | null;
  leader_only?:     boolean;
}

export interface ClaimRecord {
  task_id:     TaskId;
  instance_id: InstanceId;
  claimed_at:  string; // ISO datetime
}
```

### 3.3 Message（`message.ts`）

```ts
export const MessageTypeSchema = z.enum([
  "direct",            // 普通定向消息
  "broadcast",         // 广播
  "task_dispatch",     // Leader → Worker 任务派发
  "completion_report", // Worker → Leader 完成回报
  "user_input",        // TUI 输入投递到 leader 自己的队列
  "help",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageSchema = z.object({
  id:               z.string().transform(asMessageId),
  type:             MessageTypeSchema.default("direct"),
  from_instance:    z.string().transform(asInstanceId),
  from_name:        z.string(),
  from_role:        z.string().default(""),
  to_instance:      z.string().transform(asInstanceId).nullable().default(null),
  to_name:          z.string().nullable().default(null),
  content:          z.string(),
  link:             TaskLinkSchema.nullable().default(null),
  task_id:          z.string().transform(asTaskId).nullable().default(null),
  chain_id:         z.string().transform(asChainId).nullable().default(null),
  task_title:       z.string().nullable().default(null),
  task_description: z.string().nullable().default(null),
  task_criteria:    z.string().nullable().default(null),
  task_doc_path:    z.string().nullable().default(null),
  result_path:      z.string().nullable().default(null),
  reply_to:         z.string().transform(asMessageId).nullable().default(null),
  read:             z.boolean().default(false),
  created_at:       z.string().datetime(),
});
export type Message = z.infer<typeof MessageSchema>;

export interface SendMessageInput {
  type:           MessageType;
  from_instance:  InstanceId;
  from_name:      string;
  from_role?:     string;
  to_instance:    InstanceId | null; // null = broadcast
  to_name?:       string | null;
  content:        string;
  link?:          TaskLink | null;
  task_id?:       TaskId | null;
  chain_id?:      ChainId | null;
  task_title?:    string | null;
  task_description?: string | null;
  task_criteria?: string | null;
  task_doc_path?: string | null;
  result_path?:   string | null;
  reply_to?:      MessageId | null;
}
```

### 3.4 ChainDef（`chain.ts`）

```ts
export const ChainTaskDefSchema = z.object({
  title:       z.string(),
  description: z.string(),
  criteria:    z.string(),
  priority:    TaskPrioritySchema,
});

export const ChainDefSchema = z.object({
  chain_id:    z.string().transform(asChainId),
  chain_title: z.string(),
  tasks: z.object({
    plan:   ChainTaskDefSchema.nullable(),
    build:  ChainTaskDefSchema,
    verify: ChainTaskDefSchema,
    review: ChainTaskDefSchema,
    accept: ChainTaskDefSchema,
  }),
});
export type ChainDef = z.infer<typeof ChainDefSchema>;
```

`plan` 字段为 `nullable`：当用户输入足够细化时，Leader 可以跳过 plan 链路直接从 build 开始；其余 4 个 link 必须存在。

### 3.5 EvalDecision（`eval.ts`）—— 4 个 variant 的判别联合

```ts
export const EvalDecisionKindSchema = z.enum([
  "activate_next",
  "feedback",
  "reject",
  "close_chain",
]);
export type EvalDecisionKind = z.infer<typeof EvalDecisionKindSchema>;

export const EvalDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision:          z.literal("activate_next"),
    reason:            z.string(),
    next_link:         TaskLinkSchema,
    suggested_worker:  z.string().transform(asInstanceId).nullable().optional(),
  }),
  z.object({
    decision:           z.literal("feedback"),
    reason:             z.string(),
    feedback_to_worker: z.string(),
    feedback_target:    z.string().transform(asInstanceId).nullable().optional(),
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
export type EvalDecision = z.infer<typeof EvalDecisionSchema>;
```

`activate_next` 是默认走向；`feedback` 表示 Worker 自评判定需要前一链路修改；`reject` 与 `close_chain` 都终结当前 chain，区别是失败 / 成功收尾。

### 3.6 MergeDecision（`merge.ts`）

```ts
export const MergeDecisionKindSchema = z.enum(["merge", "skip", "review_first"]);
export type MergeDecisionKind = z.infer<typeof MergeDecisionKindSchema>;

export const MergeDecisionSchema = z.object({
  decision:           MergeDecisionKindSchema,
  reason:             z.string(),
  conflict_files:     z.array(z.string()).default([]),
  reviewed_branches:  z.array(z.string()).default([]),
});
export type MergeDecision = z.infer<typeof MergeDecisionSchema>;
```

---

## 4. Input vs Record 双类型

约定：

- `XxxSchema` / `Xxx` —— **Record 类型**：ZK 中已存在的完整记录，含 `id`、`created_at`、`status` 等运行时填充字段。读端始终拿 Record。
- `CreateXxxInput` / `SendXxxInput` —— **Input 类型**：调用方在构造请求时填的子集；ZK 写入流程负责补齐缺省字段。

> 这避免了"我到底要不要传 id"的语义混淆：调用方永远传 Input；ZK 创建 → 返回 Record。

---

## 5. 判别联合一览

### 5.1 LeaderEvent（17 variant）—— `events.ts`

```ts
export type LeaderEvent =
  | { type: "worker_joined";              instance: Instance }
  | { type: "worker_left";                instance_id: InstanceId; name: string }
  | { type: "worker_status_changed";      instance_id: InstanceId; status: InstanceStatus }
  | { type: "worker_message_received";    instance_id: InstanceId; message_id: MessageId;
                                          content: string; link: TaskLink | null;
                                          timestamp: string }
  | { type: "task_created";               task: Task }
  | { type: "task_claimed";               task_id: TaskId; instance_id: InstanceId }
  | { type: "task_completed";             task_id: TaskId; instance_id: InstanceId;
                                          duration_seconds: number | null }
  | { type: "task_blocked";               task_id: TaskId; reason: string }
  | { type: "task_failed";                task_id: TaskId; reason: string }
  | { type: "task_recovered";             task_id: TaskId; retry_count: number }
  | { type: "task_dependency_resolved";   task_id: TaskId }
  | { type: "message_sent";               from: InstanceId; to: InstanceId | null;
                                          message_type: MessageType }
  | { type: "message_received";           from: InstanceId; message_id: MessageId;
                                          content: string }
  | { type: "message_processed";          message_id: MessageId; log_path: string }
  | { type: "chain_activated";            chain_id: ChainId }
  | { type: "debug_info";                 message: string }
  | { type: "stream_chunk";               instance_id: InstanceId; chunk: string };
```

消费端用 `switch (event.type)` + `assertNever(event)` 强制穷尽。

### 5.2 HookEvent（6 variant，闭合集合）—— `hooks.ts`

```ts
export type HookEvent =
  | { type: "leader_message_start";  env: LeaderMessageEnv }
  | { type: "leader_message_end";    env: LeaderMessageEnv & { exit_code: number } }
  | { type: "worker_message_start";  env: WorkerMessageEnv }
  | { type: "worker_message_end";    env: WorkerMessageEnv & { exit_code: number } }
  | { type: "task_claimed";          env: TaskHookEnv }
  | { type: "task_completed";        env: TaskHookEnv & { duration_seconds: number | null } }
  | { type: "chain_activated";       env: { CO_CHAIN_ID: ChainId } }
  | { type: "merge_decision_made";   env: { CO_DECISION: MergeDecisionKind;
                                            CO_BRANCH: string; CO_REASON: string } };

export interface LeaderMessageEnv {
  CO_LEADER_ID:   InstanceId;
  CO_MESSAGE_ID:  MessageId;
  CO_LINK:        TaskLink | "";
  CO_LOG_PATH:    string;
}

export interface WorkerMessageEnv {
  CO_WORKER_NAME: string;
  CO_WORKER_ID:   InstanceId;
  CO_TASK_ID:     TaskId | "";
  CO_LINK:        TaskLink | "";
  CO_CHAIN_ID:    ChainId | "";
  CO_LOG_PATH:    string;
  CO_RESULT_PATH: string;
}

export interface TaskHookEnv {
  CO_TASK_ID: TaskId;
  CO_LINK:    TaskLink | "";
  CO_CHAIN_ID: ChainId | "";
}
```

**闭合集合**：v0.5 不支持自定义 hook 名（未列出的事件名直接拒绝注册）。v0.6 候选：扩展机制。

### 5.3 其他常用判别字段

| 字段 | 取值 |
|------|------|
| `Task.status` | `pending / claimed / completed / blocked / failed` |
| `Instance.status` | `idle / busy` |
| `Instance.role` | `planner / builder / verifier / reviewer / accepter / leader` |
| `Task.link` | `plan / build / verify / review / accept`（或 `null`） |
| `MessageType` | `direct / broadcast / task_dispatch / completion_report / user_input / help` |
| `EvalDecisionKind` | `activate_next / feedback / reject / close_chain` |
| `MergeDecisionKind` | `merge / skip / review_first` |

---

## 6. 跨层接口（`packages/contracts/src/interfaces/`）

接口本身位于 `@co/contracts`；实现位于对应的实现包。

### 6.1 `IZkClient`（`interfaces/zk.ts`）

```ts
export interface ZkStat {
  version: number;
  ctime: number;
  mtime: number;
  // ...subset of node-zookeeper-client Stat
}

export interface IZkClient {
  connect(): Promise<void>;
  close(): Promise<void>;

  exists(path: ZkPath): Promise<boolean>;
  createPersistent(path: ZkPath, data: Buffer): Promise<ZkPath>;
  createPersistentSequential(parent: ZkPath, prefix: string, data: Buffer): Promise<ZkPath>;
  createEphemeral(path: ZkPath, data: Buffer): Promise<ZkPath>;
  createEphemeralSequential(parent: ZkPath, prefix: string, data: Buffer): Promise<ZkPath>;
  setData(path: ZkPath, data: Buffer, expectedVersion?: number): Promise<ZkStat>;
  getData(path: ZkPath): Promise<{ data: Buffer; stat: ZkStat }>;
  getChildren(path: ZkPath): Promise<string[]>;
  watchChildren(path: ZkPath, cb: (children: string[]) => void): Promise<string[]>;
  watchData(path: ZkPath, cb: (data: Buffer | null) => void): Promise<Buffer | null>;
  delete(path: ZkPath, expectedVersion?: number): Promise<void>;
  mkdirp(path: ZkPath): Promise<void>;

  readonly state: "connecting" | "connected" | "disconnected" | "expired";
  on(event: "expired" | "disconnected" | "reconnected", cb: () => void): void;
}
```

### 6.2 Coordination（`interfaces/coordination.ts`）

```ts
export interface ITaskQueue {
  push(input: CreateTaskInput): Promise<Task>;
  claim(claimer: InstanceId, role: InstanceRole): Promise<Task | null>;
  complete(taskId: TaskId, result: string, by: InstanceId, completedByName: string,
           durationSeconds: number | null): Promise<void>;
  block(taskId: TaskId, reason: string): Promise<void>;
  fail(taskId: TaskId, reason: string): Promise<void>;
  retry(taskId: TaskId): Promise<Task>;
  listPending(): Promise<Task[]>;
  listClaimed(): Promise<ClaimRecord[]>;
  getPending(taskId: TaskId): Promise<Task | null>;
  getCompleted(taskId: TaskId): Promise<Task | null>;
  watchPending(cb: (children: TaskId[]) => void): Promise<TaskId[]>;
  watchClaimed(cb: (records: ClaimRecord[]) => void): Promise<ClaimRecord[]>;
}

export interface IMessageRouter {
  send(input: SendMessageInput): Promise<Message>;
  poll(instanceId: InstanceId): Promise<Message[]>;
  waitForMessage(instanceId: InstanceId, cb: (msg: Message) => void): Promise<void>;
  dismiss(instanceId: InstanceId, messageId: MessageId): Promise<void>;
}

export interface IInstanceRegistry {
  register(input: CreateInstanceInput): Promise<Instance>;
  unregister(instanceId: InstanceId): Promise<void>;
  heartbeat(instanceId: InstanceId, patch: Partial<Instance>): Promise<void>;
  list(): Promise<Instance[]>;
  get(instanceId: InstanceId): Promise<Instance | null>;
  watch(cb: (instances: Instance[]) => void): Promise<Instance[]>;
}
```

### 6.3 Runtime（`interfaces/runtime.ts`）

```ts
export interface RunOptions {
  prompt:                string;
  log_path:              string;
  system_prompt?:        string;       // --append-system-prompt
  resume_session_id?:    SessionId;    // --resume <id>
  fork_session?:         boolean;      // --fork-session
  cwd?:                  string;
  on_chunk?:             (chunk: StreamChunk) => void;
  quiet?:                boolean;
}

export interface StreamChunk {
  raw:      string;            // 原始 JSON 行
  text?:    string;            // 提取出来的文本片段（若可）
  is_final: boolean;
}

export interface RunResult {
  exit_code:   number;
  session_id:  SessionId | null;
  log_path:    string;
}

export interface IClaudeRunner {
  run(opts: RunOptions): Promise<RunResult>;
}

export interface ITemplateEngine {
  load(name: string): string;
  render(name: string, vars: Record<string, string>): string;
}

export interface IHookEngine {
  fire(event: HookEvent): Promise<void>;
}
```

`IClaudeRunner.run` 内部强制追加 `--output-format stream-json --verbose`；`session_id` 从最后一条 stream-json 中提取，失败返回 `null`。

### 6.4 EventBus（`interfaces/eventBus.ts`）

```ts
export interface IEventBus<T extends { type: string }> {
  emit(event: T): void;
  on<K extends T["type"]>(
    type: K,
    cb: (event: Extract<T, { type: K }>) => void,
  ): () => void; // 返回 off()
  onAny(cb: (event: T) => void): () => void;
}
```

### 6.5 StateView（`interfaces/stateView.ts`）

```ts
export interface ILeaderStateView {
  readonly workers:               readonly WorkerInfo[];
  readonly pending_tasks:         readonly Task[];
  readonly in_progress_tasks:     readonly Task[];
  readonly events:                readonly LeaderEvent[];
  readonly selected_worker_index: number;
}

export interface WorkerInfo {
  readonly id:                   InstanceId;
  readonly name:                 string;
  readonly preset_role:          InstanceRole;
  readonly current_role:         InstanceRole | null;
  readonly status:               InstanceStatus | "failed";
  readonly current_task_id:      TaskId | null;
  readonly worktree_name:        WorktreeName | null;
  readonly worktree_path:        string | null;
  readonly worktree_branch:      string | null;
  readonly pid:                  number | null;
  readonly current_message:      string | null;
  readonly current_message_link: TaskLink | null;
  readonly current_message_time: string | null;
  readonly message_history:      readonly WorkerMessageEntry[];
  readonly last_completed_task:  TaskId | null;
}

export interface WorkerMessageEntry {
  readonly message_id: MessageId;
  readonly content:    string;
  readonly link:       TaskLink | null;
  readonly timestamp:  string;
}
```

**只读约束**：`@co/leader` 内部可持有可变 `LeaderState`，但对外只能 `as ILeaderStateView` 暴露。

---

## 7. 角色权重表（`roleWeights.ts`）

```ts
export const ROLE_WEIGHTS: Readonly<Record<InstanceRole, Readonly<Record<TaskLink, number>>>> = {
  planner:  { plan: 100, build:  10, verify:  10, review:  20, accept:  10 },
  builder:  { plan:  10, build: 100, verify:  20, review:  10, accept:  10 },
  verifier: { plan:  10, build:  20, verify: 100, review:  20, accept:  10 },
  reviewer: { plan:  20, build:  10, verify:  20, review: 100, accept:  20 },
  accepter: { plan:  10, build:  10, verify:  10, review:  20, accept: 100 },
  leader:   { plan:   0, build:   0, verify:   0, review:   0, accept:   0 },
};
```

`ITaskQueue.claim` 的排序键：

1. `task.assigned_to === claimer` （硬指派）→ 优先级最高
2. `ROLE_WEIGHTS[claimer.role][task.link]` 越大越优先（任意非零值都允许认领）
3. `task.priority`（0 = HIGH 最高）
4. 创建顺序（FIFO）

Leader 自身 `role = leader`，所有权重为 0 —— Leader **不**认领普通任务；只通过 `leader_only = true` 的特殊任务被分派。

---

## 8. 错误模型（`errors.ts`）

完整状态机与边界规则参见 [`error-and-recovery.md`](error-and-recovery.md)。本节只列类层级。

```ts
export class CoError extends Error {
  constructor(
    public readonly code: string,        // 稳定错误码，eg "ZK_SESSION_EXPIRED"
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

// ── ZK ──
export class ZkError              extends CoError {}
export class ZkSessionExpiredError extends ZkError {}
export class ZkNodeExistsError    extends ZkError {}
export class ZkNodeNotFoundError  extends ZkError {}

// ── 协议/校验 ──
export class ValidationError      extends CoError {} // 包 ZodError
export class ProtocolVersionMismatchError extends CoError {}

// ── 运行时 ──
export class ClaudeRunnerError    extends CoError {}
export class TemplateNotFoundError extends CoError {}
export class HookError            extends CoError {}

// ── 业务 ──
export class MergeConflictError   extends CoError {}
export class WorktreeError        extends CoError {}
export class OrphanRetryExhaustedError extends CoError {}
```

**错误码命名约定**：`<DOMAIN>_<REASON>`，全大写、下划线分隔。`code` 字段稳定，可被日志聚合 / 监控规则引用；`message` 可变（仅供人读）。

---

## 9. 日志契约（`logging.ts`）

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ILogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string,  ctx?: Record<string, unknown>): void;
  warn(msg: string,  ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(namespace: string): ILogger;
}
```

注入约定：

- 所有 Layer ≥1 的类构造函数必须显式接收 `logger: ILogger`。
- 模块内部用 `this.logger.child("leader/chain-router")` 派生命名空间。
- **禁止** `console.*`（CLI 与 TUI 的最终输出汇接除外）。
- `ctx` 中可放 `{ task_id, instance_id, ... }`，由 Logger 实现序列化。

---

## 10. 路径函数（`paths/`）

### 10.1 `zkPaths.ts`

```ts
export interface ZkPathOptions {
  project_id?: ProjectId;  // opt-in；不传则使用默认 root
}

export const DEFAULT_ROOT: ZkPath = "/claude-orchestrator" as ZkPath;
export const projectRoot = (opts?: ZkPathOptions): ZkPath =>
  opts?.project_id ? (`/co/${opts.project_id}` as ZkPath) : DEFAULT_ROOT;

export const leader        = (o?: ZkPathOptions): ZkPath => `${projectRoot(o)}/leader` as ZkPath;
export const instances     = (o?: ZkPathOptions): ZkPath => `${projectRoot(o)}/instances` as ZkPath;
export const instance      = (id: InstanceId, o?: ZkPathOptions): ZkPath => `${instances(o)}/${id}` as ZkPath;
export const tasksRoot     = (o?: ZkPathOptions): ZkPath => `${projectRoot(o)}/tasks` as ZkPath;
export const tasksPending  = (o?: ZkPathOptions): ZkPath => `${tasksRoot(o)}/pending` as ZkPath;
export const tasksClaimed  = (o?: ZkPathOptions): ZkPath => `${tasksRoot(o)}/claimed` as ZkPath;
export const tasksCompleted = (o?: ZkPathOptions): ZkPath => `${tasksRoot(o)}/completed` as ZkPath;
export const taskPending   = (taskId: TaskId, o?: ZkPathOptions): ZkPath => `${tasksPending(o)}/${taskId}` as ZkPath;
export const taskClaimed   = (insId: InstanceId, taskId: TaskId, o?: ZkPathOptions): ZkPath =>
  `${tasksClaimed(o)}/${insId}-${taskId}` as ZkPath;
export const taskCompleted = (taskId: TaskId, o?: ZkPathOptions): ZkPath => `${tasksCompleted(o)}/${taskId}` as ZkPath;
export const messages      = (o?: ZkPathOptions): ZkPath => `${projectRoot(o)}/messages` as ZkPath;
export const messageDir    = (insId: InstanceId, o?: ZkPathOptions): ZkPath => `${messages(o)}/${insId}` as ZkPath;
export const message       = (insId: InstanceId, msgId: MessageId, o?: ZkPathOptions): ZkPath =>
  `${messageDir(insId, o)}/${msgId}` as ZkPath;

export const allEnsurePaths = (o?: ZkPathOptions): readonly ZkPath[] => [
  projectRoot(o), instances(o), tasksRoot(o), tasksPending(o),
  tasksClaimed(o), tasksCompleted(o), messages(o),
];
```

**多项目隔离规则（opt-in）**：

- `ZkPathOptions.project_id` 不传 → 全部路径在 `/claude-orchestrator/...`。
- 传 `project_id = "myapp"` → 全部路径在 `/co/myapp/...`。

`ConfigLoader` 把 `Config.project_id` 透传给 `zkPaths` 构造调用。

### 10.2 `cachePaths.ts`

```ts
export interface CachePathOptions {
  cache_dir:         string;          // 绝对路径
  leader_instance_id: InstanceId;
}

export const leaderCacheDir = (o: CachePathOptions): string =>
  `${o.cache_dir}/${o.leader_instance_id}`;

export const taskDocPath   = (o: CachePathOptions, seq: number): string =>
  `${leaderCacheDir(o)}/tasks/task-${seq}.md`;
export const taskLogPath   = (o: CachePathOptions, taskId: TaskId, ts: string): string =>
  `${leaderCacheDir(o)}/logs/task-${taskId}-${ts}.log`;
export const taskResultPath = (o: CachePathOptions, taskId: TaskId): string =>
  `${leaderCacheDir(o)}/results/task-${taskId}.md`;
export const evalLogPath   = (o: CachePathOptions, taskId: TaskId, attempt: number): string =>
  `${leaderCacheDir(o)}/evals/task-${taskId}-attempt-${attempt}.log`;
export const commitLogPath = (o: CachePathOptions, taskId: TaskId): string =>
  `${leaderCacheDir(o)}/commits/task-${taskId}.log`;
export const messageLogPath = (o: CachePathOptions, messageId: MessageId): string =>
  `${leaderCacheDir(o)}/messages/${messageId}.log`;
```

`StreamTailer`（Leader 侧）与 `ClaudeRunner`（Worker 侧）都从 **同一个** `cachePaths` 构造路径，避免约定漂移。

---

## 11. 配置类型（`config.ts`）

```ts
export interface ZkConfig {
  hosts: string;              // "zk-1:2181,zk-2:2181"
  session_timeout_ms: number; // default 30000
  project_id?: ProjectId;     // opt-in 多项目隔离
}

export interface CommandsConfig {
  claude_cli: string;         // 默认 "claude"
  git:        string;         // 默认 "git"
}

export interface HookCommand {
  event:   HookEvent["type"];
  command: string;            // shell
  enabled: boolean;
}

export interface InitStatusEntry {
  step_id:     string;
  level:       "Safe" | "Caution" | "Danger";
  decided_at:  string;        // ISO datetime
  decision:    "approved" | "skipped" | "auto";
}

export interface ResolvedConfig {
  zk:              ZkConfig;
  cache_dir:       string;
  commands:        CommandsConfig;
  hooks:           readonly HookCommand[];
  init_status:     readonly InitStatusEntry[];
  instance_id:     InstanceId | null;
  name:            string | null;
  role:            InstanceRole | null;
  debug:           boolean;
}
```

合并优先级（高优先级覆盖低优先级）：

1. CLI flags
2. 环境变量（`ZK_HOSTS / CO_CACHE_DIR / ...`）
3. 当前 worktree 的 `.claude-orchestrator/config.json`（如位于 worktree 内）
4. 项目根 `.claude-orchestrator/config.json`
5. 全局 `~/.claude-orchestrator/config.json`

`ConfigLoader`（位于 `@co/infra`）按此顺序逐层合并，最终输出 `ResolvedConfig`。

---

## 12. 协议版本（`protocol.ts`）

```ts
export const PROTOCOL_VERSION = "0.5.0" as const;

export interface LeaderNodeData {
  protocol_version: typeof PROTOCOL_VERSION;
  leader_id:        InstanceId;
  pid:              number;
  host:             string;
  started_at:       string;
}
```

详细每节点 wire-format 见 [`protocol.md`](protocol.md)。

---

## 13. 与现有源码的差异（迁移备注）

为后续 v0.5 代码落地铺路，本节列出 `@co/contracts` 相对当前 `src/models/schemas.ts` 的差异：

| 差异 | 现状 | v0.5 contracts |
|------|------|----------------|
| Branded IDs | 无；全部 `string` | 全部 ID 都 brand |
| `Message.type` 取值 | `direct / broadcast / help` | 增加 `task_dispatch / completion_report / user_input` |
| `Message.task_id / chain_id / link` | 已有 | 类型变为 brand |
| `EvalDecision` | 三态：`activate_next / feedback / close_chain`；`reject` 缺失；扁平字段 | 四态判别联合（discriminatedUnion）；每个 variant 字段不同 |
| `ChainDef.plan` | 非 nullable | 允许 `nullable`（可跳过 plan 链路） |
| `MergeDecision` | 暂无 schema | 新增 `MergeDecisionSchema` |
| `Task.task_doc_path / result_path` | 在 Message 上有，Task 上没有 | Task 自带，便于 ZK 单点查询 |
| `protocol_version` | 无 | Instance + LeaderNodeData 都带 |
| `created_at` | `z.string()` | `z.string().datetime()` 强约束 ISO |
| `Instance.role` | 含 `leader` | 保留，但 Leader 不参与普通任务认领（权重表) |
| `HookEvent` | engine 接收 free-form 字符串 | 闭合判别联合 |
| `IClaudeRunner.run` 选项 | runner.ts 直接函数参数 | 通过 `RunOptions` 入参 |

---

## 14. 一句话总结

> `@co/contracts` 是 v0.5 的"协议字典"——其他所有包都从这里取类型；这里改一行，整个仓库必须重新过 `tsc`。把字典抓紧，协议就稳。
