# ZooKeeper Schema 详细定义

## 节点树

```
/claude-orchestrator                    [PERSISTENT]  根节点
│
├── /instances                          [PERSISTENT]  实例容器
│   └── /{instance_id}                  [EPHEMERAL]   实例节点
│
├── /tasks                              [PERSISTENT]  任务容器
│   ├── /pending                        [PERSISTENT]  待处理任务容器
│   │   └── /task-{seq}                 [PERSISTENT_SEQUENTIAL]
│   ├── /claimed                        [PERSISTENT]  已认领任务容器
│   │   └── /{instance_id}-{task_id}    [EPHEMERAL]
│   └── /completed                      [PERSISTENT]  已完成任务容器
│       └── /{task_id}                  [PERSISTENT]
│
├── /messages                           [PERSISTENT]  消息容器
│   └── /{instance_id}                  [PERSISTENT]  实例消息目录
│       └── /msg-{seq}                  [PERSISTENT_SEQUENTIAL]
│
└── /context                            [PERSISTENT]  共享上下文容器
    └── /{key}                          [PERSISTENT]  上下文条目
```

## 节点详细定义

### /instances/{instance_id}

- **类型**: EPHEMERAL
- **创建者**: MCP Server (处理 `register_instance` 请求时)
- **生命周期**: Server ZK session 期间存活，session 超时自动删除
- **数据格式**:
```json
{
  "id": "a1b2c3d4-...",
  "name": "Jerry-Dev",
  "role": "developer",
  "status": "busy",
  "current_task_id": "task-0000000003",
  "connected_since": "2026-05-09T10:00:00Z"
}
```

- **role 枚举**: `architect`, `developer`, `tester`, `general`
- **status 枚举**: `idle`, `busy`, `blocked`
- **Watch**: Server 监听 `/instances` 子节点变化，用于检测实例上线/离线

### /tasks/pending/task-{seq}

- **类型**: PERSISTENT_SEQUENTIAL
- **创建者**: MCP Server (处理 `push_task` 请求时)
- **seq**: ZK 自动递增的 10 位数字（如 `task-0000000001`）
- **数据格式**:
```json
{
  "id": "task-0000000001",
  "title": "实现 POST /api/items",
  "description": "根据 OpenAPI 契约实现创建接口...",
  "priority": 0,
  "created_by": "instance-tom-uuid",
  "assigned_to": "instance-jerry-uuid",
  "created_at": "2026-05-09T10:15:00Z"
}
```

- **priority**: `0` = 高, `1` = 中, `2` = 低
- **assigned_to**: `null` 表示未指定，非 null 表示指定实例的 UUID

### /tasks/claimed/{instance_id}-{task_id}

- **类型**: EPHEMERAL
- **创建者**: MCP Server (处理 `claim_task` 请求时)
- **数据格式**:
```json
{
  "task_id": "task-0000000001",
  "instance_id": "instance-jerry-uuid",
  "claimed_at": "2026-05-09T10:16:00Z"
}
```
- **关键属性**: Ephemeral 节点。实例断连导致 session 超时后，此节点自动删除，触发任务回退。

### /tasks/completed/{task_id}

- **类型**: PERSISTENT
- **创建者**: MCP Server (处理 `complete_task` 请求时)
- **数据格式**:
```json
{
  "id": "task-0000000001",
  "title": "实现 POST /api/items",
  "completed_by": "instance-jerry-uuid",
  "completed_at": "2026-05-09T14:30:00Z",
  "result": "PR #42 — 实现了完整 CRUD 端点",
  "duration_seconds": 15240
}
```
- **清理策略**: 可配置 TTL（默认 30 天），由后台任务定期清理。

### /messages/{instance_id}/msg-{seq}

- **类型**: PERSISTENT_SEQUENTIAL
- **创建者**: MCP Server (处理 `send_message` 请求时)
- **数据格式**:
```json
{
  "id": "msg-0000000042",
  "type": "direct",
  "from": "instance-tom-uuid",
  "from_name": "Tom",
  "content": "数据库迁移策略有歧义，请确认",
  "created_at": "2026-05-09T10:30:00Z",
  "read": false
}
```
- **type**: `direct` (点对点), `broadcast` (广播), `help` (求助)
- **Watch**: Server 监听 `/messages/{instance_id}` 子节点变化，触发 SSE 推送
- **清理策略**: 标记已读后 24h 自动清理；或实例显式调用 `dismiss_message`

### /context/{key}

- **类型**: PERSISTENT
- **创建者**: MCP Server (处理 `set_context` 请求时)
- **数据格式**:
```json
{
  "key": "build_status",
  "value": "{\"branch\":\"main\",\"commit\":\"abc123\",\"status\":\"green\"}",
  "updated_by": "instance-ci-uuid",
  "updated_by_name": "CI-Bot",
  "updated_at": "2026-05-09T10:45:00Z"
}
```
- **编码**: key 经过 URL-safe 编码，value 为 UTF-8 字符串（任意 JSON）

## Watch 策略

| 路径 | Watch 类型 | 触发条件 | 回调动作 |
|------|-----------|---------|---------|
| `/instances` | ChildWatch | 子节点增删 | 更新内存中的实例列表；子节点增加→通知 SSE 有新实例上线；子节点删除→通知 SSE 实例离线，处理任务回退 |
| `/tasks/pending` | ChildWatch | 子节点增删 | 更新内存中的待办任务计数 |
| `/tasks/claimed` | ChildWatch | 子节点增删 | 子节点删除→检测孤儿任务，重新入队 pending |
| `/messages/{id}` | ChildWatch | 子节点增加 | 拉取新消息内容，推送到对应实例的 SSE 队列 |
| `/context` | ChildWatch | 子节点增删 | 更新内存中上下文键列表 |
| `/context/{key}` | DataWatch | 数据变更 | 通知订阅该 key 的实例 SSE |

## Watch 重建

ZooKeeper Watch 是**一次性**的。每次触发后必须重新设置。

```python
class WatchManager:
    """管理所有 ZK Watch，确保每次触发后自动重建"""
    
    def watch_instances(self):
        def callback(children):
            self.handle_instance_change(children)
            # 重建 Watch
            self.zk.get_children("/instances", watch=callback)
        
        return self.zk.get_children("/instances", watch=callback)
    
    def watch_messages(self, instance_id: str):
        path = f"/messages/{instance_id}"
        def callback(children):
            new_msgs = self.detect_new_messages(instance_id, children)
            for msg in new_msgs:
                self.push_sse(instance_id, msg)
            # 重建 Watch
            self.zk.get_children(path, watch=callback)
        
        return self.zk.get_children(path, watch=callback)
```

## ACL (访问控制)

```python
# 根节点 ACL: 仅创建者拥有全部权限
from kazoo.security import make_digest_acl

DIGEST_ACL = make_digest_acl("mcp-server", "password", all=True)
READ_ACL = make_digest_acl("mcp-readonly", "password", read=True)

# /instances 节点: server 可读写，其他只读
# /tasks 节点: server 可读写
# /messages 节点: server 可读写
# /context 节点: server 可读写
```

简化阶段可先使用 `OPEN_ACL_UNSAFE`，生产环境再配置 ACL。
