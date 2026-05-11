# ZooKeeper Schema v0.3.0

## 节点树

```
/claude-orchestrator                         [PERSISTENT]  根节点
│
├── /leader                                  [EPHEMERAL]   Leader 存在声明 (identity: leader)
│   data: {"instance_id":"...", "name":"Tom", "role":"leader",
│          "started_at":"...", "cache_dir":"...", "version":"0.3.0"}
│
├── /instances                               [PERSISTENT]  实例容器
│   └── /{instance_id}                       [EPHEMERAL]   实例节点
│
├── /tasks                                   [PERSISTENT]  任务容器
│   ├── /pending                             [PERSISTENT]  待处理任务容器
│   │   └── /task-{seq}                      [PERSISTENT_SEQUENTIAL]
│   ├── /claimed                             [PERSISTENT]  已认领任务容器
│   │   └── /{instance_id}-{task_id}         [EPHEMERAL]
│   └── /completed                           [PERSISTENT]  已完成任务容器
│       └── /{task_id}                       [PERSISTENT]
│
├── /messages                                [PERSISTENT]  消息容器
│   └── /{instance_id}                       [PERSISTENT]  实例消息目录
│       └── /msg-{seq}                       [PERSISTENT_SEQUENTIAL]
│
└── /context                                 [PERSISTENT]  共享上下文容器
    └── /{key}                               [PERSISTENT]  上下文条目
```

## 节点详细定义

### /leader

- **类型**: EPHEMERAL
- **创建者**: Leader 进程 (`claude-orchestrator leader`)
- **生命周期**: Leader 进程 ZK session 期间，超时自动删除
- **作用**: 声明 Leader 在线，同时保证单 Leader（后续 Leader 无法创建同名节点）
- **数据格式**:
```json
{
  "instance_id": "a1b2c3d4e5f6...",
  "name": "Leader",
  "started_at": "2026-05-11T10:00:00Z",
  "host": "my-machine",
  "pid": 12345,
  "version": "0.3.0"
}
```
- **Watch**: 非 Leader 进程可 Watch 此节点，以便在 Leader 离线时提醒用户

### /instances/{instance_id}

- **类型**: EPHEMERAL
- **创建者**: Member watcher 或 CLI `register` 命令
- **生命周期**: Member ZK session 期间，超时自动删除
- **数据格式**:
```json
{
  "id": "a1b2c3d4-...",
  "name": "Jerry-Dev",
  "role": "developer",
  "status": "busy",
  "current_task_id": "task-0000000003",
  "connected_since": "2026-05-11T10:00:00Z",
  "work_dir": "/Users/jerry/project"
}
```

- **role 枚举**: `leader`, `architect`, `developer`, `tester`, `general`
  - `leader` = Leader 节点
  - 其他 = Worker 节点
- **status 枚举**: `idle`, `busy`
  - v0.3.0 移除了 `blocked` 状态 — 阻塞状态由 Task.status=blocked 表示
- **work_dir**: v0.3.0 新增字段，记录 Worker 工作目录
- **Watch 策略**:
  - Leader: `ChildWatch` on `/instances` — 检测 Worker 加入/离开
  - Leader: `DataWatch` on each `/instances/{id}` — 检测 Worker 状态变化

### /tasks/pending/task-{seq}

- **类型**: PERSISTENT_SEQUENTIAL
- **创建者**: CLI `push-task` 或 Leader TUI `task push`
- **seq**: ZK 自动递增的 10 位数字（如 `task-0000000001`）
- **数据格式**:
```json
{
  "id": "task-0000000001",
  "title": "实现 POST /api/items",
  "description": "根据 OpenAPI 契约实现创建接口...",
  "priority": 0,
  "status": "pending",
  "created_by": "instance-tom-uuid",
  "created_by_name": "Tom",
  "assigned_to": "instance-jerry-uuid",
  "assigned_to_name": "Jerry",
  "created_at": "2026-05-11T10:15:00Z",
  "retry_count": 0
}
```

- **priority**: `0` = HIGH, `1` = MEDIUM, `2` = LOW
- **assigned_to / assigned_to_name**: `null` 表示未指定，非 null 表示指定实例
- **retry_count**: 新增字段，记录任务被回退到 pending 的次数（孤儿任务回收、task-retry）
- **Watch**: Leader `ChildWatch` on `/tasks/pending` — 检测新任务创建

### /tasks/claimed/{instance_id}-{task_id}

- **类型**: EPHEMERAL
- **创建者**: Member 调用 `claim_task`
- **命名规则**: `{instance_id}-{task_id}`，如 `a1b2c3d4-task-0000000001`
- **数据格式**:
```json
{
  "task_id": "task-0000000001",
  "instance_id": "a1b2c3d4...",
  "instance_name": "Jerry",
  "claimed_at": "2026-05-11T10:16:00Z",
  "status": "claimed",
  "task_data": {
    "title": "实现 POST /api/items",
    "description": "...",
    "priority": 0,
    "created_by": "...",
    "assigned_to": "...",
    "created_at": "...",
    "retry_count": 0
  }
}
```

- **task_data**: v0.3.0 新增 — 将完整任务数据嵌入 claimed 节点，以便孤儿任务回收时无需额外查询
- **关键属性**: Ephemeral 节点。实例断连导致 session 超时后，此节点自动删除，触发 Leader 孤儿任务回收
- **Watch**: Leader `ChildWatch` on `/tasks/claimed` — 检测任务认领和释放

### /tasks/completed/{task_id}

- **类型**: PERSISTENT
- **创建者**: Member 调用 `complete_task` 或 Leader 在 retry_count 超限时归档
- **数据格式**:
```json
{
  "id": "task-0000000001",
  "title": "实现 POST /api/items",
  "description": "...",
  "priority": 0,
  "status": "completed",
  "created_by": "...",
  "assigned_to": "...",
  "completed_by": "instance-jerry-uuid",
  "completed_by_name": "Jerry",
  "completed_at": "2026-05-11T14:30:00Z",
  "result": "PR #42 — 实现了完整 CRUD 端点",
  "retry_count": 1,
  "duration_seconds": 15240
}
```

- **status**: `completed` 或 `failed` (retry_count 超限归档)
- **清理策略**: 可配置 TTL（默认 30 天），由 Leader 后台任务定期清理

### /messages/{instance_id}/msg-{seq}

- **类型**: PERSISTENT_SEQUENTIAL
- **创建者**: CLI `send-message` / Member 的 Claude Code 调用 `send-message` / Leader TUI `msg`
- **数据格式**:
```json
{
  "id": "msg-0000000042",
  "type": "direct",
  "from_instance": "instance-tom-uuid",
  "from_name": "Tom",
  "from_role": "leader",
  "to_instance": "instance-jerry-uuid",
  "to_name": "Jerry",
  "content": "Please implement the POST /api/items endpoint...",
  "task_doc_path": "./tasks/task-0000000001.md",
  "result_path": "sessions/a1b2c3.../msg-abc123-xxx.log",
  "created_at": "2026-05-11T10:30:00Z",
  "read": false,
  "reply_to": null
}
```

- **type**: `direct` (点对点), `broadcast` (广播), `help` (求助)
- **from_role**: v0.3.0 新增 — 发送者角色 (`leader` / `developer` / `tester` 等)
- **task_doc_path**: v0.3.0 新增 — Leader 消息中附带的相对路径任务文档
- **result_path**: v0.3.0 新增 — 消息关联的 CACHE_DIR 日志/结果路径
- **reply_to**: v0.3.0 新增 — 引用回复的消息 ID，支持消息线程
- **Watch**: Worker watcher `ChildWatch` on `/messages/{instance_id}` — 新消息触发 `$COMMAND -p | tee $CACHE_DIR/{key}.log`
- **清理策略**: 标记已读后 24h 自动清理（Leader 后台任务）

### /context/{key}

- **类型**: PERSISTENT
- **创建者**: CLI `set-context` 或 Leader TUI `context set`
- **数据格式**:
```json
{
  "key": "build_status",
  "value": "{\"branch\":\"main\",\"commit\":\"abc123\",\"status\":\"green\"}",
  "updated_by": "instance-ci-uuid",
  "updated_by_name": "CI-Bot",
  "updated_at": "2026-05-11T10:45:00Z"
}
```

- **编码**: key 经过 URL-safe 编码，value 为 UTF-8 字符串（任意 JSON）
- **Watch**: 可选 `DataWatch` on `/context/{key}` — 检测特定 key 的变化

## Watch 策略

| 路径 | 观察者 | Watch 类型 | 触发条件 | 回调动作 |
|------|-------|-----------|---------|---------|
| `/leader` | 外部监控 | DataWatch | 节点删除 | 提醒 Leader 已离线 |
| `/instances` | Leader | ChildWatch | 子节点增删 | 更新 TUI 团队面板；处理成员加入/离开 |
| `/instances/{id}` | Leader | DataWatch | 数据变更 | 更新 TUI 中该成员的状态/当前任务 |
| `/tasks/pending` | Leader | ChildWatch | 子节点增加 | 更新 TUI 任务面板；触发新任务通知 |
| `/tasks/claimed` | Leader | ChildWatch | 子节点增删 | 子节点增加→任务被认领通知；子节点删除→孤儿任务回收 |
| `/messages/{id}` | Worker | ChildWatch | 子节点增加 | 读取新消息，`$COMMAND -p "$MSG" \| tee $CACHE_DIR/{key}.log`，标记已读 |
| `/messages/*` | Leader (可选) | ChildWatch | 子节点增加 | 更新 TUI 事件日志（仅计数/通知，不读内容） |
| `/context/{key}` | 任意节点 | DataWatch | 数据变更 | `watch-context` CLI 命令输出变更 |

## Watch 重建

ZooKeeper Watch 是一次性的。每次触发后必须重新设置。使用统一的重建模式：

```typescript
async function persistentChildWatch(
  zk: ZkClient,
  path: string,
  handler: (children: string[]) => Promise<void>
): Promise<void> {
  const children = await zk.getChildrenWithWatch(path, async (newChildren) => {
    await handler(newChildren);
    // 递归重建 Watch
    await persistentChildWatch(zk, path, handler);
  });
  await handler(children);
}
```

## 节点生命周期

| 节点类型 | 创建时机 | 销毁时机 | 说明 |
|---------|---------|---------|------|
| `/leader` | `claude-orchestrator leader` 启动 | Leader 退出 / Session 超时 | 单 Leader 保证：创建失败则退出 |
| `/instances/{id}` | `register` (含 `--work-dir`) | 显式 `unregister` / Session 超时 | 心跳由 ZK session keep-alive 自动维持 |
| `/tasks/pending/task-{seq}` | `push_task` / Leader `task push` | 被 `claim_task` 删除 / 被取消 | Sequential 保证 FIFO |
| `/tasks/claimed/{ins}-{task}` | `claim_task` 原子创建 | `complete_task` / 实例断连 | Ephemeral — 实例断连自动释放 |
| `/tasks/completed/{task}` | `complete_task` / 孤儿重试超限归档 | 手动清理 / TTL 自动清理 | 保留任务历史 |
| `/messages/{id}/msg-{seq}` | `send_message` / `request_help` / Leader `msg` | 已读后 TTL (24h) / `dismiss_message` | Watch 触发本地 `claude -p` |
| `/context/{key}` | `set_context` | `delete_context` | 持久存储 |

## ACL (访问控制)

v0.3.0 默认使用 `OPEN_ACL_UNSAFE`。生产环境建议配置 Digest 认证：

```
# 根节点 ACL: server 用户全部权限
scheme: digest
id: mcp-server:password
permissions: ALL

# /instances 节点: server 可读写，实例只读自己的节点
# /tasks 节点: server 可读写
# /messages 节点: server 可读写
```

简化阶段可使用 `world:anyone:cdrwa`，迁移到生产时再配置 ACL。

## 与 v0.2.0 Schema 的差异

| 节点/字段 | v0.2.0 | v0.3.0 | 说明 |
|----------|--------|--------|------|
| `/leader` | — | **新增** EPHEMERAL | Leader 存在声明 |
| `Instance.status` | idle, busy, blocked | idle, busy | blocked 移到 Task 级别 |
| `Instance.work_dir` | — | **新增** string | Member 工作目录 |
| `Task.status` | pending, claimed, completed | +in_progress +blocked +failed | 扩展状态机 |
| `Task.retry_count` | — | **新增** number | 任务重试次数 |
| `Task.blocked_reason` | — | **新增** string | 阻塞原因 |
| `Task.fail_reason` | — | **新增** string | 失败原因 |
| `Task.created_by_name` | — | **新增** string | 创建者显示名 |
| `Task.assigned_to_name` | — | **新增** string | 被分配者显示名 |
| `Task.completed_by_name` | — | **新增** string | 完成者显示名 |
| `Claimed.task_data` | — | **新增** object | 嵌入任务数据便于恢复 |
| `Message.reply_to` | — | **新增** string | 消息线程支持 |
| `Message.to_name` | — | **新增** string | 接收者显示名 |
