# ZooKeeper Schema v0.3.0

## 节点树

```
/claude-orchestrator                         [PERSISTENT]  根节点
│
├── /leader                                  [EPHEMERAL]   Leader 存在声明
│   data: {"instance_id":"...", "name":"Tom", "role":"leader",
│          "started_at":"...", "host":"...", "pid":12345, "version":"0.3.0"}
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
- **创建者**: Worker watcher 或 CLI `register` 命令
- **生命周期**: Worker ZK session 期间，超时自动删除
- **数据格式**:
```json
{
  "id": "a1b2c3d4-...",
  "name": "Jerry-Dev",
  "role": "builder",
  "status": "busy",
  "current_task_id": "task-0000000003",
  "connected_since": "2026-05-11T10:00:00Z",
  "work_dir": "/Users/jerry/project"
}
```

- **role 枚举**: `leader`, `planner`, `builder`, `verifier`, `reviewer`, `accepter`
  - `leader` = Leader 节点
  - 其他 = Worker 节点，role 作为任务认领的预设权重
- **status 枚举**: `idle`, `busy`
- **work_dir**: Worker 工作目录
- **Watch 策略**:
  - Leader: `ChildWatch` on `/instances` — 检测 Worker 加入/离开
  - Leader: `DataWatch` on each `/instances/{id}` — 检测 Worker 状态变化

### /tasks/pending/task-{seq}

- **类型**: PERSISTENT_SEQUENTIAL
- **创建者**: CLI `push-task` 或 Leader
- **seq**: ZK 自动递增的 10 位数字（如 `task-0000000001`）
- **数据格式**:
```json
{
  "id": "task-0000000001",
  "title": "实现 POST /api/items",
  "description": "根据 OpenAPI 契约实现创建接口...",
  "priority": 0,
  "status": "pending",
  "link": "build",
  "chain_id": "chain-001",
  "depends_on": ["task-0000000000"],
  "blocked_by": [],
  "task_doc_path": "./tasks/task-0000000001.md",
  "created_by": "instance-tom-uuid",
  "created_by_name": "Tom",
  "assigned_to": "instance-jerry-uuid",
  "assigned_to_name": "Jerry",
  "created_at": "2026-05-11T10:15:00Z",
  "retry_count": 0
}
```

- **priority**: `0` = HIGH, `1` = MEDIUM, `2` = LOW
- **link**: 责任链环节 — `plan`, `build`, `verify`, `review`, `accept`
- **chain_id**: 同一需求链的标识符，null 表示独立任务
- **depends_on**: 依赖的上游任务 ID 列表
- **blocked_by**: 当前阻塞该任务的任务 ID
- **assigned_to / assigned_to_name**: `null` 表示未指定
- **retry_count**: 记录任务被回退到 pending 的次数
- **Watch**: Leader `ChildWatch` on `/tasks/pending` — 检测新任务创建

### /tasks/claimed/{instance_id}-{task_id}

- **类型**: EPHEMERAL
- **创建者**: Worker 调用 `claim_task`
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
    "link": "build",
    "chain_id": "chain-001",
    "priority": 0,
    "created_by": "...",
    "assigned_to": "...",
    "created_at": "...",
    "retry_count": 0
  }
}
```

- **task_data**: 将完整任务数据嵌入 claimed 节点，以便孤儿任务回收时无需额外查询
- **关键属性**: Ephemeral 节点。实例断连导致 session 超时后，此节点自动删除，触发 Leader 孤儿任务回收
- **Watch**: Leader `ChildWatch` on `/tasks/claimed` — 检测任务认领和释放

### /tasks/completed/{task_id}

- **类型**: PERSISTENT
- **创建者**: Worker 调用 `complete_task` 或 Leader 在 retry_count 超限时归档
- **数据格式**:
```json
{
  "id": "task-0000000001",
  "title": "实现 POST /api/items",
  "description": "...",
  "priority": 0,
  "link": "build",
  "chain_id": "chain-001",
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
- **创建者**: CLI `send-message`
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
  "link": "build",
  "task_id": "task-0000000002",
  "task_title": "实现 POST /api/items",
  "task_description": "...",
  "task_criteria": "...",
  "task_doc_path": "./tasks/task-0000000002.md",
  "result_path": "sessions/a1b2c3.../msg-abc123-xxx.log",
  "created_at": "2026-05-11T10:30:00Z",
  "read": false,
  "reply_to": null
}
```

- **type**: `direct` (点对点), `broadcast` (广播), `help` (求助)
- **from_role**: 发送者角色
- **link**: Worker 模板选择依据 — `plan`, `build`, `verify`, `review`, `accept`
- **task_doc_path**: Leader 消息中附带的相对路径任务文档
- **result_path**: 消息关联的 CACHE_DIR 日志/结果路径
- **reply_to**: 引用回复的消息 ID，支持消息线程
- **Watch**: Worker watcher `ChildWatch` on `/messages/{instance_id}` — 新消息触发 `$COMMAND -p | tee $CACHE_DIR/{key}.log`
- **清理策略**: 标记已读后 24h 自动清理（Leader 后台任务）

### /context/{key}

- **类型**: PERSISTENT
- **创建者**: CLI `set-context`
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
| `/tasks/claimed` | Leader | ChildWatch | 子节点增删 | 子节点增加→任务被认领；子节点删除→孤儿任务回收 |
| `/messages/{leader_id}` | Leader | ChildWatch | 子节点增加 | Leader watcher 处理 Worker 发来的完成报告 |
| `/messages/{worker_id}` | Worker | ChildWatch | 子节点增加 | Worker watcher 处理 Leader 发来的任务指令 |
| `/context/{key}` | 任意节点 | DataWatch | 数据变更 | `watch-context` CLI 命令输出变更 |

## Watch 重建

ZooKeeper Watch 是一次性的。每次触发后必须重新设置：

```typescript
async function persistentChildWatch(
  zk: ZkClient,
  path: string,
  handler: (children: string[]) => Promise<void>
): Promise<void> {
  const children = await zk.getChildrenWithWatch(path, async (newChildren) => {
    await handler(newChildren);
    await persistentChildWatch(zk, path, handler);
  });
  await handler(children);
}
```

## 节点生命周期

| 节点类型 | 创建时机 | 销毁时机 | 说明 |
|---------|---------|---------|------|
| `/leader` | `claude-orchestrator leader` 启动 | Leader 退出 / Session 超时 | 单 Leader 保证：创建失败则退出 |
| `/instances/{id}` | `register` | 显式 `unregister` / Session 超时 | 心跳由 ZK session keep-alive 自动维持 |
| `/tasks/pending/task-{seq}` | `push_task` | 被 `claim_task` 删除 / 被取消 | Sequential 保证 FIFO |
| `/tasks/claimed/{ins}-{task}` | `claim_task` 原子创建 | `complete_task` / 实例断连 | Ephemeral — 实例断连自动释放 |
| `/tasks/completed/{task}` | `complete_task` / 孤儿重试超限归档 | 手动清理 / TTL 自动清理 | 保留任务历史 |
| `/messages/{id}/msg-{seq}` | `send_message` | 已读后 TTL (24h) / `delete-message` | Watch 触发本地 `claude -p` |
| `/context/{key}` | `set_context` | `delete_context` | 持久存储 |

## ACL (访问控制)

默认使用 `OPEN_ACL_UNSAFE`。生产环境建议配置 Digest 认证：

```
# 根节点 ACL: server 用户全部权限
scheme: digest
id: mcp-server:password
permissions: ALL
```
