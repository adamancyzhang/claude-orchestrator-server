# 架构细节

## 组件交互图

```
┌──────────────────────────────────────────────────────────────┐
│                     MCP Server (Express + MCP SDK)           │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    Tool Layer                         │   │
│  │  register_instance  push_task   send_message  ...     │   │
│  └──────────┬──────────────┬──────────────┬─────────────┘   │
│             │              │              │                  │
│  ┌──────────┴──────────────┴──────────────┴─────────────┐   │
│  │                 Service Layer                         │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │   │
│  │  │ Registry │  │  Queue   │  │  MessageRouter     │  │   │
│  │  │          │  │          │  │  ┌────────────────┐ │  │   │
│  │  │ - register│  │ - push   │  │  │ Subscriptions  │ │  │   │
│  │  │ - heartbeat│ │ - claim  │  │  │ - resource sub │ │  │   │
│  │  │ - list   │  │ - complete│  │  │ - watch→notify │ │  │   │
│  │  │          │  │          │  │  └──────┬─────────┘ │  │   │
│  │  └────┬─────┘  └────┬─────┘  └─────────┼───────────┘  │   │
│  │       │              │                  │               │   │
│  └───────┼──────────────┼──────────────────┼───────────────┘   │
│          │              │                  │                    │
│  ┌───────┴──────────────┴──────────────────┴───────────────┐   │
│  │                 ZK Client (node-zookeeper-client)        │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────────┐     │   │
│  │  │ CRUD ops │  │  Watch   │  │  Session Mgmt      │     │   │
│  │  └──────────┘  │  Manager │  │  - auto reconnect  │     │   │
│  │                 │          │  │  - expiry handler  │     │   │
│  │                 └──────────┘  └────────────────────┘     │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
└─────────────────────────┼────────────────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              │     ZooKeeper         │
              │  (单节点 / 集群)       │
              └───────────────────────┘
```

## MCP 协议约束

设计消息实时通知时，必须了解 Claude Code 对 Server→Client 通知的处理范围：

| 通知类型 | Claude Code 行为 | 用途 |
|---------|-----------------|------|
| `notifications/resources/updated` | 自动重新读取已订阅资源 URI | 消息通知的主通道 |
| `notifications/resources/list_changed` | 自动重新获取资源列表 | 资源列表批量变更 |
| `notifications/tools/list_changed` | 自动重新获取工具列表 | 工具动态注册/注销 |
| `notifications/message` (日志) | 可能仅写入调试日志 | 不可用于业务通知 |
| 自定义通知 | **静默丢弃**（无 handler） | 不可用 |

**关键约束：不能用自定义 SSE 事件推送消息。** 所有 Server→Client 通信必须通过 MCP 协议已定义且 Claude Code 已注册 handler 的通知类型。Resource Subscription 是唯一可行的消息"推送"通道。

## Streamable HTTP 传输

MCP Server 使用 Streamable HTTP，支持两种通信模式：

- **HTTP POST**：工具调用和资源读取（请求-响应，短连接）
- **SSE GET**：MCP 协议内置的 Streamable HTTP 通道，传输 `notifications/*` 事件

```
POST /mcp                      →  JSON-RPC 请求/响应
GET  /mcp (SSE)                →  服务端→客户端通知流
```

### MCP 协议通知（Claude Code 可处理）

以下通知类型由 MCP SDK 和 Claude Code 内置处理，**无需自定义 SSE 事件**：

```
# 资源变更通知 — 用于实时消息推送
event: notifications/resources/updated
data: {"jsonrpc":"2.0","method":"notifications/resources/updated",
       "params":{"uri":"orchestrator://messages/instance-A"}}

# 资源列表变更（批量）
event: notifications/resources/list_changed
data: {"jsonrpc":"2.0","method":"notifications/resources/list_changed"}

# 工具列表变更
event: notifications/tools/list_changed
data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}
```

**自定义通知不可用**：Claude Code 会静默丢弃未注册 handler 的通知类型。所有 Server→Client 通信必须使用上述协议定义的通知。

### Resource Subscription 工作流

这是实现消息实时通知的核心机制：

```
1. Server 在 initialize 响应中声明 capabilities.resources.subscribe = true
2. Instance A 调用 resources/subscribe { uri: "orchestrator://messages/A" }
3. 当 /messages/A 有新消息时:
   a. ZK Watch 触发 → Server 记录该 resource 已变更
   b. Server 通过 SSE 发送 notifications/resources/updated { uri: "orchestrator://messages/A" }
   c. Claude Code MCP 客户端接收通知，自动调用 resources/read
   d. 资源内容（消息列表）返回给 Claude Code，模型感知到新消息
```

## 认领任务的原子性保证

ZooKeeper 不能直接实现 compare-and-swap 语义。认领任务的原子性通过以下方式保证：

```typescript
async claim(instanceId: string): Promise<Task | null> {
  // 1. 获取所有待办任务，按优先级和 FIFO 排序
  const pending = await this.zk.listPendingTasks();
  pending.sort((a, b) => sortByPriorityAndFifo(a, b, instanceId));

  for (const [taskId, data] of pending) {
    const claimedPath = `${TASKS_CLAIMED}/${instanceId}-${taskId}`;
    try {
      // 2. 原子性创建 claimed 节点 (EPHEMERAL)
      await this.zk.create(claimedPath, taskBytes, CreateMode.EPHEMERAL);
      // 3. 成功 → 先获取任务数据，再删除 pending 节点
      await this.zk.deletePendingTask(taskId);
      return TaskSchema.parse(data);
    } catch (err) {
      if (isNodeExists(err)) {
        // 另一个实例抢先认领了这个任务，试下一个
        continue;
      }
      if (isNoNode(err)) {
        // 任务已被删除，试下一个
        continue;
      }
      throw err;
    }
  }
  return null;
}
```

关键点：`zk.create(claimedPath, EPHEMERAL)` 是**原子操作** — 同一个路径只能被成功创建一次。

## 会话恢复

当 MCP Server 进程重启时：

1. `node-zookeeper-client` 自动重连 ZK（session timeout 内重连可保留 Ephemeral 节点）。
2. 若 session 已过期 → 所有 Ephemeral 节点被 ZK 清除。
3. 重启后 Server 扫描 `/instances` 重建实例列表（此时为空）。
4. 扫描 `/tasks/claimed` 将孤立任务移回 `/tasks/pending`。
5. 各实例重新 `register_instance` 恢复。

对于 Claude Code 实例侧的恢复：
- MCP SDK 自动管理 SSE 重连（指数退避 1s→30s）。
- 重连成功后调用 `register_instance` 获取新 UUID。
- 调用 `poll_messages` 拉取离线期间的消息。
- 重新调用 `resources/subscribe` 恢复消息订阅。

## 配置

### Server 配置 (环境变量)

```bash
# ZooKeeper
ZK_HOSTS=127.0.0.1:2181
ZK_ROOT_PATH=/claude-orchestrator

# Server
MCP_SERVER_HOST=127.0.0.1
MCP_SERVER_PORT=3100

# Instance whitelist
ALLOWED_INSTANCE_NAMES=Tom,Jerry,Lucy,Admin

# Session
ZK_SESSION_TIMEOUT_MS=30000
INSTANCE_HEARTBEAT_INTERVAL_S=30
INSTANCE_OFFLINE_THRESHOLD_S=90
MESSAGE_TTL_HOURS=24
```

### Claude Code 实例配置 (`.claude/mcp.json`)

```json
{
  "mcpServers": {
    "orchestrator": {
      "url": "http://127.0.0.1:3100/mcp",
      "headers": {
        "X-Instance-Name": "Jerry-Dev",
        "X-Instance-Role": "developer"
      }
    }
  }
}
```
