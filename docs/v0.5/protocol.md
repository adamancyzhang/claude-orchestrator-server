# Protocol — v0.5 ZooKeeper Wire-Format 协议参考

> **文档定位**：本文是 v0.5 中所有写入 ZooKeeper 的 JSON 形状的**规范来源**。任何 ZK 节点的数据形状必须先在这里定义、再由 `@co/contracts` 提供 Schema、最后由 `@co/coordination` 写入。
>
> 类型与 Zod schema 的定义见 [`contracts.md`](contracts.md)；节点树的散文叙述与 watch 重挂载策略见 [`zookeeper-schema.md`](zookeeper-schema.md)；错误处理见 [`error-and-recovery.md`](error-and-recovery.md)。

---

## 1. 协议版本与兼容策略

```ts
export const PROTOCOL_VERSION = "0.5.0";
```

**不向后兼容**：v0.5 与 v0.3 / v0.4 的 ZK 节点结构均不兼容。升级路径：

1. 升级前停止旧版 Leader 与 Workers。
2. 清空旧 root（默认 `/claude-orchestrator`，多项目模式见 §7）。
3. 启动 v0.5。

**启动检查**：

- Leader 启动时把 `protocol_version: "0.5.0"` 写入 `/leader` 节点的 metadata。
- Worker 启动时读取 `/leader`：若 `protocol_version` 与自身常量不匹配 → 抛 `ProtocolVersionMismatchError`，退出。
- 多个 Workers 不互相校验版本（信任 Leader 已校验）。

**minor 升级**（v0.5.0 → v0.5.1）：仅允许向 Schema 添加 `.optional()` / `.default(...)` 字段、或向 enum 添加新值。任何破坏性改动直接进入 v0.6。

---

## 2. 节点树总览

```
{project_root}/
├── leader                                EPHEMERAL    LeaderNodeData
├── instances/
│   └── {instance_id}                     EPHEMERAL    Instance
├── tasks/
│   ├── pending/
│   │   └── task-{seq:010d}               PERSISTENT_SEQUENTIAL  Task
│   ├── claimed/
│   │   └── {instance_id}-{task_id}       EPHEMERAL    ClaimRecord
│   └── completed/
│       └── {task_id}                     PERSISTENT   TaskCompleted
└── messages/
    └── {instance_id}/
        └── msg-{seq:010d}                PERSISTENT_SEQUENTIAL  Message
```

`{project_root}` 默认 `/claude-orchestrator`；启用多项目时为 `/co/{project_id}`（见 §7）。

`{seq:010d}` 表示 ZK 自动分配的 10 位零填充序列号（`createPersistentSequential` / `createEphemeralSequential` 行为）。

所有 JSON 序列化按 **UTF-8** 写入；字段名一律 **snake_case**；所有时间字段为 **ISO 8601 UTC**（带 `Z` 后缀）。

---

## 3. 节点 wire-format 详解

### 3.1 `/leader`

- **类型**：`EPHEMERAL`，单例
- **创建者**：Leader 启动时
- **删除时机**：Leader 进程退出 / ZK 会话过期 → 触发 worker 重试逻辑
- **Schema**：`LeaderNodeData`（见 `contracts.md` §12）

```json
{
  "protocol_version": "0.5.0",
  "leader_id": "f8a3b1c2e9d04567",
  "pid": 12345,
  "host": "hostname.local",
  "started_at": "2026-05-14T08:30:00.000Z"
}
```

**写入时机**：Leader 启动第 3 阶段，`/leader` 节点已不存在时（旧 Leader 已退出）。
**冲突处理**：`createEphemeral` 失败（节点已存在）→ Leader 抛错退出，由外层 `run` 命令报告"已有 Leader 正在运行"。

### 3.2 `/instances/{instance_id}`

- **类型**：`EPHEMERAL`
- **创建者**：Worker 子进程（或 Leader 自身的 `leader` 角色 instance）
- **节点名**：`{instance_id}` —— Worker 启动时持久化在 worktree 的 `config.json.instance_id`，跨重启复用
- **Schema**：`Instance`（见 `contracts.md` §3.1）

```json
{
  "id": "a91b2c3d4e5f6789",
  "name": "Tom",
  "role": "builder",
  "status": "idle",
  "current_task_id": null,
  "connected_since": "2026-05-14T08:30:05.123Z",
  "work_dir": "/abs/path/repo/.claude-orchestrator/worktree/Tom",
  "worktree_name": "Tom",
  "worktree_path": "/abs/path/repo/.claude-orchestrator/worktree/Tom",
  "worktree_branch": "claude-orchestrator/Tom-workspace",
  "pid": 12378,
  "protocol_version": "0.5.0"
}
```

**写入时机**：

- 启动注册：`createEphemeral(instance_path, JSON.stringify(instance))`。
- 状态变更：`setData(instance_path, JSON.stringify({ ...prev, status, current_task_id }))`。

**Watch**：Leader 的 `WorkerMonitor` 对 `/instances` 设 child watch；任何子节点增删都重新拉一遍 list 并 diff。

### 3.3 `/tasks/pending/task-{seq}`

- **类型**：`PERSISTENT_SEQUENTIAL`
- **创建者**：ChainRouter（来自用户输入解析或 EvalDecision activate_next），或 CLI `push-task` 命令
- **节点名**：ZK 分配的 `task-0000000123` 形式；该字符串即 `Task.id`
- **Schema**：`Task`（status 必为 `"pending"`）

```json
{
  "id": "task-0000000123",
  "title": "构建用户认证模块",
  "description": "...",
  "priority": 1,
  "status": "pending",
  "link": "build",
  "chain_id": "chain-2026-05-14-abc123",
  "task_doc_path": "tasks/task-0000000123.md",
  "result_path": null,
  "retry_count": 0,
  "depends_on": [],
  "blocked_by": [],
  "blocked_reason": null,
  "fail_reason": null,
  "created_by": "f8a3b1c2e9d04567",
  "created_by_name": "leader",
  "assigned_to": null,
  "assigned_to_name": null,
  "claimed_by": null,
  "completed_by_name": null,
  "created_at": "2026-05-14T08:31:00.000Z",
  "claimed_at": null,
  "completed_at": null,
  "duration_seconds": null,
  "leader_only": false
}
```

**Watch**：Leader 的 `TaskOrchestrator` 对 `/tasks/pending` 设 child watch；新子节点 → 发 `task_created` 事件，进入 TUI 列表。

### 3.4 `/tasks/claimed/{instance_id}-{task_id}`

- **类型**：`EPHEMERAL`
- **创建者**：`ITaskQueue.claim` 内部，原子持锁
- **节点名**：`{instance_id}-{task_id}`（`-` 拼接，前者来自 instance，后者来自 task）
- **数据**：`ClaimRecord`（与 Task **不同**，只携带必要的锁信息；完整任务数据保留在 `/tasks/pending` 的 mirror 副本，或被 claim 操作移动到 `/tasks/claimed/{...}` 的 data 段。本协议规定**两套并存**——节点名是锁，节点 data 是任务快照）

```json
{
  "task_id": "task-0000000123",
  "instance_id": "a91b2c3d4e5f6789",
  "claimed_at": "2026-05-14T08:31:05.456Z",
  "task_snapshot": {
    "id": "task-0000000123",
    "title": "构建用户认证模块",
    "...": "完整 Task 对象镜像"
  }
}
```

**为何带 `task_snapshot`**：

- `/tasks/pending/{...}` 在 claim 时被删除（move 语义），claim 后 Worker 必须从 `/tasks/claimed/{...}` 直接读到任务数据，不再回访 pending。
- 节点 EPHEMERAL：Worker 断线 → 节点自动消失 → `Recovery` 视为孤儿。`task_snapshot` 让 `Recovery` 不需要再去别处找原始数据，直接把它写回 pending（`retry_count++`）。

**Watch**：

- Leader `TaskOrchestrator` 对 `/tasks/claimed` 设 child watch（增减都跟踪）；
- Leader `Recovery` 启动时一次性 listChildren，对每个节点 `getData` 拿到 `task_snapshot`，再与 `/instances` 当前列表交叉对照，识别孤儿。

### 3.5 `/tasks/completed/{task_id}`

- **类型**：`PERSISTENT`
- **创建者**：`ITaskQueue.complete / fail`
- **节点名**：原 `task_id` 字符串
- **Schema**：`Task` 完整记录 + 额外 `commit` 对象

```json
{
  "id": "task-0000000123",
  "title": "构建用户认证模块",
  "status": "completed",
  "...": "...",
  "result": "实现说明、变更文件列表、自评估摘要...",
  "claimed_by": "a91b2c3d4e5f6789",
  "completed_by_name": "Tom",
  "duration_seconds": 184.7,
  "completed_at": "2026-05-14T08:34:09.000Z",
  "commit": {
    "sha": "9f3a1b2c...",
    "message": "feat(auth): add user authentication module\n\n- ...",
    "branch": "claude-orchestrator/Tom-workspace",
    "changed_files": ["src/auth/index.ts", "src/auth/types.ts"],
    "untracked_files": []
  }
}
```

`fail` 状态时 `commit` 为 `null`、`fail_reason` 必填；`retry_count` 已达上限的失败也归档于此（status = `"failed"`）。

**生命周期**：v0.5 不主动清理 `/tasks/completed`；CLI 提供 `task-prune` 命令（v0.6 候选）。

### 3.6 `/messages/{instance_id}/msg-{seq}`

- **类型**：`PERSISTENT_SEQUENTIAL`
- **创建者**：`IMessageRouter.send`
- **节点名**：ZK 分配的 `msg-0000000123` 形式；该字符串即 `Message.id`
- **Schema**：`Message`（见 `contracts.md` §3.3）

```json
{
  "id": "msg-0000000087",
  "type": "task_dispatch",
  "from_instance": "f8a3b1c2e9d04567",
  "from_name": "leader",
  "from_role": "leader",
  "to_instance": "a91b2c3d4e5f6789",
  "to_name": "Tom",
  "content": "请执行 build 链路...",
  "link": "build",
  "task_id": "task-0000000123",
  "chain_id": "chain-2026-05-14-abc123",
  "task_title": "构建用户认证模块",
  "task_description": "...",
  "task_criteria": "...",
  "task_doc_path": "tasks/task-0000000123.md",
  "result_path": "results/task-0000000123.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T08:31:06.000Z"
}
```

**`read` 字段**：Worker 处理完一条消息后 `setData(path, { ...msg, read: true })`，不删除节点（保留历史以便 Leader StreamTailer 与离线分析）。

**广播**：`type = "broadcast"`，`to_instance = null`；发送者通过 `IInstanceRegistry.list()` 获取全部 Worker 后**逐一**写入各自的 `/messages/{instance_id}/` 路径下。（ZK 没有真正的发布订阅，本协议规定广播为"扇出复制"。）

**Watch**：每个 Worker / Leader 对自己 `/messages/{my_id}` 设 child watch；新子节点 → 入处理流水线。

---

## 4. Message Envelope 与 ChainRouter 分支判别规则

Leader 的 `LeaderWatcher` 接收 `/messages/{leader_id}/*` 后传给 `ChainRouter`。`ChainRouter` 根据 `Message.type` + `content` 内容分三类：

### 4.1 `type === "completion_report"`

- **来源**：Worker 完成 chain-link 任务后回报
- **`content`**：`JSON.stringify(EvalDecision)`
- **判别规则**：先 `EvalDecisionSchema.safeParse(JSON.parse(content))`；解析失败 → `ChainRouter` 视为协议违规，记录 `task_failed`。
- **处理**：依 `EvalDecision.decision` 字段分支：
  - `activate_next` → `ITaskQueue.push` 创建下一 link 的 task；`task_id` / `chain_id` 由 router 填充
  - `feedback` → 重新派发上一 link，content 中带 `feedback_to_worker`
  - `reject` → 关 chain，状态 `failed`
  - `close_chain` → 关 chain，状态 `completed`

### 4.2 `type === "user_input"` + content 是 ChainDef JSON

- **来源**：Leader 自处理 decompose 后再次往自己消息队列投递
- **判别规则**：`ChainDefSchema.safeParse(JSON.parse(content))` 成功
- **处理**：按 5 个 link 创建 5 个 task 入 pending（`plan` 为 null 则跳过 plan）；`chain_id` 取 ChainDef 自带。

### 4.3 `type === "user_input"` + content 是自由文本

- **来源**：TUI 键盘输入
- **判别规则**：以上两种 parse 都失败 → 当作自然语言任务
- **处理**：
  - 若 `templates/agents/worker-decompose.md` 已加载且开启 self-decompose → Leader 自身调用 ClaudeRunner 渲染 decompose 模板，输出 ChainDef，回投递到自己消息队列（走 §4.2 分支）；
  - 否则 → 发 `task_dispatch` 给一个有 planner 权重的 Worker，让它 decompose。

> **协议要求**：`content` 字段为字符串；如果是 JSON 则**整体**作为 JSON 写入，**不**做转义 wrap。Parser 必须 try-catch JSON.parse，失败回退到自由文本分支。

---

## 5. EvalDecision Wire-format（4 个 variant）

放在 `Message.content` 字段中（外层 Message 仍是普通 Message envelope）。

### 5.1 `activate_next`

```json
{
  "decision": "activate_next",
  "reason": "blueprint 完整、依赖清晰，可进入实现",
  "next_link": "build",
  "suggested_worker": "a91b2c3d4e5f6789"
}
```

- `next_link` 必须是 `TaskLink` 枚举之一，**不能**等于当前 link（防止自循环）。
- `suggested_worker` 可省略；存在时由 `ChainRouter` 转为 `Task.assigned_to`，但仍可被其他 Worker 抢占（hint，不是 hard lock）。

### 5.2 `feedback`

```json
{
  "decision": "feedback",
  "reason": "blueprint 缺少错误处理章节",
  "feedback_to_worker": "请在 blueprint 中补充错误码定义与降级策略",
  "feedback_target": "b18c4d5e6f7890ab"
}
```

- 必须重新派发到**前一**链路（不指定 `next_link`，ChainRouter 自动取 prev）。
- `feedback_target` 可指定原 Worker 的 `instance_id`；不指定时由 ChainRouter 按 `ROLE_WEIGHTS` 找一个匹配 prev_link 的 Worker。

### 5.3 `reject`

```json
{
  "decision": "reject",
  "reason": "需求与现有架构冲突，无法继续"
}
```

- chain 立即终结，归档为 `failed`；TUI 高亮显示。

### 5.4 `close_chain`

```json
{
  "decision": "close_chain",
  "reason": "accept 通过，所有验收条件满足"
}
```

- chain 正常关闭，归档为 `completed`。

---

## 6. ChainDef Wire-format

放在 `Message.content` 字段中（type=`user_input`）。

```json
{
  "chain_id": "chain-2026-05-14-abc123",
  "chain_title": "用户认证模块",
  "tasks": {
    "plan": {
      "title": "认证模块蓝图",
      "description": "...",
      "criteria": "...",
      "priority": 0
    },
    "build": {
      "title": "实现认证模块",
      "description": "...",
      "criteria": "...",
      "priority": 1
    },
    "verify": { "title": "...", "description": "...", "criteria": "...", "priority": 1 },
    "review": { "title": "...", "description": "...", "criteria": "...", "priority": 1 },
    "accept": { "title": "...", "description": "...", "criteria": "...", "priority": 2 }
  }
}
```

**依赖映射规则**：ChainRouter 按 `plan → build → verify → review → accept` 的顺序生成 5 个 task；每个 task 的 `depends_on` 自动指向前一 link 的 `task_id`（plan 为 null 时 build 的 `depends_on` 为 `[]`）。

**`plan = null` 含义**：用户提供的需求已足够清晰，跳过规划环节直接进入 build。

---

## 7. 多项目命名空间

由 `ResolvedConfig.zk.project_id` 字段控制：

- **未设置（默认）**：所有节点位于 `/claude-orchestrator/...`，与旧版本一致；多个 Leader 共享同一 ZK 集群会冲突（`/leader` EPHEMERAL 互斥）。
- **设置 `project_id = "myapp"`**：所有节点位于 `/co/myapp/...`；同一 ZK 集群上的多个 project 互不可见。

启用条件：

- 配置文件中显式写 `zk.project_id: "myapp"`，或
- 环境变量 `CO_PROJECT_ID=myapp`，或
- 命令行 `--project-id myapp`。

回退规则：

- `project_id` 仅由 root 路径生效；其他节点结构不变。
- 升级到 v0.5 后从默认 root 切换到 project_id 模式 **不**做迁移，相当于全新初始化。

`zkPaths` 模块的所有构造函数都接收可选 `{ project_id }`；`ConfigLoader` 把它绑定到所有 `IZkClient` 的构造参数上，全工程透传一次。

---

## 8. ZK 操作与协议约定

### 8.1 atomicity

- **task claim 锁**：调用方先尝试 `createEphemeral("/tasks/claimed/{ins}-{task}", snapshot)`；ZK 的 `create` 在节点已存在时返回 `KeeperException.NodeExists` → 上层 catch 并视为"已被他人 claim"，循环到下一个候选。
- **`/leader` 互斥**：与 claim 同样原理。

### 8.2 watch rearming

ZK 的 child watch 是 **one-shot**。`@co/coordination` 内部封装"persistent watch"（接到回调后立即重新 `getChildrenWithWatch`）。约束：

- 每次 watch 触发后**先**记录子节点 list、**再**重新挂 watch；
- 在 watch 间隔中可能有节点被增删 → 通过比较 list 差集发现，不依赖 watch 的事件性。

### 8.3 顺序保证

- `PERSISTENT_SEQUENTIAL`：ZK 保证同一父路径下顺序号严格单调；跨父路径之间无序保证。
- task 与 message 都依赖该顺序作为"创建顺序"提示，但**不**是唯一性标识（唯一性来自完整路径）。

### 8.4 数据大小

- 单节点 data 上限 1 MiB（ZK 默认）；本协议中：
  - Task / Message 通常 < 4 KiB；
  - `result` 字段可能较大 —— 协议规定：**超过 64 KiB 的 result 必须写入文件**（`cachePaths.taskResultPath`），ZK 中 `result` 仅存路径引用前缀 `file://...`。
  - `task_doc_path` 字段是相对路径（相对 `leaderCacheDir`）；ZK 不存任务文档全文。

### 8.5 时间戳一致性

- 所有 `*_at` 字段由**写入方**生成，使用 `new Date().toISOString()`；
- ZK 自带的 `Stat.ctime / mtime` **不**纳入业务协议（仅作 watch 重对账用）。

---

## 9. 迁移与破坏性变更政策

| 变更类型 | 是否允许 | 触发条件 |
|----------|----------|----------|
| 新增可选字段（`.optional()` / `.default(...)`) | ✅ minor | `0.5.x` |
| 新增 enum 值 | ⚠️ 需检查所有消费端 `switch` 已加 `default` | `0.5.x` 谨慎 |
| 新增 `Message.type` 值 | ✅ minor，ChainRouter 默认分支必须打日志而非崩溃 | `0.5.x` |
| 重命名字段 | ❌ | `0.6.0` |
| 删除字段 | ❌ | `0.6.0` |
| 字段语义变化 | ❌ | `0.6.0` |
| 节点路径变化 | ❌ | `0.6.0` |
| 节点 ephemeral / persistent 类型变化 | ❌ | `0.6.0` |
| 路径前缀（root）变化 | ✅（已用 `project_id` 隔离） | 任意 |

任何 `0.6.0` 候选变更必须先在 [`contracts.md`](contracts.md) 与本文同时更新，并在 PR 中标记 `breaking-change`。

---

## 10. 校验清单（实现侧）

实现 `@co/coordination` 时需对照本文核对：

- [ ] Leader 启动写 `/leader` 时附 `protocol_version`；Worker 启动读 `/leader` 并校验。
- [ ] `ITaskQueue.claim` 实现使用 `createEphemeral` 抢锁，节点 data 必须包含 `task_snapshot`。
- [ ] `ITaskQueue.complete / fail` 时写 `/tasks/completed/{task_id}` 必须带 `commit` 对象（completed）或 `fail_reason`（failed）。
- [ ] `IMessageRouter.send` 写入 `/messages/{to_instance}/msg-{seq}`；广播扇出复制。
- [ ] 大 `result` 自动落盘并以 `file://` 引用替换。
- [ ] 所有 watch 都用 persistent rearming。
- [ ] `LeaderWatcher` 解析 `Message.content` 时三类分支按 §4 描述的优先级。
- [ ] 所有 JSON 字段名都是 snake_case。
- [ ] 所有时间字段都是 ISO 8601 with `Z`。

---

## 11. 与其他文档的关系

| 文档 | 关系 |
|------|------|
| [`contracts.md`](contracts.md) | 本文引用其 schema 名称；本文不重复字段定义，只描述写入条件 |
| [`zookeeper-schema.md`](zookeeper-schema.md) | 本文是其形式化版本；散文说明留在旧文档，wire-format 以本文为准 |
| [`error-and-recovery.md`](error-and-recovery.md) | 本文规定"什么时候写 / 删 / 改"，错误处理与孤儿回收的行为在那里 |
| [`package-layout.md`](package-layout.md) | 本文定义协议，但实现归属于 `@co/coordination` |
