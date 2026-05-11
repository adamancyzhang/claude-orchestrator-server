# Claude MCP Server — 多实例协同编排 PRD

## 1. 概述

为多个 Claude Code 实例提供统一的协同编排中心。每个 Claude Code 实例通过 MCP 协议连接到 Server，实现实例发现、任务分发、消息传递、状态共享和实时通知。

本设计以 **ZooKeeper** 作为分布式协调中枢，承担服务发现、状态存储和变更通知的核心职责。

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                      Claude MCP Server                           │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Instance    │  │  Task        │  │  Message             │   │
│  │  Registry    │  │  Queue       │  │  Router              │   │
│  │              │  │              │  │                      │   │
│  │  注册/发现    │  │  分发/认领    │  │  点对点/广播/实时推送  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                 │                      │               │
│  ┌──────┴─────────────────┴──────────────────────┴───────────┐   │
│  │                    ZooKeeper                               │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │   │
│  │  │ Instances│  │  Tasks   │  │ Messages │  │ Context  │  │   │
│  │  │ (ephemeral)│ │(sequential)│ │(sequential)│ │(persistent)│ │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Transport: Streamable HTTP (SSE)                                │
│  Default Port: 3100                                              │
└──────────────────────────┬───────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────┴────┐       ┌────┴────┐       ┌────┴────┐
    │ Claude  │       │ Claude  │       │ Claude  │
    │ Instance│       │ Instance│       │ Instance│
    │   A     │       │   B     │       │   C     │
    └─────────┘       └─────────┘       └─────────┘
```

### 核心模块

| 模块 | 职责 | ZooKeeper 依赖 |
|------|------|---------------|
| Instance Registry | 实例注册、心跳、存活检测、角色管理 | Ephemeral 节点自动清理 |
| Task Queue | 任务入队、认领、完成、优先级排序 | Sequential 节点保证 FIFO |
| Message Router | 点对点消息、广播、实时通知 | ZK Watch + MCP Resource Subscription |
| Context Store | 全局键值存储、变更通知 | 持久节点 + Watch |

## 3. ZooKeeper 设计

### 3.1 为什么选择 ZooKeeper

- **服务发现**：Ephemeral 节点天然对应实例生命周期，断开即自动清理
- **实时通知**：Watch 机制在数据变更时即时回调，无需轮询
- **顺序保证**：Sequential 节点提供全局唯一、有序的任务 ID
- **高可用**：集群部署，单点故障自动切换
- **一致性**：CP 系统，状态变更强一致

### 3.2 节点树结构

```
/claude-orchestrator
│
├── /instances/
│   └── /{instance_id}              [EPHEMERAL]  实例元数据 JSON
│       data: {"name":"Jerry-Dev","role":"developer","status":"busy",
│              "current_task_id":"task-001","connected_since":"..."}
│
├── /tasks/
│   ├── /pending/
│   │   └── /task-{seq}             [PERSISTENT_SEQUENTIAL]  待处理任务
│   │       data: {"title":"...","description":"...","priority":0,
│   │              "created_by":"instance-A","assigned_to":null}
│   ├── /claimed/
│   │   └── /{instance_id}-{task_id} [EPHEMERAL]  认领记录
│   │       data: {"claimed_at":"..."}
│   └── /completed/
│       └── /{task_id}              [PERSISTENT]  已完成任务
│           data: {"completed_at":"...","result":"..."}
│
├── /messages/
│   └── /{instance_id}/
│       └── /msg-{seq}              [PERSISTENT_SEQUENTIAL]  消息
│           data: {"from":"...","content":"...","created_at":"...",
│                  "read":false}
│
└── /context/
    └── /{key}                      [PERSISTENT]  共享上下文
        data: {"value":"...","updated_by":"...","updated_at":"..."}
```

### 3.3 节点生命周期

| 节点类型 | 创建时机 | 销毁时机 | 说明 |
|---------|---------|---------|------|
| `/instances/{id}` | `register_instance` | Session 超时 / 显式注销 | 心跳通过 ZooKeeper session keep-alive 维持 |
| `/tasks/pending/task-{seq}` | `push_task` | 任务被认领时移到 claimed | Sequential 保证 FIFO |
| `/tasks/claimed/{ins}-{task}` | `claim_task` | 任务完成 / 实例断开 | Ephemeral — 实例断连自动释放 |
| `/tasks/completed/{task}` | `complete_task` | 手动清理 / TTL | 保留任务历史 |
| `/messages/{id}/msg-{seq}` | `send_message` | 接收方标记已读后清理 / TTL | Watch 触发实时推送 |
| `/context/{key}` | `set_context` | `delete_context` | 持久存储 |

## 4. 实例发现与存活检测

### 4.1 注册流程

```
Instance A                    MCP Server                     ZooKeeper
    │                             │                              │
    │── register_instance ───────>│                              │
    │   (name, role)              │── create(ephemeral) ────────>│
    │                             │   /instances/{uuid}          │
    │                             │<── OK ──────────────────────│
    │<── {instance_id, uuid} ────│                              │
    │                             │                              │
    │── heartbeat ───────────────>│  (ZK session 自动维持心跳)    │
    │   (每 30s)                  │── setData(metadata) ────────>│
```

- 首次注册：Server 创建 Ephemeral 节点 `/instances/{uuid}`，data 为实例元数据 JSON。
- `register_instance` 返回分配的 `instance_id`（UUID），后续请求携带此 ID。
- 实例身份通过 HTTP Header `X-Instance-Name` 和 `X-Instance-Role` 传递。

### 4.2 存活检测（无需显式心跳轮询）

ZooKeeper Ephemeral 节点的生命周期与客户端 Session 绑定：

- ZK Session Timeout 默认 30s（可配置为 60s）。
- MCP Server 作为 ZK 客户端，维持与 ZK 集群的 Session。
- 当 MCP Server 进程崩溃或网络断开，Session 超时后 Ephemeral 节点自动删除。
- Server 监听 `/instances` 的子节点变化（Watch），节点删除时：
  1. 标记实例为 `offline`。
  2. 该实例持有的 `/tasks/claimed/{ins}-{task}` 节点自动删除（Ephemeral）。
  3. 将释放的任务重新写入 `/tasks/pending/`。

### 4.3 实例列表获取

```
list_instances:
  1. Server getChildren("/instances")
  2. 对每个子节点 getData() 获取元数据
  3. 返回活跃实例列表（Ephemeral 节点存在的即在线）
```

## 5. 任务队列

### 5.1 推送任务

```
push_task(title, description, priority=1, assignee=None):
  1. 生成 task_id = task-{sequential_number}
  2. create("/tasks/pending/{task_id}", data={title, description, priority,
                                              created_by, assigned_to})
  3. 返回 task_id
```

### 5.2 认领任务

```
claim_task(instance_id):
  1. getChildren("/tasks/pending")
  2. 排序规则:
     a. assigned_to == instance_id → 最优先
     b. priority=0 的未分配任务
     c. FIFO (按 sequential number 升序)
  3. 创建 Ephemeral 节点 "/tasks/claimed/{instance_id}-{task_id}"
  4. 删除 "/tasks/pending/{task_id}"
  5. 更新 "/instances/{instance_id}" status→busy, current_task_id=task_id
  6. 返回任务详情
```

认领采用 **乐观锁**：步骤 3 的 create 操作由 ZK 保证原子性。若两个实例同时认领同一任务，只有一个能成功创建 claimed 节点，另一个重试下一个匹配任务。

### 5.3 完成任务

```
complete_task(instance_id, task_id, result):
  1. 验证 "/tasks/claimed/{instance_id}-{task_id}" 存在（权限校验）
  2. create("/tasks/completed/{task_id}", data={result, completed_at})
  3. delete("/tasks/claimed/{instance_id}-{task_id}")
  4. 更新 "/instances/{instance_id}" status→idle, current_task_id=null
```

### 5.4 任务超时与恢复

- 当实例断连，其 `/tasks/claimed/{ins}-{task}` Ephemeral 节点自动删除。
- Server Watch `/tasks/claimed` 子节点变化，检测到删除：
  1. 查找到被释放的 task_id。
  2. 重新 create `/tasks/pending/{task_id}`（保留原 priority 和 assigned_to）。
  3. 可选：记录一次 "任务回退" 事件。

## 6. 消息路由与实时通知

### 6.1 消息发送

```
send_message(from_instance, to_instance?, content, broadcast=false):
  case broadcast:
    for each instance in getChildren("/instances"):
      create("/messages/{instance_id}/msg-{seq}", data={from, content, ...})
  case point-to-point:
    create("/messages/{to_instance}/msg-{seq}", data={from, content, ...})
```

### 6.2 实时通知 — MCP 协议约束下的可行方案

需要解决的问题：**当 Instance B 向 Instance A 发送消息后，Instance A 如何感知？**

#### 6.2.1 方案评估

首先明确 MCP 协议的实际能力边界。Claude Code 对 Server→Client 通知的支持情况：

| MCP 通知机制 | Claude Code 行为 | 可用于消息通知？ |
|-------------|-----------------|:---:|
| `notifications/resources/list_changed` | 自动重新获取资源列表 | 间接可用 |
| `notifications/resources/updated` | 重新获取已订阅的资源 URI | **可用** |
| `notifications/tools/list_changed` | 自动重新获取工具列表 | 间接可用 |
| `notifications/message` (日志) | 可能仅写入调试日志 | 不可用 |
| 自定义通知 | 无 handler，**静默丢弃** | 不可用 |

**结论：自定义 SSE 事件无法送达 Claude Code。** 必须使用 MCP 已定义的、Claude Code 能处理的机制。

#### 6.2.2 方案：Resource Subscription + 工具轮询（双层）

```
┌──────────────────────────────────────────────────────────┐
│  Layer 1: Resource Subscription (主动通知)                │
│                                                          │
│  Instance A 订阅 orchestrator://messages/{instance_id}   │
│  新消息到达 → notifications/resources/updated            │
│  → Claude Code 重新读取该资源 → 模型感知到未读消息         │
│                                                          │
│  Layer 2: poll_messages 工具 (显式拉取)                   │
│                                                          │
│  模型主动调用 poll_messages → 获取消息正文并直接显示       │
│  适合：首次连接、订阅失效降级、立即获取消息体              │
└──────────────────────────────────────────────────────────┘
```

**Layer 1 工作流程（Resource Subscription）：**

```
Instance A                  MCP Server                     ZooKeeper
    │                           │                              │
    │── resources/subscribe ──>│                              │
    │   uri=orchestrator://    │── watch /messages/A/ ───────>│
    │   messages/A             │                              │
    │<── OK ──────────────────│                              │
    │                           │                              │
    │                           │<── send_message(to=A) ───────│
    │                           │── create /messages/A/msg-42 >│
    │                           │<── ZK Watch fires ──────────│
    │                           │                              │
    │<── notifications/ ───────│                              │
    │    resources/updated     │                              │
    │    {uri: orchestrator:// │                              │
    │     messages/A}          │                              │
    │                           │                              │
    │── resources/read ───────>│                              │
    │   uri=orchestrator://    │── getChildren + getData ────>│
    │   messages/A             │<── 消息列表 ─────────────────│
    │<── 未读消息摘要 ─────────│                              │
```

资源 `orchestrator://messages/{instance_id}` 返回该实例的未读消息列表，包含消息 ID、发送者、时间戳和内容摘要。Claude Code 看到资源更新后，模型可以决定立即调用 `poll_messages` 获取完整消息体，或先读完当前任务再处理。

**Layer 2 工作流程（显式轮询）：**

```
poll_messages(instance_id):
  1. getChildren("/messages/{instance_id}")
  2. 过滤 read=false 的消息
  3. 对每条消息 getData() 获取完整内容
  4. 标记 read=true
  5. 返回消息列表

wait_for_message(instance_id, timeout_seconds=30):
  1. 检查 /messages/{instance_id} 是否有未读消息
  2. 如果有 → 立即返回
  3. 如果没有 → 在 ZK 路径上设置 Watch，阻塞等待
  4. Watch 触发或超时 → 返回消息列表（可能为空）
```

**使用策略：**

| 场景 | 推荐方式 | 说明 |
|------|---------|------|
| 主动等待回复 | `wait_for_message` | 发送求助后，阻塞等待回复（长轮询，≤30s） |
| 定期检查 | `poll_messages` | 模型在处理任务间隙主动检查 |
| 后台感知 | Resource Subscription | `notifications/resources/updated` 触发模型注意到有新消息 |

### 6.3 消息清理

- 消息被 `poll_messages` 读取后标记 `read=true`。
- `wait_for_message` 返回的消息也标记为已读。
- Server 定期清理超过 TTL（默认 24h）的已读消息节点。
- 接收方可调用 `dismiss_message(message_id)` 主动删除。

## 7. MCP 接口定义

### 7.1 Tools

| Tool | 参数 | 返回 | 说明 |
|------|------|------|------|
| `register_instance` | `name: str, role: str` | `instance_id: str` | 注册实例，返回 UUID |
| `heartbeat` | `current_task: str?` | `ok` | 更新心跳和当前任务（ZK session 维持存活） |
| `push_task` | `title, description, priority?, assignee?` | `task_id: str` | 向队列推送任务 |
| `claim_task` | — | `task \| null` | 认领最优先的待办任务 |
| `complete_task` | `task_id: str, result: str` | `ok` | 标记任务完成 |
| `send_message` | `to_instance: str?, content: str, broadcast: bool?` | `message_id: str` | 发送消息 |
| `poll_messages` | — | `[Message]` | 拉取所有未读消息（非阻塞） |
| `wait_for_message` | `timeout_seconds: int?` | `[Message]` | 阻塞等待新消息到达（长轮询，默认 30s） |
| `mark_read` | `message_id: str` | `ok` | 标记消息已读 |
| `dismiss_message` | `message_id: str` | `ok` | 删除消息 |
| `set_context` | `key: str, value: str` | `ok` | 写入共享上下文 |
| `get_context` | `key: str` | `str \| null` | 读取共享上下文 |
| `delete_context` | `key: str` | `ok` | 删除共享上下文 |
| `list_context_keys` | — | `[str]` | 列出所有上下文键 |
| `list_instances` | — | `[Instance]` | 列出所有活跃实例 |
| `list_tasks` | `status: str?` | `[Task]` | 列出任务（可按状态过滤） |
| `request_help` | `question: str, context: str?` | `message_id: str` | 广播求助消息 |

### 7.2 Resources

| URI Pattern | Content-Type | Subscribe | 说明 |
|-------------|-------------|:---------:|------|
| `orchestrator://instances` | `application/json` | — | 活跃实例列表 |
| `orchestrator://tasks/pending` | `application/json` | — | 待办任务列表 |
| `orchestrator://tasks/in-progress` | `application/json` | — | 进行中任务列表 |
| `orchestrator://messages/{instance_id}` | `application/json` | **支持** | 本实例未读消息列表 |
| `orchestrator://context/{key}` | `text/plain` | 支持 | 指定上下文值 |

**Resource Subscription 声明：**

Server 初始化时声明 `resources.subscribe: true`。Claude Code 实例可通过 `resources/subscribe` 订阅 `orchestrator://messages/{instance_id}`。当该实例收到新消息时，Server 发送 `notifications/resources/updated`，Claude Code 自动重新读取该资源，模型感知到未读消息。

### 7.3 Prompts

| Prompt | 参数 | 说明 |
|--------|------|------|
| `status_report` | — | 生成当前所有实例和任务的状态报告模板 |
| `task_handoff` | `task_id: str, to_instance: str` | 生成任务移交模板（含上下文摘要） |

## 8. 数据模型

### Instance

```json
{
  "id": "uuid",
  "name": "Jerry-Dev",
  "role": "developer",
  "status": "idle | busy | blocked",
  "current_task_id": null,
  "connected_since": "2026-05-09T10:00:00Z"
}
```

### Task

```json
{
  "id": "task-0000000001",
  "title": "实现 POST /api/items",
  "description": "...",
  "priority": 0,
  "status": "pending | claimed | in_progress | completed | blocked",
  "created_by": "instance-A",
  "assigned_to": null,
  "claimed_at": null,
  "completed_at": null,
  "result": null
}
```

### Message

```json
{
  "id": "msg-0000000001",
  "from": "instance-A",
  "to": null,
  "content": "数据库迁移策略有歧义，请确认",
  "created_at": "2026-05-09T10:30:00Z",
  "read": false,
  "type": "direct | broadcast | help"
}
```

## 9. 安全设计

| 层面 | 措施 | 说明 |
|------|------|------|
| 网络 | 默认监听 `127.0.0.1:3100` | 仅本地访问 |
| 身份 | Instance Name 白名单 | Server 配置允许的实例名列表 |
| 授权 | 实例只能操作自己的 claimed task | `complete_task` 校验 claimed 节点归属 |
| 传输 | 可选 TLS | 生产环境建议启用 |
| ZooKeeper | ACL + Digest 认证 | 限制节点访问权限 |
| 数据 | 消息内容不加密 | 本地开发环境，生产环境建议 TLS + ZK ACL |

## 10. 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 语言 | Python 3.12+ | MCP SDK 官方支持，生态成熟 |
| MCP 框架 | `mcp[cli]` (FastMCP) | Anthropic 官方 SDK |
| Web 框架 | FastAPI + uvicorn | 原生 ASGI 支持，SSE 友好 |
| 传输协议 | Streamable HTTP (SSE) | 多客户端长连接，MCP 协议通知推送 |
| 分布式协调 | ZooKeeper 3.8+ | 服务发现 + Watch + 顺序节点 |
| ZK 客户端 | `kazoo` | Python 最成熟的 ZK 客户端库 |
| 容器化 | Docker + docker-compose | ZooKeeper 单节点 / 集群 |

## 11. 项目结构

```
claude-mcp-server/
├── pyproject.toml
├── README.md
├── CLAUDE.md
├── docs/
│   └── prd/
│       ├── README.md              # 本 PRD 文档
│       ├── architecture.md        # 架构细节
│       └── zookeeper-schema.md    # ZK 节点详细定义
├── docker-compose.yml             # ZooKeeper 服务
├── src/
│   ├── __init__.py
│   ├── server.py                  # FastMCP 入口，工具注册
│   ├── zk_client.py               # ZooKeeper 连接管理与工具函数
│   ├── registry.py                # 实例注册表
│   ├── task_queue.py              # 任务队列
│   ├── message_router.py          # 消息路由 + Resource Subscription + wait_for_message
│   ├── context_store.py           # 共享键值存储
│   └── models.py                  # Pydantic 数据模型
├── scripts/
│   ├── start-zk.sh                # 启动本地 ZooKeeper
│   ├── start-server.sh            # 启动 MCP Server
│   └── stop-all.sh
└── tests/
    ├── conftest.py                # pytest fixtures (ZK 测试容器)
    ├── test_registry.py
    ├── test_task_queue.py
    ├── test_message_router.py
    └── test_integration.py
```

## 12. 实时性问题深度分析

### 12.1 MCP 协议约束

Claude Code 的 MCP 客户端仅处理协议定义的通知类型。**自定义通知会被静默丢弃。** 因此消息实时推送不能依赖自定义 SSE 事件，必须使用协议已定义的通道。

### 12.2 Resource Subscription 延迟

从 Instance B 发送消息到 Instance A 感知，完整链路：

```
B → send_message → MCP Server → ZK create → ZK Watch fire →
MCP Server → notifications/resources/updated (SSE) →
Claude Code → resources/read → 模型感知
```

| 环节 | 典型延迟 | 说明 |
|------|---------|------|
| `send_message` HTTP POST | <5ms | 本地回环 |
| ZK create + Watch fire | <10ms | ZK 内存操作 + 回调 |
| `notifications/resources/updated` SSE | <5ms | Streamable HTTP 已有长连接 |
| Claude Code → `resources/read` | ~50-200ms | 取决于 Claude Code 内部调度 |
| 模型感知 | 取决于当前是否正在生成 | 生成中断后可见 |
| **端到端延迟** | **<100ms (理想)** | 实际取决于 Claude Code 调度间隔 |

### 12.3 wait_for_message 延迟（主动等待）

```
Instance A 调用 wait_for_message → MCP Server 在 ZK 上设置 Watch →
ZK Watch 触发 → 返回消息
```

| 环节 | 典型延迟 | 说明 |
|------|---------|------|
| HTTP POST + ZK Watch 注册 | <10ms | |
| 等待消息到达 | 可变 | 取决于发送方何时发送 |
| Watch 触发 → 返回 | <10ms | |
| **Server 侧延迟** | **<20ms** | 不含等待时间 |

`wait_for_message` 是工具调用，结果直接返回给模型——无 Claude Code 调度延迟。这是**最可靠的实时消息获取方式**。

### 12.4 两种机制对比

| 维度 | Resource Subscription | poll_messages | wait_for_message |
|------|----------------------|---------------|------------------|
| 触发方式 | 推送（被动感知） | 拉取（主动查询） | 拉取（阻塞等待） |
| 延迟 | ~50-200ms + 调度 | 取决于调用频率 | <20ms（消息到达后） |
| 可靠性 | 依赖 SSE 连接和 Watch | 最高（请求-响应） | 高（长轮询） |
| 适用场景 | 后台感知有新消息 | 定期同步/降级 | 期望立即收到回复 |
| MCP 兼容 | 完全兼容 | 完全兼容 | 完全兼容 |

### 12.5 可靠性保证

| 场景 | 处理 |
|------|------|
| Resource Subscription SSE 断开 | Claude Code MCP SDK 自动重连（指数退避 1s→30s） |
| ZK Watch 丢失 | 每次通知后重建 Watch；定期（30s）全量对比校验 |
| ZK Session 超时 | Kazoo 自动重连；重连后重建所有 Watch |
| `wait_for_message` 超时 | 返回空列表，模型可再次调用 |
| 消息重复 | 消息 ID 去重；消息标记 read=true 后不重复返回 |
| 消息丢失 | ZK 持久节点 + 顺序写，写入成功即不丢失 |

## 13. 典型工作流

```
1. Tom (Architect) 启动 Claude Code，注册 register_instance(name="Tom", role="architect")
2. Jerry (Developer) 注册 register_instance(name="Jerry", role="developer")
3. 各实例通过 resources/subscribe 订阅 orchestrator://messages/{instance_id}
4. Tom push_task("实现 POST /api/items", assignee="Jerry", priority=0)
5. Jerry claim_task → 获得任务
6. Jerry heartbeat(current_task="实现 POST /api/items")
7. Lucy (Tester) 注册，list_instances → 看到 Tom(idle)、Jerry(busy)
8. Jerry 遇到问题 → request_help("数据库迁移策略有歧义")
   → Server 创建 /messages/Tom/msg-001，发送 notifications/resources/updated
9. Tom 的 Claude Code 收到 resources/updated 通知，重新读取 messages 资源
   → 模型感知："有新消息：Jerry 求助"
10. Tom 调用 poll_messages → 获取完整消息内容
11. Tom send_message(to="Jerry", content="用 alembic 的 --sql 模式生成审计 SQL")
   → Jerry 通过相同机制感知到回复
12. Jerry 在此期间调用 wait_for_message(timeout=30) 阻塞等待回复
    → 收到 Tom 的消息，继续工作
13. Jerry complete_task(task_id, result="PR #42")
14. Lucy push_task("E2E 验证 POST /api/items", priority=0) → claim_task
15. Lucy complete_task(task_id, result="全部通过")
16. Tom list_tasks → 确认所有任务完成
```

## 14. 实施路线

| 阶段 | 内容 | 产出 | 工期 |
|------|------|------|------|
| Phase 1 | 项目骨架 + ZK 客户端 + Instance Registry | `server.py`, `zk_client.py`, `registry.py` | 1 天 |
| Phase 2 | Task Queue (push/claim/complete) + 认领原子性 | `task_queue.py` | 1 天 |
| Phase 3 | Message Router + SSE 实时推送 | `message_router.py` | 1 天 |
| Phase 4 | Shared Context + Resource 端点 + Prompts | `context_store.py` | 0.5 天 |
| Phase 5 | `request_help` + 集成测试 | `test_integration.py` | 0.5 天 |
| Phase 6 | docker-compose + 启动脚本 + 端到端验证 | `docker-compose.yml`, `scripts/` | 0.5 天 |

总计：**4.5 天**
