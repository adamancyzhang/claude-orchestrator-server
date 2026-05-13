# ZooKeeper Schema

本文档定义 Claude Orchestrator 在 ZooKeeper 中的节点树、数据格式、Watch 策略和节点生命周期。

## 1. 节点树

```
/claude-orchestrator                         [PERSISTENT]  根节点
│
├── /leader                                  [EPHEMERAL]   Leader 存在声明（单 Leader）
│
├── /instances                               [PERSISTENT]  实例容器
│   └── /{instance_id}                       [EPHEMERAL]   实例节点（Leader / Worker）
│
├── /tasks                                   [PERSISTENT]  任务容器
│   ├── /pending                             [PERSISTENT]
│   │   └── /task-{seq}                      [PERSISTENT_SEQUENTIAL]
│   ├── /claimed                             [PERSISTENT]
│   │   └── /{instance_id}-{task_id}         [EPHEMERAL]
│   └── /completed                           [PERSISTENT]
│       └── /{task_id}                       [PERSISTENT]
│
└── /messages                                [PERSISTENT]  消息容器
    └── /{instance_id}                       [PERSISTENT]
        └── /msg-{seq}                       [PERSISTENT_SEQUENTIAL]
```

路径常量定义在 [src/zk/paths.ts](../../src/zk/paths.ts)。ZK 客户端连接时通过 `mkdirp` 保证所有路径都存在（参见 `ALL_ENSURE_PATHS`）。

## 2. 节点详细定义

### 2.1 `/leader`

| 属性 | 值 |
|------|---|
| 类型 | EPHEMERAL |
| 创建者 | `run` 命令的主进程 |
| 生命周期 | Leader 进程 ZK session 期间，超时自动删除 |
| 作用 | 声明 Leader 在线 + 保证单 Leader（后续 `run` 在同一 ZK 集群启动时会创建失败并退出） |

数据格式：

```json
{
  "instance_id": "a1b2c3d4e5f6...",
  "name": "Leader",
  "started_at": "2026-05-13T10:00:00Z",
  "host": "my-machine",
  "pid": 12345,
  "version": "0.4.0"
}
```

Watch 策略：外部监控可 `DataWatch` 此节点，用于在 Leader 离线时告警。

### 2.2 `/instances/{instance_id}`

| 属性 | 值 |
|------|---|
| 类型 | EPHEMERAL |
| 创建者 | Leader 主进程 / Worker child-runner |
| 生命周期 | 进程 ZK session 期间，超时自动删除 |
| 作用 | 实例存活声明 + 团队视图来源 |

数据格式：

```json
{
  "id": "a1b2c3d4-...",
  "name": "Tom",
  "role": "planner",
  "status": "busy",
  "current_task_id": "task-0000000003",
  "connected_since": "2026-05-13T10:00:00Z",
  "work_dir": "/Users/me/project/.claude-orchestrator/worktree/Tom",
  "worktree_name": "Tom",
  "worktree_path": "/Users/me/project/.claude-orchestrator/worktree/Tom",
  "worktree_branch": "claude-orchestrator/Tom-workspace",
  "pid": 48291
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 实例 UUID，hex 字符串去除连字符 |
| `name` | 拟人化名称（Tom / Jerry / ...） |
| `role` | 预设权重偏好；`leader` / `planner` / `builder` / `verifier` / `reviewer` / `accepter` |
| `status` | `idle` 或 `busy` |
| `current_task_id` | 当前认领任务 ID，空闲时 `null` |
| `connected_since` | 注册时间戳（ISO 8601） |
| `work_dir` | 进程 `process.cwd()`（Worker = worktree 路径） |
| `worktree_name` / `worktree_path` / `worktree_branch` | git worktree 信息（Leader 为 `null`） |
| `pid` | 操作系统进程 ID |

Watch 策略：

- Leader `ChildWatch` on `/instances` — 检测 Worker 加入/离开
- Leader `DataWatch` on `/instances/{id}` — 检测状态变化（idle → busy 等）

### 2.3 `/tasks/pending/task-{seq}`

| 属性 | 值 |
|------|---|
| 类型 | PERSISTENT_SEQUENTIAL |
| 创建者 | `push-task` CLI / ChainRouter 解析 ChainDef 后写入 |
| seq | ZK 自动递增 10 位数字（如 `task-0000000001`） |

数据格式：

```json
{
  "id": "task-0000000001",
  "title": "实现 POST /api/items",
  "description": "...",
  "priority": 0,
  "status": "pending",
  "link": "build",
  "chain_id": "chain-001",
  "depends_on": ["task-0000000000"],
  "blocked_by": [],
  "task_doc_path": "./tasks/task-0000000001.md",
  "criteria": "...",
  "created_by": "instance-tom-uuid",
  "created_by_name": "Tom",
  "assigned_to": "instance-jerry-uuid",
  "assigned_to_name": "Jerry",
  "created_at": "2026-05-13T10:15:00Z",
  "retry_count": 0
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `priority` | `0` = HIGH，`1` = MEDIUM，`2` = LOW |
| `link` | `plan` / `build` / `verify` / `review` / `accept` |
| `chain_id` | 同一需求链的标识符，`null` 表示独立任务 |
| `depends_on` | 依赖的上游任务 ID 列表 |
| `blocked_by` | 当前阻塞该任务的任务 ID（运行时填充） |
| `task_doc_path` | 任务文档相对路径（相对 `cache_dir/{leader_id}/`） |
| `assigned_to` / `assigned_to_name` | 显式分配目标，`null` 表示开放认领 |
| `retry_count` | 被回收到 pending 的次数（初始 0，最多 3 次） |

Watch 策略：Leader `ChildWatch` on `/tasks/pending` — 检测新任务创建。

### 2.4 `/tasks/claimed/{instance_id}-{task_id}`

| 属性 | 值 |
|------|---|
| 类型 | EPHEMERAL |
| 创建者 | `TaskQueue.claim()` |
| 命名 | `{instance_id}-{task_id}`，如 `a1b2c3d4...-task-0000000001` |
| 作用 | 认领锁 + 任务数据嵌入（孤儿回收时无需额外查询） |

数据格式：

```json
{
  "task_id": "task-0000000001",
  "instance_id": "a1b2c3d4...",
  "instance_name": "Jerry",
  "claimed_at": "2026-05-13T10:16:00Z",
  "status": "claimed",
  "task_data": {
    "title": "...",
    "description": "...",
    "link": "build",
    "chain_id": "chain-001",
    "priority": 0,
    "depends_on": [],
    "blocked_by": [],
    "task_doc_path": "...",
    "criteria": "...",
    "created_by": "...",
    "assigned_to": "...",
    "created_at": "...",
    "retry_count": 0
  }
}
```

**关键属性**：EPHEMERAL 节点。Worker 断连导致 session 超时后，此节点自动删除，触发 Leader 孤儿任务回收。

Watch 策略：Leader `ChildWatch` on `/tasks/claimed` — 子节点增加表示认领，删除表示完成或孤儿。

### 2.5 `/tasks/completed/{task_id}`

| 属性 | 值 |
|------|---|
| 类型 | PERSISTENT |
| 创建者 | `complete-task` CLI / Worker 完成报告 / Recovery 在 retry_count 超限时归档 |

数据格式：

```json
{
  "id": "task-0000000001",
  "title": "...",
  "description": "...",
  "priority": 0,
  "link": "build",
  "chain_id": "chain-001",
  "status": "completed",
  "created_by": "...",
  "assigned_to": "...",
  "completed_by": "instance-jerry-uuid",
  "completed_by_name": "Jerry",
  "completed_at": "2026-05-13T14:30:00Z",
  "result": "...",
  "retry_count": 1,
  "duration_seconds": 15240,
  "commit": {
    "sha": "a1b2c3d",
    "message": "Implement POST /api/items endpoint",
    "branch": "claude-orchestrator/Jerry-workspace",
    "changed_files": ["src/api/items.ts"],
    "untracked_files": []
  }
}
```

`status` 取值：`completed` 或 `failed`（retry_count 超限归档）。

`commit` 段落由 Worker `CommitChecker` 填充；如该任务未产生代码变更，整个 `commit` 字段为 `null` 或缺失。

清理策略：可配置 TTL（默认 30 天），由后台任务定期清理。

### 2.6 `/messages/{instance_id}/msg-{seq}`

| 属性 | 值 |
|------|---|
| 类型 | PERSISTENT_SEQUENTIAL |
| 创建者 | `send-message` CLI / Leader / Worker |

数据格式：

```json
{
  "id": "msg-0000000042",
  "type": "direct",
  "from_instance": "instance-tom-uuid",
  "from_name": "Tom",
  "from_role": "planner",
  "to_instance": "instance-jerry-uuid",
  "to_name": "Jerry",
  "content": "Please implement POST /api/items endpoint...",
  "link": "build",
  "task_id": "task-0000000002",
  "task_title": "实现 POST /api/items",
  "task_description": "...",
  "task_criteria": "...",
  "task_doc_path": "./tasks/task-0000000002.md",
  "result_path": "sessions/{leader_id}/task-0000000002-...log",
  "created_at": "2026-05-13T10:30:00Z",
  "read": false,
  "reply_to": null
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `type` | `direct`（点对点） / `broadcast`（广播） / `help`（求助） |
| `from_role` | 发送者角色 |
| `link` | Worker 模板选择依据；ChainDef 推任务时填充 |
| `task_id` / `task_title` / `task_description` / `task_criteria` | 任务相关字段（来自 ChainDef 或 push-task） |
| `task_doc_path` | 任务文档相对路径（Leader 写入 `cache_dir/{leader_id}/tasks/`） |
| `result_path` | 执行结果路径（Worker 写入或读取上游产出） |
| `read` | 标记已读；Worker / Leader 处理完成后置为 `true` |
| `reply_to` | 引用回复的消息 ID，支持消息线程 |

Watch 策略：

- Worker `ChildWatch` on `/messages/{worker_id}` — 新消息触发模板渲染 + claude-cli 执行
- Leader `ChildWatch` on `/messages/{leader_id}` — 新消息触发 `ChainRouter.route()`

清理策略：标记已读后 24h 自动清理（后台任务）。

## 3. Watch 策略汇总

| 路径 | 观察者 | Watch 类型 | 触发条件 | 回调动作 |
|------|-------|-----------|---------|---------|
| `/leader` | 外部监控 | DataWatch | 节点删除 | 提醒 Leader 已离线 |
| `/instances` | Leader | ChildWatch | 子节点增删 | 更新 TEAM 面板；触发 `worker_joined`/`worker_left` |
| `/instances/{id}` | Leader | DataWatch | 数据变更 | 更新 TUI 中该成员的 status / current_task |
| `/tasks/pending` | Leader | ChildWatch | 子节点增加 | 触发 `task_created` 事件 |
| `/tasks/claimed` | Leader | ChildWatch | 子节点增删 | 子节点增加→任务被认领；子节点删除→检测孤儿（断开导致的 EPHEMERAL 清理）|
| `/messages/{leader_id}` | Leader | ChildWatch | 子节点增加 | `LeaderWatcher` → `ChainRouter.route()` |
| `/messages/{worker_id}` | Worker | ChildWatch | 子节点增加 | `WorkerWatcher.processMessage()` |

## 4. Watch 重建

ZooKeeper Watch 是一次性的，每次触发后必须重新设置。封装在 [src/zk/watcher.ts](../../src/zk/watcher.ts) 中：

```typescript
async function persistentChildWatch(
  zk: ZkClient,
  path: string,
  handler: (children: string[]) => Promise<void>,
): Promise<void> {
  const children = await zk.getChildrenWithWatch(path, async (newChildren) => {
    await handler(newChildren);
    await persistentChildWatch(zk, path, handler);
  });
  await handler(children);
}
```

`ZkClient` 自动重连时（指数退避，最多 10 次，2s spin delay），所有持久 Watch 会重建。

## 5. 节点生命周期

| 节点类型 | 创建时机 | 销毁时机 | 备注 |
|---------|---------|---------|------|
| `/leader` | `run` 命令主进程启动 | Leader 退出 / Session 超时 | 单 Leader 保证：create 失败则退出 |
| `/instances/{id}` | `run` Phase 3（Leader）/ Phase 4（Worker child-runner）| 显式 `unregister` / Session 超时 | 心跳由 ZK session keep-alive 自动维持 |
| `/tasks/pending/task-{seq}` | `push-task` CLI / ChainRouter 推任务 | 被 `claim_task` 删除（移入 claimed）/ 任务取消 | Sequential 保证 FIFO |
| `/tasks/claimed/{ins}-{task}` | `TaskQueue.claim()` 原子创建 | `complete_task` / 实例断连（EPHEMERAL 自动清理）| 断连自动触发孤儿回收 |
| `/tasks/completed/{task}` | `complete_task` / 孤儿重试超限归档 | TTL 自动清理（默认 30 天） | 保留任务历史 |
| `/messages/{id}/msg-{seq}` | `send-message` / Worker / Leader | 已读后 TTL 24h / `delete-message` | Watch 触发本地处理 |

## 6. ACL（访问控制）

默认使用 `OPEN_ACL_UNSAFE`。生产环境建议配置 Digest 认证：

```
scheme: digest
id: claude-orchestrator:<password>
permissions: ALL
```

配置位置：全局 `~/.claude-orchestrator/config.json` 的 `zookeeper.auth` 字段，格式 `"user:password"`。

## 7. Schema 在代码中的对应

Zod schema 定义在 [src/models/schemas.ts](../../src/models/schemas.ts)，含 `InstanceSchema` / `TaskSchema` / `MessageSchema` / `ChainDefSchema` / `EvalDecisionSchema` 五个核心 schema。

ZK 操作封装在 [src/zk/client.ts](../../src/zk/client.ts) 与 [src/modules/{registry,task-queue,message-router}.ts](../../src/modules/)。

| Schema | 对应 ZK 节点 |
|--------|--------------|
| `InstanceSchema` | `/instances/{id}` |
| `TaskSchema` | `/tasks/pending/*` / `/tasks/claimed/*.task_data` / `/tasks/completed/*` |
| `MessageSchema` | `/messages/{id}/msg-*` |
| `ChainDefSchema` | Worker `worker-decompose.md` 输出，非 ZK 节点 |
| `EvalDecisionSchema` | Worker `worker-evaluate.md` 输出，嵌入完成报告消息的 `content` 字段 |
