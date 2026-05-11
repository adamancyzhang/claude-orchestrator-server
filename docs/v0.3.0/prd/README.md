# Claude Orchestrator v0.3.0 — Leader-based CLI-native 协同编排 PRD

## 1. 概述

v0.3.0 是一次根本性的架构变革：**从中心化 MCP Server 模型转向 Leader-based P2P CLI-native 模型**。

核心变化：

- **弃用 MCP 协议**：移除 `@modelcontextprotocol/sdk`、Express HTTP 服务、SSE 传输层。所有交互通过 CLI + ZooKeeper 直连完成。
- **引入 Leader 节点**：`claude-orchestrator leader` 启动一个带 TUI 的长期运行协调进程，替代原来的 `claude-orchestrator server`。
- **纯 CLI-native 成员**：每个 Claude Code 实例通过 `claude-orchestrator register --work-dir <dir>` 注册为 worker，本地监听消息并自动调用 `claude -p` 处理。
- **直接 ZK 操作**：所有 CLI 命令直接读写 ZooKeeper，无中间服务器代理。

### 为什么从 MCP Server 转向 Leader + CLI-native？

| 维度 | v0.2.0 MCP Server | v0.3.0 Leader + CLI |
|------|-------------------|---------------------|
| 架构 | 中心化 MCP 服务器，所有实例通过 HTTP 连接 | 去中心化，Leader 和 Member 各自直连 ZK |
| 通信层 | Streamable HTTP (SSE) + JSON-RPC | ZK 直连 (原生 TCP) |
| 消息推送 | MCP Resource Subscription (依赖 Claude Code SDK 行为) | ZK Watch → 本地 `claude -p` 子进程 |
| 可靠性 | 依赖 MCP Server 进程 + SSE 长连接 | 依赖 ZK Session，各节点自包含 |
| 启动方式 | 先启动 server，再配置 `.claude/mcp.json` | Leader 启动后，Member 一条 `register` 命令即可加入 |
| 依赖 | `@modelcontextprotocol/sdk` + Express | 仅 `node-zookeeper-client` |
| 调试 | 需排查 MCP 协议层、SSE 连接、ZK 三层 | 仅 ZK 一层，CLI 输出直观 |
| 扩展性 | 单点 MCP Server (可多实例但需负载均衡) | Leader 天然可替换，ZK 保证协调 |

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                          ZooKeeper                                   │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────┐ │
│  │/leader   │  │/instances│  │/tasks    │  │/messages │  │/context│ │
│  │[EPHEMERAL]│  │[EPHEMERAL]│  │[SEQ+EPH] │  │[SEQ]     │  │[PERS]  │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └───────┘ │
└──────┬───────────────┬──────────────┬──────────────┬─────────────────┘
       │               │              │              │
  ┌────┴────┐    ┌─────┴─────┐  ┌─────┴─────┐  ┌───┴───────────┐
  │ Leader  │    │ Member A  │  │ Member B  │  │ CLI (ad-hoc)  │
  │ (TUI)   │    │ (worker)  │  │ (worker)  │  │               │
  │         │    │           │  │           │  │  push_task     │
  │ 监控全队 │    │ claude -p │  │ claude -p │  │  send_message  │
  │ 任务分配 │    │ 本地处理   │  │ 本地处理   │  │  list_tasks   │
  │ 消息路由 │    │           │  │           │  │  ...          │
  └─────────┘    └───────────┘  └───────────┘  └───────────────┘
```

### 核心概念

| 概念 | 说明 | 进程模型 |
|------|------|---------|
| **Leader** | 团队协调者，运行 TUI，监控全局状态 | 长期运行 (`claude-orchestrator leader`) |
| **Member** | 工作实例，注册后监听消息，通过 `claude -p` 处理 | 长期运行 (`claude-orchestrator register --work-dir`) |
| **CLI** | 一次性命令，直接操作 ZK | 短期运行 (如 `push-task`, `send-message`) |

### 核心模块

| 模块 | 职责 | 运行位置 |
|------|------|---------|
| Instance Registry | 实例注册、心跳、存活检测 | 所有节点直连 ZK |
| Task Queue | 任务入队、认领、完成、超时恢复 | Leader 监控 + Member 认领 |
| Message Router | 点对点消息、广播、求助 | ZK Watch + 本地 `claude -p` |
| Context Store | 全局键值存储 | 所有节点直连 ZK |
| Recovery Handler | 孤儿任务回收、实例断线处理 | Leader 专属 |

## 3. Leader 节点设计

### 3.1 启动

```bash
claude-orchestrator leader [--name <name>]
```

启动后：
1. 连接 ZooKeeper，创建 `/leader` 临时节点声明领导权
2. 初始化 TUI 界面
3. 注册所有 ZK Watch 监听团队状态变化
4. 进入事件循环，等待 TUI 输入和 ZK 事件

### 3.2 Leader 职责

```
┌─────────────────────────────────────────┐
│               Leader Node               │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │           TUI Console           │    │
│  │  ┌───────────────────────────┐  │    │
│  │  │ Team Panel (members list) │  │    │
│  │  ├───────────────────────────┤  │    │
│  │  │ Task Panel (queues)       │  │    │
│  │  ├───────────────────────────┤  │    │
│  │  │ Event Log                 │  │    │
│  │  ├───────────────────────────┤  │    │
│  │  │ Command Input             │  │    │
│  │  └───────────────────────────┘  │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │       Orchestration Engine      │    │
│  │  ┌───────────┐ ┌─────────────┐ │    │
│  │  │ Member    │ │ Task        │ │    │
│  │  │ Monitor   │ │ Orchestrator│ │    │
│  │  │           │ │             │ │    │
│  │  │ - join    │ │ - pending→  │ │    │
│  │  │ - leave   │ │   claimed   │ │    │
│  │  │ - status  │ │ - timeout   │ │    │
│  │  │ - heartbeat│ │ - recovery  │ │    │
│  │  └───────────┘ └─────────────┘ │    │
│  │  ┌───────────┐ ┌─────────────┐ │    │
│  │  │ Message   │ │ Context     │ │    │
│  │  │ Monitor   │ │ Monitor     │ │    │
│  │  │           │ │             │ │    │
│  │  │ - watch   │ │ - watch     │ │    │
│  │  │   all msg │ │   changes   │ │    │
│  │  │   dirs    │ │             │ │    │
│  │  └───────────┘ └─────────────┘ │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │         ZK Session Manager      │    │
│  │  - connection lifecycle         │    │
│  │  - watch registration/renewal   │    │
│  │  - session expiry handling      │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

### 3.3 Leader TUI

TUI 使用终端控制字符实现（无需额外依赖），分为四个区域：

**A. 团队面板 (Team Panel)** — 顶部，实时显示所有在线成员：

```
┌─ Team: 3 members ─────────────────────────────────────────────┐
│ Name         Role        Status    Current Task                │
│ Tom          architect   idle      -                           │
│ Jerry        developer   busy      task-0000000003             │
│ Lucy         tester      idle      -                           │
└────────────────────────────────────────────────────────────────┘
```

**B. 任务面板 (Task Panel)** — 中部左侧，显示任务队列：

```
┌─ Pending (2) ──────────────────┐  ┌─ In Progress (1) ───────────┐
│ [HIGH] 实现登录 (→Jerry)       │  │ Jerry: 实现 POST /api/items  │
│ [MED] 写单元测试                │  │                              │
└────────────────────────────────┘  └──────────────────────────────┘
```

**C. 事件日志 (Event Log)** — 中部，滚动显示实时事件：

```
[10:30:01] ✓ Jerry joined (developer)
[10:30:05] ✓ Lucy joined (tester)
[10:30:15] 📋 Task task-0000000003 created: 实现 POST /api/items (→Jerry)
[10:30:20] 🔒 Jerry claimed task-0000000003
[10:32:45] 📨 Jerry → broadcast: "数据库迁移策略有歧义，请确认"
[10:33:10] 📨 Tom → Jerry: "用 alembic 的 --sql 模式"
```

**D. 命令输入 (Command Input)** — 底部，交互式命令：

```
> help
Commands: task push|assign|list, msg send|broadcast, context set|get|list, status, quit
> task push --title "E2E 测试" --priority 0 --assignee Lucy
```

### 3.4 Leader TUI 命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `task push <title> [--priority 0-2] [--assignee <name>] [--desc <text>]` | 创建任务 | `task push "实现登录" --priority 0 --assignee Jerry` |
| `task assign <task-id> <member>` | 指派任务 | `task assign task-0000000003 Lucy` |
| `task list [pending\|claimed\|completed]` | 列出任务 | `task list pending` |
| `task cancel <task-id>` | 取消任务 | `task cancel task-0000000003` |
| `msg <member> <content>` | 发私信 | `msg Jerry "请检查 PR"` |
| `broadcast <content>` | 广播消息 | `broadcast "全组会议 3pm"` |
| `context set <key> <value>` | 设置共享上下文 | `context set build_status green` |
| `context get <key>` | 获取上下文 | `context get build_status` |
| `status` | 刷新状态显示 | `status` |
| `quit` / `exit` | 退出 Leader | `quit` |

## 4. Member (Worker) 设计

### 4.1 注册与启动

```bash
claude-orchestrator register \
  --name Jerry \
  --role developer \
  --work-dir /path/to/project
```

启动流程：

```
1. 连接 ZooKeeper
2. 创建 /instances/{uuid} 临时节点 (注册)
3. 保存 instance_id 到 ~/.claude-orchestrator/config.json
4. 创建 /messages/{uuid} 目录
5. 启动消息监听循环:
   a. 在 /messages/{uuid} 上设置 ChildWatch
   b. Watch 触发 → 读取新消息
   c. 对每条未读消息:
      - 打印到终端
      - spawn claude --session-id {uuid} -p "[{type} from {from_name}] {content}"
      - 等待 claude 完成
      - 标记消息已读
   d. 重建 Watch，继续监听
6. 阻塞等待 SIGINT
7. 清理: 删除 /instances/{uuid}, 关闭 ZK 连接
```

### 4.2 Member 能力

Member 通过以下方式与团队交互：

1. **自动消息处理**：`register --work-dir` 启动的 watcher 自动监听并处理收到的消息
2. **显式 CLI 操作**：Member 的 Claude Code 实例可以调用 CLI 命令：
   - `claim-task` — 认领下一个待办任务
   - `complete-task` — 完成任务
   - `send-message` — 发消息给其他成员
   - `request-help` — 广播求助
   - `poll-messages` — 检查消息
   - `set-context` / `get-context` — 共享上下文

### 4.3 Member 心跳

Member 本地 watcher 定期更新心跳（通过 ZK session keep-alive 维持临时节点，可选地更新 `current_task_id`）：

```
claude-orchestrator heartbeat --current-task "实现 POST /api/items"
```

Claude Code 实例在认领任务后应调用此命令，让 Leader 和其他成员知晓当前工作。

## 5. 通信流程

### 5.1 Leader 分配任务给 Member

```
Leader (TUI)                ZK                         Member (Jerry)
    │                         │                              │
    │── task push ───────────>│                              │
    │   /tasks/pending/       │                              │
    │   task-0000000003       │                              │
    │   assignee=Jerry        │                              │
    │                         │                              │
    │   (TUI 事件日志更新)      │                              │
    │                         │                              │
    │                         │<── claim_task ───────────────│
    │                         │── /tasks/claimed/            │
    │                         │   Jerry-task-0000000003      │
    │                         │   [EPHEMERAL]                │
    │                         │── delete /pending/task-...   │
    │                         │                              │
    │<── ZK Watch 触发 ──────│                              │
    │   (TUI 更新: Jerry busy)│                              │
    │                         │                              │
    │                         │<── complete_task ────────────│
    │                         │── /tasks/completed/task-...  │
    │                         │── delete /claimed/...        │
    │                         │                              │
    │<── ZK Watch 触发 ──────│                              │
    │   (TUI 更新: Jerry idle)│                              │
```

### 5.2 Member 求助 → 其他 Member 响应

```
Member A (Jerry)            ZK                         Member B (Tom)
    │                         │                              │
    │── request_help ────────>│                              │
    │   "DB 迁移策略有歧义"     │── /messages/Tom/msg-042      │
    │                         │── /messages/Lucy/msg-043      │
    │                         │                              │
    │                         │<── ZK Watch 触发 ─────────────│
    │                         │   (Tom 的 watcher 感知)       │
    │                         │                              │
    │                         │   Tom 的 watcher 执行:        │
    │                         │   claude -p "[help from      │
    │                         │   Jerry] DB 迁移策略..."      │
    │                         │                              │
    │                         │<── Claude Code 响应:          │
    │                         │   "用 alembic --sql 模式"     │
    │                         │                              │
    │                         │── send_message ─────────────>│
    │                         │   to=Jerry                    │
    │                         │── /messages/Jerry/msg-044     │
    │                         │                              │
    │<── ZK Watch 触发 ──────│                              │
    │   Jerry watcher:        │                              │
    │   claude -p "[direct    │                              │
    │   from Tom] 用 alembic  │                              │
    │   --sql 模式"            │                              │
```

### 5.3 Leader 断开 → 自动恢复

```
Leader 进程崩溃
    │
    ├── /leader 临时节点自动删除 (ZK session timeout)
    │
    ├── Member 不受影响 — 各自直连 ZK，继续工作
    │
    ├── 已认领的任务不受影响 — claimed 节点是各 Member 创建的
    │
    └── 新 Leader 启动:
        1. 扫描 /instances 重建团队视图
        2. 扫描 /tasks 重建任务视图
        3. 发现孤儿 claimed 任务 (Member 已离线但 claimed 节点因 ZK session 残留)
        4. 将孤儿任务移回 /tasks/pending
        5. 开始正常监控
```

### 5.4 Member 断开 → 任务回收

```
Member 进程崩溃 / 网络断开
    │
    ├── /instances/{id} 临时节点自动删除 (ZK session timeout, 默认 30s)
    │
    ├── /tasks/claimed/{id}-task-X 临时节点自动删除
    │
    ├── Leader ZK Watch 触发:
    │   1. TUI 显示: ✗ Jerry disconnected
    │   2. 检测到孤儿任务 task-X
    │   3. 将 task-X 重新写入 /tasks/pending (保留原 priority 和 assignee)
    │   4. TUI 事件日志: ↻ task-X 重新入队
    │
    └── 其他 Member 不受影响
```

## 6. 任务生命周期 (增强版)

v0.3.0 扩展了任务状态机：

```
                    ┌─────────┐
                    │ pending  │
                    └────┬─────┘
                         │ claim_task
                    ┌────▼─────┐
                    │ claimed   │
                    └────┬─────┘
                         │ heartbeat(current_task=...)
                    ┌────▼──────┐
                    │ in_progress│
                    └────┬──────┘
                     ┌───┼───┐
                ┌────▼┐  │  ┌────▼───┐
                │completed│  │ blocked  │──→ pending (重试)
                └────────┘  └────┬─────┘
                              ┌──▼───┐
                              │ failed │──→ pending (重试)
                              └───────┘
```

| 状态 | 含义 | 触发方式 |
|------|------|---------|
| `pending` | 等待认领 | `push_task` |
| `claimed` | 已认领，未开始 | `claim_task` |
| `in_progress` | 正在工作中 | `heartbeat(current_task=...)` |
| `completed` | 已完成 | `complete_task` |
| `blocked` | 被阻塞，等待解除 | `heartbeat(status=blocked)` |
| `failed` | 执行失败，可重试 | `complete_task(result="失败原因")` |

新增的 `blocked` 和 `failed` 状态让 Leader 更准确地了解团队状况，而不是简单的 idle/busy 二元状态。

## 7. ZooKeeper 节点树 (v0.3.0)

```
/claude-orchestrator
│
├── /leader                              [EPHEMERAL]  Leader 存在声明
│   data: {"instance_id":"...", "name":"...", "started_at":"..."}
│
├── /instances/
│   └── /{instance_id}                   [EPHEMERAL]  成员实例
│       data: {"id":"...", "name":"Jerry", "role":"developer",
│              "status":"busy", "current_task_id":"task-003",
│              "connected_since":"..."}
│
├── /tasks/
│   ├── /pending/
│   │   └── /task-{seq}                  [PERSISTENT_SEQUENTIAL]
│   │       data: {"id":"...", "title":"...", "description":"...",
│   │              "priority":0, "status":"pending",
│   │              "created_by":"...", "assigned_to":"Jerry-uuid",
│   │              "created_at":"...", "retry_count":0}
│   ├── /claimed/
│   │   └── /{instance_id}-{task_id}     [EPHEMERAL]
│   │       data: {"task_id":"...", "instance_id":"...",
│   │              "claimed_at":"...", "status":"claimed"}
│   └── /completed/
│       └── /{task_id}                   [PERSISTENT]
│           data: {"id":"...", "title":"...",
│                   "completed_by":"...", "completed_at":"...",
│                   "result":"...", "status":"completed",
│                   "retry_count":1}
│
├── /messages/
│   └── /{instance_id}/
│       └── /msg-{seq}                   [PERSISTENT_SEQUENTIAL]
│           data: {"id":"...", "type":"direct|broadcast|help",
│                  "from_instance":"...", "from_name":"...",
│                  "to_instance":"...", "content":"...",
│                  "created_at":"...", "read":false}
│
└── /context/
    └── /{key}                           [PERSISTENT]
        data: {"key":"...", "value":"...",
               "updated_by":"...", "updated_by_name":"...",
               "updated_at":"..."}
```

### 关键变化 vs v0.2.0

| 变化 | v0.2.0 | v0.3.0 | 原因 |
|------|--------|--------|------|
| 新增 `/leader` | 无 | EPHEMERAL 节点 | Leader 存在声明，用于检测 Leader 在线状态 |
| `Task.status` 扩展 | pending/claimed/completed | +in_progress +blocked +failed | 更精确的任务状态跟踪 |
| `Task.retry_count` | 无 | number | 记录任务重试次数 |
| `Instance.status` 扩展 | idle/busy/blocked | idle/busy/blocked (deprecate blocked) | 用 Task.blocked 代替 Instance.blocked |
| 消息清理策略 | 标记已读后 24h 自动清理 | 同上 + Leader 可手动清理 | Leader 增加管理能力 |

## 8. CLI 命令变化

### 8.1 命令对照表

| v0.2.0 命令 | v0.3.0 命令 | 变化说明 |
|------------|------------|---------|
| `server` | `leader` | **重命名**，从启动 MCP 服务改为启动 Leader TUI |
| `setup` | **删除** | 不再需要配置 `.claude/mcp.json` |
| `register` | `register` | 保留，增强 `--work-dir` 模式 |
| `status` | `status` | 保留 |
| `heartbeat` | `heartbeat` | 保留，增加 `--status blocked\|in_progress` |
| `list-instances` | `list-instances` | 保留 |
| `push-task` | `push-task` | 保留 |
| `claim-task` | `claim-task` | 保留 |
| `complete-task` | `complete-task` | 保留，`--result` 可选 |
| `list-tasks` | `list-tasks` | 保留，增加 `--status blocked\|failed` |
| `send-message` | `send-message` | 保留 |
| `poll-messages` | `poll-messages` | 保留 |
| `wait-for-message` | `wait-for-message` | 保留 |
| `dismiss-message` | `dismiss-message` | 保留 |
| `request-help` | `request-help` | 保留 |
| `set-context` | `set-context` | 保留 |
| `get-context` | `get-context` | 保留 |
| `delete-context` | `delete-context` | 保留 |
| `list-context-keys` | `list-context-keys` | 保留 |
| `watch-context` | `watch-context` | 保留 |
| `watch-tasks` | `watch-tasks` | 保留 |
| `unregister` | `unregister` | 保留 |
| `config` | `config` | 保留 |
| — | **新增** `leader` | 启动 Leader 节点 (TUI) |
| — | **新增** `task-block` | 标记任务为 blocked |
| — | **新增** `task-fail` | 标记任务为 failed |
| — | **新增** `task-retry` | 将 failed 任务重新入队 |

### 8.2 删除的命令

| 命令 | 原因 |
|------|------|
| `setup` | MCP 配置不再需要，Member 通过 CLI 直连 ZK |

### 8.3 新增的命令

```bash
# 标记任务阻塞
claude-orchestrator task-block --task-id task-0000000003 --reason "等待 PR #42 合并"

# 标记任务失败
claude-orchestrator task-fail --task-id task-0000000003 --reason "测试环境不可用"

# 重试失败任务
claude-orchestrator task-retry --task-id task-0000000003
```

## 9. 数据模型变化

### Instance

```typescript
// v0.3.0
interface Instance {
  id: string;
  name: string;
  role: "architect" | "developer" | "tester" | "general" | "leader";
  status: "idle" | "busy";  // blocked 移到 Task 级别
  current_task_id: string | null;
  connected_since: string;
}
```

role 新增 `"leader"`，表示该实例是 Leader 节点。

### Task (增强)

```typescript
// v0.3.0
interface Task {
  id: string;
  title: string;
  description: string;
  priority: 0 | 1 | 2;
  status: "pending" | "claimed" | "in_progress" | "completed" | "blocked" | "failed";
  created_by: string;
  assigned_to: string | null;
  created_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
  result: string | null;
  retry_count: number;          // 新增
  blocked_reason: string | null; // 新增
  fail_reason: string | null;    // 新增
}
```

## 10. 安全设计

| 层面 | 措施 | 说明 |
|------|------|------|
| 网络 | ZK 连接可选 TLS | 生产环境建议配置 ZK SSL |
| 身份 | Instance Name 作为标识 | 通过 `--name` 指定 |
| 授权 | 实例只能操作自己的 claimed task | `complete_task` 校验 claimed 节点归属 |
| Leader | 单 Leader (无选举) | 先启动的 Leader 占 `/leader` 节点，后来的无法启动 |
| ZooKeeper | ACL + Digest 认证 (可选) | 生产环境配置 |

## 11. 依赖变化

### 移除的依赖

| 包 | 原因 |
|----|------|
| `@modelcontextprotocol/sdk` | 弃用 MCP 协议，全部改为 CLI-native |
| `express` | 弃用 HTTP 服务 |
| `@types/express` | 弃用 Express |

### 保留的依赖

| 包 | 用途 |
|----|------|
| `commander` | CLI 命令解析 |
| `node-zookeeper-client` | ZK 客户端 |
| `zod` | 运行时 schema 校验 |
| `typescript` | 编译 |
| `vitest` | 测试 |

### 新增的依赖 (可选)

| 包 | 用途 | 备注 |
|----|------|------|
| 无 | TUI 使用 ANSI 控制字符实现 | 避免引入 `blessed`/`ink` 等重量级依赖 |

## 12. 文件结构 (v0.3.0)

```
claude-orchestrator-server/
├── package.json
├── tsconfig.json
├── docker-compose.yml
├── src/
│   ├── index.ts                    # CLI 入口 (commander)
│   ├── config.ts                   # 配置管理
│   ├── cli/
│   │   └── commands.ts             # CLI 子命令实现
│   ├── leader/
│   │   ├── index.ts                # Leader 启动入口
│   │   ├── tui.ts                  # TUI 渲染与输入处理
│   │   ├── monitor.ts              # ZK Watch 管理 (成员/任务/消息)
│   │   └── recovery.ts             # 孤儿任务回收
│   ├── member/
│   │   └── watcher.ts              # 本地消息监听 + claude -p 处理
│   ├── zk/
│   │   ├── client.ts               # ZK 连接管理
│   │   ├── paths.ts                # ZK 路径常量
│   │   └── watcher.ts              # ZK Watch 工具
│   ├── modules/
│   │   ├── registry.ts             # 实例注册表
│   │   ├── task-queue.ts           # 任务队列
│   │   ├── message-router.ts       # 消息路由
│   │   └── context-store.ts        # 共享键值存储
│   ├── models/
│   │   └── schemas.ts              # Zod schemas + 类型
│   └── utils/
│       └── output.ts               # CLI 输出格式化
├── bin/
│   └── claude-orchestrator
├── scripts/
│   ├── start-zk.sh
│   ├── start-leader.sh             # 新增: 启动 Leader
│   ├── start-member.sh             # 新增: 启动 Member
│   ├── stop-all.sh
│   └── publish.sh
├── docs/
│   ├── v0.1.0/
│   ├── v0.2.0/
│   └── v0.3.0/
│       ├── prd/
│       │   ├── README.md           # 本文档
│       │   ├── architecture.md     # 架构细节
│       │   └── zookeeper-schema.md # ZK Schema 详细定义
│       └── migration-guide.md      # v0.2.0 → v0.3.0 迁移指南
└── tests/
    ├── unit/
    └── integration/
```

### 关键变化

- **删除** `src/server.ts` — 不再有 MCP 服务端
- **新增** `src/leader/` — Leader 节点实现
- **新增** `src/member/` — Member watcher 从 `modules/message-watcher.ts` 独立出来
- **删除** `src/modules/message-watcher.ts` — 功能移到 `src/member/watcher.ts`
- **简化** `src/cli/commands.ts` — 移除 HTTP 相关的注册逻辑，全部走 ZK 直连

## 13. 实施路线

| 阶段 | 内容 | 产出 | 工期 |
|------|------|------|------|
| Phase 1 | 删除 MCP 依赖，清理 `server.ts`、Express、SSE | 代码清理 + 依赖更新 | 0.5 天 |
| Phase 2 | 实现 Leader 节点 (`src/leader/`) + ZK Watch 协调 | `leader/index.ts`, `monitor.ts`, `recovery.ts` | 1.5 天 |
| Phase 3 | 实现 Leader TUI (`src/leader/tui.ts`) | 交互式终端界面 | 1 天 |
| Phase 4 | 重构 CLI 命令，移除 HTTP 注册路径 | 纯 ZK CLI 命令 | 0.5 天 |
| Phase 5 | 增强任务状态机 (blocked/failed/retry) | `task-queue.ts` 更新 | 0.5 天 |
| Phase 6 | 独立 Member watcher，增强 `claude -p` 集成 | `member/watcher.ts` | 0.5 天 |
| Phase 7 | 集成测试 + 端到端验证 | `tests/integration/` | 0.5 天 |

总计：**5 天**

## 14. 典型工作流 (v0.3.0)

```
终端 1 (Leader):
  $ claude-orchestrator leader
  ┌─ Team: 0 members ───────────────────────────────────────────┐
  │ No members online. Waiting...                                │
  └──────────────────────────────────────────────────────────────┘
  [10:00:00] 🟢 Leader started

终端 2 (Jerry, 开发者):
  $ claude-orchestrator register --name Jerry --role developer --work-dir ~/project
  Instance registered:
    {"id":"a1b2c3...", "name":"Jerry", "role":"developer", "status":"idle"}
  Watching for messages...
  Press Ctrl+C to stop.

Leader TUI:
  [10:00:05] ✓ Jerry joined (developer)

终端 3 (Lucy, 测试):
  $ claude-orchestrator register --name Lucy --role tester --work-dir ~/project
  Instance registered...
  Watching for messages...

Leader TUI:
  [10:00:10] ✓ Lucy joined (tester)

Leader (TUI 命令):
  > task push "实现 POST /api/items" --priority 0 --assignee Jerry --desc "根据 OpenAPI 契约"
  [10:01:00] 📋 Task task-0000000001 created: 实现 POST /api/items (→Jerry)

Jerry 的 Claude Code:
  > claude-orchestrator claim-task
  Claimed task task-0000000001
    title: 实现 POST /api/items
    description: 根据 OpenAPI 契约

  > claude-orchestrator heartbeat --current-task "实现 POST /api/items"
  ok

Leader TUI:
  [10:01:30] 🔒 Jerry claimed task-0000000001
  Team: Jerry status → busy

Jerry 在 Claude Code 中工作...

  > claude-orchestrator request-help --question "DB 迁移策略有歧义，请确认"
  Sent to 1 instance(s)

Lucy 的终端 (watcher 自动处理):
  [10:15:00] 📨 Message from Jerry (help):
     DB 迁移策略有歧义，请确认
  🔄 Processing with claude -p...
  ✅ Response: 建议用 alembic --sql 模式生成审计 SQL

  Lucy 的 Claude Code 回复:
  > claude-orchestrator send-message --to-name Jerry --content "用 alembic --sql 模式"

Jerry 的终端 (watcher 自动处理):
  [10:15:30] 📨 Message from Lucy (direct):
     用 alembic --sql 模式
  🔄 Processing with claude -p...

  Jerry 完成任务:
  > claude-orchestrator complete-task --task-id task-0000000001 --result "PR #42"
  Task task-0000000001 completed.

Leader TUI:
  [10:30:00] ✅ Jerry completed task-0000000001
  Team: Jerry status → idle
```

## 15. 与 v0.2.0 的关键差异总结

| 维度 | v0.2.0 | v0.3.0 |
|------|--------|--------|
| 架构模式 | 中心化 MCP Server | Leader + P2P CLI-native |
| 通信协议 | Streamable HTTP (SSE) + JSON-RPC | ZK 原生协议 (TCP) |
| 服务启动 | `claude-orchestrator server` | `claude-orchestrator leader` |
| 实例注册 | 通过 MCP 工具或 HTTP REST | CLI 直连 ZK |
| 消息推送 | MCP Resource Subscription | ZK Watch → 本地 `claude -p` |
| MCP 依赖 | `@modelcontextprotocol/sdk` | 无 |
| HTTP 依赖 | Express | 无 |
| 配置 | `.claude/mcp.json` | 仅 `~/.claude-orchestrator/config.json` |
| 可视化 | 无 (依赖 MCP client 日志) | Leader TUI 实时面板 |
| 任务状态 | 3 种 | 6 种 |
| 任务恢复 | MCP Server 负责 | Leader 负责 |
| 扩展性 | MCP Server 单点 | 任意节点直连 ZK |
