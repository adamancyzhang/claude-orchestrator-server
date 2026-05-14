# ZooKeeper Schema — v0.6

> **文档定位**：定义 Claude Orchestrator 在 ZooKeeper 中的节点树、数据格式、Watch 策略和节点生命周期。
> Wire-format 的形式化规范见 `protocol.md`；类型定义见 `contracts.md`。

## 1. 节点树

```
/claude-orchestrator                         [PERSISTENT]  根节点
│
├── /leader                                  [EPHEMERAL]   Leader 存在声明
│
├── /instances                               [PERSISTENT]  实例容器
│   └── /{instance_id}                       [EPHEMERAL]   实例节点
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

多项目隔离：设置 `project_id` 后根节点变为 `/co/{project_id}`。

## 2. 节点详细定义

### 2.1 `/leader`

- **类型**：EPHEMERAL
- **创建者**：`run` 命令主进程
- **作用**：单 Leader 保证（后续 `run` 创建失败则退出）

```json
{
  "protocol_version": "0.6.0",
  "leader_id": "f8a3b1c2e9d04567",
  "pid": 12345,
  "host": "hostname.local",
  "started_at": "2026-05-14T08:30:00.000Z"
}
```

### 2.2 `/instances/{instance_id}`

- **类型**：EPHEMERAL
- **创建者**：Leader 主进程 / Worker child-runner
- **生命周期**：进程 ZK session 期间

```json
{
  "id": "a91b2c3d4e5f6789",
  "name": "Tom",
  "role": "builder",
  "status": "idle",
  "current_task_id": null,
  "connected_since": "2026-05-14T08:30:05.123Z",
  "work_dir": "/abs/path/.claude-orchestrator/worktree/Tom",
  "worktree_name": "Tom",
  "worktree_path": "/abs/path/.claude-orchestrator/worktree/Tom",
  "worktree_branch": "claude-orchestrator/Tom-workspace",
  "pid": 12378,
  "protocol_version": "0.6.0"
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 实例 UUID，hex 字符串 |
| `name` | 拟人化名称 |
| `role` | 预设权重偏好 |
| `status` | `idle` 或 `busy` |
| `current_task_id` | 当前认领任务 ID |
| `worktree_name/path/branch` | git worktree 信息 |
| `pid` | 操作系统进程 ID |

### 2.3 `/tasks/pending/task-{seq}`

- **类型**：PERSISTENT_SEQUENTIAL
- **创建者**：`push-task` CLI / ChainRouter

```json
{
  "id": "task-0000000123",
  "title": "构建用户认证模块",
  "description": "...",
  "priority": 1,
  "status": "pending",
  "link": "build",
  "chain_id": "chain-001",
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

### 2.4 `/tasks/claimed/{instance_id}-{task_id}`

- **类型**：EPHEMERAL
- **创建者**：`TaskQueue.claim()`
- **关键属性**：Worker 断连 → 节点自动删除 → 触发孤儿回收

```json
{
  "task_id": "task-0000000123",
  "instance_id": "a91b2c3d4e5f6789",
  "claimed_at": "2026-05-14T08:31:05.456Z",
  "task_snapshot": {
    "id": "task-0000000123",
    "title": "构建用户认证模块",
    "...": "完整 Task 对象镜像（供 Recovery 直接读回 pending）"
  }
}
```

### 2.5 `/tasks/completed/{task_id}`

- **类型**：PERSISTENT
- **创建者**：`complete-task` / 孤儿重试超限归档

```json
{
  "id": "task-0000000123",
  "status": "completed",
  "result": "...",
  "completed_by_name": "Tom",
  "duration_seconds": 184.7,
  "completed_at": "2026-05-14T08:34:09.000Z",
  "commit": {
    "sha": "9f3a1b2c",
    "message": "feat(auth): add user authentication",
    "branch": "claude-orchestrator/Tom-workspace",
    "changed_files": ["src/auth/index.ts"],
    "untracked_files": []
  }
}
```

### 2.6 `/messages/{instance_id}/msg-{seq}`

- **类型**：PERSISTENT_SEQUENTIAL
- **创建者**：`send-message` CLI / Leader / Worker

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
  "chain_id": "chain-001",
  "task_title": "构建用户认证模块",
  "task_description": "...",
  "task_criteria": "...",
  "task_doc_path": "tasks/task-0000000123.md",
  "result_path": "results/task-0000000123.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T08:30:00.000Z"
}
```

消息类型（`type`）：`direct` / `broadcast` / `task_dispatch` / `completion_report` / `user_input` / `help`

## 3. Watch 策略汇总

| 路径 | 观察者 | Watch 类型 | 触发条件 | 回调动作 |
|------|-------|-----------|---------|---------|
| `/instances` | Leader | ChildWatch | 子节点增删 | 更新 TEAM 面板 |
| `/instances/{id}` | Leader | DataWatch | 数据变更 | 更新 status / current_task |
| `/tasks/pending` | Leader | ChildWatch | 子节点增加 | `task_created` 事件 |
| `/tasks/claimed` | Leader | ChildWatch | 子节点增删 | 认领/孤儿检测 |
| `/messages/{leader_id}` | Leader | ChildWatch | 子节点增加 | ChainRouter.route() |
| `/messages/{worker_id}` | Worker | ChildWatch | 子节点增加 | processMessage() |

ZK Watch 是一次性的，每次触发后必须重新设置（persistent watch 模式）。

## 4. 节点生命周期

| 节点 | 创建 | 销毁 | 备注 |
|------|------|------|------|
| `/leader` | Leader 启动 | Leader 退出 / Session 超时 | 单 Leader 互斥 |
| `/instances/{id}` | 进程注册 | 显式 unregister / Session 超时 | 心跳由 ZK session 维持 |
| `/tasks/pending/*` | push-task / ChainRouter | claim 时删除（移入 claimed） | Sequential 保证 FIFO |
| `/tasks/claimed/*` | claim 原子创建 | complete / 实例断连 | EPHEMERAL 自动清理 |
| `/tasks/completed/*` | complete / 归档 | TTL 清理（v0.6 候选） | 保留历史 |
| `/messages/*/msg-*` | send-message | 已读后保留 / delete-message | Watch 触发处理 |

## 5. 关键约束

- 单节点 data 上限 1 MiB（ZK 默认）；result 超过 64 KiB 落盘以 `file://` 引用
- 所有 `*_at` 时间字段由写入方生成（ISO 8601 UTC），不依赖 ZK Stat
- Task claim 使用 EPHEMERAL create 原子抢锁，NodeExists 视为已被他人 claim
- 所有 JSON 字段名 snake_case
