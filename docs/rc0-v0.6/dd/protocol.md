# Protocol — v0.6 ZooKeeper Wire-Format 协议参考

> **文档定位**：所有写入 ZooKeeper 的 JSON 形状的规范来源。类型定义见 `contracts.md`；节点树与 Watch 策略见 `zk-schema.md`；错误处理见 `error-and-recovery.md`。

## 1. 协议版本

```ts
const PROTOCOL_VERSION = "0.6.0";
```

启动检查：Leader 写 `protocol_version` 到 `/leader`；Worker 启动时读取并校验，不匹配则抛 `ProtocolVersionMismatchError` 退出。

## 2. 节点树总览

```
{project_root}/
├── leader                                EPHEMERAL    LeaderNodeData
├── instances/{instance_id}               EPHEMERAL    Instance
├── tasks/
│   ├── pending/task-{seq:010d}           PERSISTENT_SEQUENTIAL  Task
│   ├── claimed/{instance_id}-{task_id}   EPHEMERAL    ClaimRecord
│   └── completed/{task_id}               PERSISTENT   TaskCompleted
└── messages/{instance_id}/msg-{seq:010d} PERSISTENT_SEQUENTIAL  Message
```

所有 JSON 序列化 UTF-8；字段名 snake_case；时间字段 ISO 8601 UTC。

## 3. 节点 wire-format

### 3.1 `/leader`

```json
{
  "protocol_version": "0.6.0",
  "leader_id": "f8a3b1c2e9d04567",
  "pid": 12345,
  "host": "hostname.local",
  "started_at": "2026-05-14T08:30:00.000Z"
}
```

冲突处理：`createEphemeral` 失败 → Leader 抛错退出。

### 3.2 `/instances/{instance_id}`

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

### 3.3 `/tasks/pending/task-{seq}`

```json
{
  "id": "task-0000000123",
  "title": "构建用户认证模块",
  "description": "...",
  "priority": 1,
  "status": "pending",
  "link": "build",
  "chain_id": "chain-001",
  "depends_on": [],
  "blocked_by": [],
  "created_by": "f8a3b1c2e9d04567",
  "created_by_name": "leader",
  "assigned_to": null,
  "created_at": "2026-05-14T08:31:00.000Z",
  "retry_count": 0
}
```

### 3.4 `/tasks/claimed/{instance_id}-{task_id}`

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

`task_snapshot` 让 Recovery 不需要回访 pending 就能拿到原始数据。

### 3.5 `/tasks/completed/{task_id}`

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

### 3.6 `/messages/{instance_id}/msg-{seq}`

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
  "created_at": "2026-05-14T08:31:06.000Z"
}
```

## 4. Message Envelope 与 ChainRouter 分支判别

ChainRouter 按优先级判定三类分支：

### 4.1 `type === "completion_report"`

`content` 为 `JSON.stringify(EvalDecision)`。解析后按 decision 分支：
- `activate_next` → push 下一 link 任务
- `feedback` → 重新派发上一 link
- `reject` → 关 chain，状态 failed
- `close_chain` → 关 chain，状态 completed

### 4.2 `type === "user_input"` + content 是 ChainDef JSON

按 5 个 link 创建任务入 pending（plan 为 null 则跳过）。

### 4.3 `type === "user_input"` + content 是自由文本

- 若 decompose 模板已加载 → Leader 自处理
- 否则 → 转发给 Planner Worker

## 5. EvalDecision Wire-format

放在 `Message.content` 字段中。

**activate_next**：
```json
{ "decision": "activate_next", "reason": "...", "next_link": "build", "suggested_worker": "..." }
```

**feedback**：
```json
{ "decision": "feedback", "reason": "...", "feedback_to_worker": "...", "feedback_target": "..." }
```

**reject**：
```json
{ "decision": "reject", "reason": "需求与架构冲突" }
```

**close_chain**：
```json
{ "decision": "close_chain", "reason": "验收通过" }
```

## 6. ChainDef Wire-format

```json
{
  "chain_id": "chain-001",
  "chain_title": "用户认证模块",
  "tasks": {
    "plan":   { "title": "...", "description": "...", "criteria": "...", "priority": 0 },
    "build":  { "title": "...", "description": "...", "criteria": "...", "priority": 1 },
    "verify": { "title": "...", "description": "...", "criteria": "...", "priority": 1 },
    "review": { "title": "...", "description": "...", "criteria": "...", "priority": 1 },
    "accept": { "title": "...", "description": "...", "criteria": "...", "priority": 2 }
  }
}
```

依赖映射：plan → build → verify → review → accept，每个任务的 `depends_on` 自动指向前一 link 的 task_id。

## 7. ZK 操作协议约定

- **atomicity**：task claim 锁通过 `createEphemeral` 原子抢锁，NodeExists → 已被他人 claim
- **watch rearming**：ZK watch 是一次性的，触发后立即重新设置（persistent watch 模式）
- **顺序保证**：PERSISTENT_SEQUENTIAL 保证同父路径下顺序号严格单调
- **数据大小**：单节点上限 1 MiB；result 超过 64 KiB 落盘以 `file://` 引用
- **时间戳**：所有 `*_at` 字段由写入方生成，不依赖 ZK Stat

## 8. 破坏性变更政策

| 变更类型 | 是否允许 |
|----------|----------|
| 新增 optional 字段 | ✅ minor |
| 新增 enum 值 | ⚠️ 需检查消费端 switch |
| 重命名字段 | ❌ → v0.7 |
| 删除字段 | ❌ → v0.7 |
| 字段语义变化 | ❌ → v0.7 |
| 节点路径变化 | ❌ → v0.7 |
