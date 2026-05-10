# Claude MCP Server — 多实例协同编排方案

## 1. 概述

为多个 Claude Code 实例提供统一的协调中心。每个实例通过 MCP 协议连接 Server，实现任务分发、消息传递、状态共享和上下文同步。

## 2. 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude MCP Server                        │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Instance │  │  Task    │  │ Message  │  │  Shared    │  │
│  │ Registry │  │  Queue   │  │  Router  │  │  Context   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       │              │              │              │         │
│  ┌────┴──────────────┴──────────────┴──────────────┴──────┐ │
│  │              Redis (Real-time State + Pub/Sub)          │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  Transport: HTTP/SSE (Streamable HTTP)                      │
│  Port: 3100                                                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────┴────┐       ┌────┴────┐       ┌────┴────┐
    │ Claude  │       │ Claude  │       │ Claude  │
    │ Instance│       │ Instance│       │ Instance│
    │  A      │       │  B      │       │  C      │
    └─────────┘       └─────────┘       └─────────┘
```

- **Instance Registry**: 跟踪所有已连接的 Claude 实例，记录角色、当前任务、心跳时间。
- **Task Queue**: 全局任务队列，支持 FIFO 和优先级分配。
- **Message Router**: 实例间的消息路由，支持点对点和广播。
- **Shared Context**: 全局键值存储，实例间共享上下文快照。

## 3. MCP 接口设计

### 3.1 Tools

| Tool | 参数 | 说明 |
|------|------|------|
| `register_instance` | `role: string, description: string` | 注册本实例的角色和描述 |
| `heartbeat` | `current_task: string?` | 发送心跳，更新当前任务信息 |
| `push_task` | `title, description, priority?, assignee?` | 向队列推送任务 |
| `claim_task` | — | 认领队列中最优先的待办任务 |
| `complete_task` | `task_id: string, result: string` | 标记任务完成 |
| `send_message` | `to_instance: string?, content: string, broadcast: bool?` | 发送消息给指定实例或广播 |
| `poll_messages` | — | 拉取本实例的未读消息 |
| `set_context` | `key: string, value: string` | 写入共享上下文 |
| `get_context` | `key: string` | 读取共享上下文 |
| `list_instances` | — | 列出所有活跃实例及其状态 |
| `list_tasks` | `status: string?` | 列出任务队列（可按状态过滤） |
| `request_help` | `question: string, context: string?` | 向其他实例发起求助 |

### 3.2 Resources

| URI Pattern | 说明 |
|-------------|------|
| `orchestrator://instances` | 活跃实例列表 JSON |
| `orchestrator://tasks/pending` | 待办任务 JSON |
| `orchestrator://tasks/in-progress` | 进行中任务 JSON |
| `orchestrator://context/{key}` | 指定键的共享上下文值 |

### 3.3 Prompts

| Prompt | 说明 |
|--------|------|
| `status_report` | 生成当前所有实例和任务的状态报告模板 |
| `task_handoff` | 生成任务移交模板（含上下文摘要） |

## 4. 数据模型

### Instance

```
{
  id: string,           // UUID，首次注册时分配
  name: string,         // 可读名称（如 "Jerry-Dev"）
  role: string,         // 角色：architect / developer / tester / general
  status: "idle" | "busy" | "blocked",
  current_task_id: string | null,
  last_heartbeat: ISO8601,
  connected_since: ISO8601
}
```

### Task

```
{
  id: string,
  title: string,
  description: string,
  priority: 0 | 1 | 2,            // 0=高, 1=中, 2=低
  status: "pending" | "claimed" | "in_progress" | "completed" | "blocked",
  created_by: string,              // instance_id
  assigned_to: string | null,      // instance_id
  claimed_at: ISO8601 | null,
  completed_at: ISO8601 | null,
  result: string | null
}
```

### Message

```
{
  id: string,
  from: string,         // instance_id
  to: string | null,    // null = broadcast
  content: string,
  created_at: ISO8601,
  read: boolean
}
```

## 5. 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 语言 | Python 3.12+ | 与 Aino Worker 同技术栈，MCP SDK 官方支持 |
| MCP SDK | `mcp[cli]` (anthropic 官方) | FastMCP 简化 Server 开发 |
| Web 框架 | FastAPI + uvicorn | MCP Streamable HTTP 基于 ASGI |
| 传输协议 | Streamable HTTP (SSE) | 支持多客户端长连接，比 stdio 适合多实例场景 |
| 实时状态 | Redis (已有) | Pub/Sub + JSON 存储，与现有 infra 一致 |
| 持久存储 | PostgreSQL (已有) | 任务历史和消息归档 |

## 6. 关键设计决策

### 6.1 实例识别

每个 Claude Code 实例在启动时通过 `--mcp-config` 加载唯一身份：

```json
{
  "mcpServers": {
    "orchestrator": {
      "url": "http://localhost:3100/mcp",
      "headers": {
        "X-Instance-Name": "Jerry-Dev",
        "X-Instance-Role": "developer"
      }
    }
  }
}
```

首次连接时 Server 分配 UUID 并在响应中返回，后续请求携带该 ID。

### 6.2 心跳与存活检测

- 实例每 30 秒调用一次 `heartbeat`。
- Server 超过 90 秒无心跳标记为 `offline`，其持有的任务自动回退为 `pending`。
- 实例重连时可通过 `claim_task` 恢复持有的任务。

### 6.3 任务分配策略

```
claim_task 优先级规则:
1. 有明确 assignee 且匹配当前实例 → 优先
2. priority=0 的未分配任务
3. FIFO order in same priority
```

不自动推任务 — 由实例主动拉取（`claim_task`），避免打扰正在忙碌的实例。

### 6.4 消息通知

- 实例调用 `poll_messages` 轮询未读消息（拉模式）。
- Server 端同时维护 Redis Pub/Sub channel `instance:{id}:notifications`，支持 Server-Sent Events 实时推送。
- `request_help` 作为特殊消息类型，广播给所有角色匹配的实例。

## 7. 项目结构

```
aino-worker-claude3/
├── mcp-server/
│   ├── pyproject.toml
│   ├── README.md
│   ├── src/
│   │   ├── __init__.py
│   │   ├── server.py          # FastMCP 入口
│   │   ├── registry.py        # 实例注册表 (Redis)
│   │   ├── task_queue.py      # 任务队列 (Redis + PG)
│   │   ├── message_router.py  # 消息路由 (Redis Pub/Sub)
│   │   ├── context_store.py   # 共享键值存储 (Redis)
│   │   └── models.py          # Pydantic 数据模型
│   └── tests/
│       ├── test_registry.py
│       ├── test_task_queue.py
│       └── test_integration.py
```

## 8. 安全考虑

- 仅监听 `127.0.0.1:3100`，不对外暴露。
- Instance Name 白名单校验，拒绝未识别的实例名。
- 消息内容不做持久化加密（均为本地开发环境）。
- 正式环境建议加入 HMAC 签名验证 Header。

## 9. 与 Aino Worker 集成

- 复用项目现有 Docker Compose 启动 Redis 和 PostgreSQL。
- 添加 `scripts/mcp-server-start.sh` 和 `scripts/mcp-server-stop.sh` 生命周期脚本。
- 在 `scripts/dev-start.sh` 中增加可选的 MCP Server 启动。
- 每个 Claude Code 实例通过项目级 `.claude/mcp.json` 加载 orchestrator 配置。

## 10. 典型工作流

```
1. Tom (Architect) 制定 OpenAPI 契约
2. Tom push_task("实现 POST /api/items", assignee="Jerry-Dev", priority=0)
3. Jerry (Developer) claim_task → 获得任务
4. Jerry heartbeat(current_task="实现 POST /api/items")
5. Lucy (Test) list_instances → 看到 Jerry 正在忙
6. Jerry 遇到问题 → request_help("数据库迁移策略有歧义")
7. Tom poll_messages → 收到求助，回复消息
8. Jerry complete_task(task_id, result="PR #42")
9. Lucy push_task("E2E 验证 POST /api/items", priority=0)
10. Lucy claim_task → 认领测试任务
11. Lucy complete_task(task_id, result="全部通过 ✓")
12. Tom list_tasks → 确认所有任务完成
```

## 11. 实施路线

| 阶段 | 内容 | 工期 |
|------|------|------|
| Phase 1 | MCP Server 骨架 + Instance Registry + 心跳 | 1 天 |
| Phase 2 | Task Queue (push/claim/complete) | 1 天 |
| Phase 3 | Message Router (send/poll/broadcast) | 0.5 天 |
| Phase 4 | Shared Context (set/get) + Resource 端点 | 0.5 天 |
| Phase 5 | request_help + 通知推送 | 0.5 天 |
| Phase 6 | 集成到 dev-start.sh + 端到端测试 | 0.5 天 |
