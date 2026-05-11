# Claude Orchestrator v0.3.0 — Leader-based CLI-native 协同编排 PRD

## 1. 概述

v0.3.0 是一次根本性的架构变革：**从中心化 MCP Server 模型转向 Leader-Worker CLI-native 模型**。

核心变化：

- **弃用 MCP 协议**：移除 `@modelcontextprotocol/sdk`、Express HTTP 服务、SSE 传输层。所有交互通过 CLI + ZooKeeper 直连完成。
- **Leader-Worker 身份体系**：`claude-orchestrator leader` 启动 Leader 协调节点（TUI），`claude-orchestrator register --work-dir` 启动 Worker 执行节点。两种身份明确分工。
- **Agent 模板系统**：Leader 使用 `.claude-orchestrator/agents/leader.md` 模板编排任务指令，Worker 使用 `worker.md` 模板格式化消息，两者均通过 Claude 处理消息内容。
- **可配置执行命令**：通过 `command` 配置项指定 Claude CLI（默认 `claude --dangerously-skip-permissions -v`），消息处理统一通过 `$COMMAND -p "$MESSAGE" | tee $CACHE_DIR/{key}.log` 执行，兼顾终端输出和文件持久化。
- **共享 Cache 目录**：`$CACHE_DIR` 作为 Leader 和 Worker 共享的日志/结果目录（默认 `~/.claude-orchestrator/sessions/{leader_instance_id}/`），Worker 通过读取该目录下的 `.log` 文件获取 Leader 的详细指令和上下文。
- **`setup` 命令增强**：保留 `setup` 命令，通过 `--leader` 区分 Leader/Worker 环境初始化，自动写入内置 Agent 模板到项目目录。

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
  │ Leader  │    │ Worker A  │  │ Worker B  │  │ CLI (ad-hoc)  │
  │ (TUI)   │    │           │  │           │  │               │
  │         │    │ watcher + │  │ watcher + │  │  push_task     │
  │ 监控全队 │    │ claude -p │  │ claude -p │  │  send_message  │
  │ 任务分配 │    │ 模板消息   │  │ 模板消息   │  │  list_tasks   │
  │ 模板指令 │    │           │  │           │  │  ...          │
  └────┬────┘    └─────┬─────┘  └─────┬─────┘  └───────────────┘
       │               │              │
       └───────────────┴──────────────┘
                       │
              ┌────────┴────────┐
              │  $CACHE_DIR     │
              │  (共享文件系统)  │
              │  sessions/{id}/ │
              │  ├── task-xx.log│
              │  └── help-xx.log│
              └─────────────────┘
```

### 身份体系

v0.3.0 严格区分两种身份：

| 身份 | Role | 注册方式 | 启动命令 | 能力 |
|------|------|---------|---------|------|
| **Leader** | `leader` | 自动 (启动时创建 `/leader` 节点) | `claude-orchestrator leader` | TUI 监控、任务分派、孤儿回收、模板指令下发 |
| **Worker** | `developer` / `tester` / `architect` / `general` | 显式注册 (`register --work-dir`) | `claude-orchestrator register --work-dir <dir>` | 认领任务、消息处理、本地 `claude -p` 执行 |

Leader 和 Worker 都通过 `setup` 命令初始化各自的工作环境，`setup --leader` 生成 Leader 配置和 Agent 模板。

### 核心概念

| 概念 | 说明 | 进程模型 |
|------|------|---------|
| **Leader** | 团队协调者，运行 TUI，监控全局状态，使用 `leader.md` 模板生成和发送任务指令 | 长期运行 (`claude-orchestrator leader`) |
| **Worker** | 工作实例，注册后监听消息，通过 `$COMMAND -p` 处理消息，使用 `worker.md` 模板发送消息 | 长期运行 (`claude-orchestrator register --work-dir`) |
| **CLI** | 一次性命令，直接操作 ZK | 短期运行 (如 `push-task`, `send-message`) |

### 核心模块

| 模块 | 职责 | 运行位置 |
|------|------|---------|
| Instance Registry | 实例注册、心跳、存活检测 | 所有节点直连 ZK |
| Task Queue | 任务入队、认领、完成、超时恢复 | Leader 监控 + Worker 认领 |
| Message Router | 点对点消息、广播、求助，模板渲染 | ZK Watch + 本地 `$COMMAND -p` |
| Context Store | 全局键值存储 | 所有节点直连 ZK |
| Recovery Handler | 孤儿任务回收、实例断线处理 | Leader 专属 |
| Agent Templates | Worker/Leader 消息模板渲染 | `setup` 写入，运行时读取 |
| Cache Manager | 共享日志/结果目录管理 | Leader 写入，Worker 读取 |

## 3. Leader 节点设计

### 3.1 启动

```bash
# 推荐先初始化 Leader 环境
claude-orchestrator setup --leader --name Tom

# 启动 Leader
claude-orchestrator leader [--name <name>]
```

启动后：
1. 连接 ZooKeeper，创建 `/leader` EPHEMERAL 节点声明领导权
2. 创建自身 Instance 节点 (`role=leader`)，获得 `instance_id`
3. 初始化 CACHE_DIR: `~/.claude-orchestrator/sessions/{instance_id}/`
4. 加载 `.claude-orchestrator/agents/leader.md` 模板
5. 初始化 TUI 界面
6. 注册所有 ZK Watch 监听团队状态变化
7. 进入事件循环，等待 TUI 输入和 ZK 事件

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
Commands: msg, status, exit
> msg Jerry "请实现 POST /api/items 接口，完成后告知结果路径"
```

### 3.4 Leader TUI 命令

Leader TUI 仅提供 3 个命令，所有其他操作通过外部 CLI 完成：

| 命令 | 说明 | 示例 |
|------|------|------|
| `msg <worker> <content>` | 向 Worker 发送消息（使用 leader.md 模板渲染后发送） | `msg Jerry "实现 POST /api/items 接口，详细任务文档见 ./tasks/task-xxx.md"` |
| `status` | 刷新团队状态显示 | `status` |
| `exit` / `quit` | 退出 Leader | `exit` |

**设计原则**：TUI 聚焦于团队监控和消息发送。任务创建（`push-task`）、任务查看（`list-tasks`）、上下文管理（`set-context`/`get-context`）等操作通过外部 CLI 命令完成，保持 TUI 简洁。

### 3.5 Leader 消息发送 (leader.md 模板)

Leader 发送任务指令时，使用 `leader.md` 模板 + Claude 处理：

```
Leader 发送 task 指令:
  1. 读取 .claude-orchestrator/agents/leader.md 模板
  2. 填充变量:
     - {{leader_name}}: Leader 名称
     - {{task_id}}: 任务 ID
     - {{task_title}}: 任务标题
     - {{task_description}}: 任务描述 (含预期输出、上下文)
     - {{created_at}}: 创建时间
     - {{result_path}}: $CACHE_DIR/{uniqueKey}.log
  3. 生成唯一 key (如 task-{task_id}-{timestamp})
  4. 通过 $COMMAND -p "处理以下任务指令模板..." | tee $CACHE_DIR/{key}.log
     执行 Claude 处理并同时输出到终端和日志文件
  5. 将渲染后的消息 + log 路径写入 ZK /messages/{worker_id}/msg-{seq}
  
Worker 收到消息后:
  1. watcher 触发 $COMMAND -p "$MESSAGE" | tee $CACHE_DIR/{key}_result.log
  2. 从消息中读取 result_path，可获取 Leader 的详细上下文
  3. 执行任务，标记完成
```

## 4. Worker 设计

### 4.1 注册与启动

```bash
# 推荐先初始化 Worker 环境
claude-orchestrator setup --name Jerry --role developer

# 启动 Worker
claude-orchestrator register \
  --name Jerry \
  --role developer \
  --work-dir /path/to/project
```

启动流程：

```
1. 连接 ZooKeeper
2. 创建 /instances/{uuid} EPHEMERAL 节点 (role=developer/tester/architect/general)
3. 保存 instance_id 到 ~/.claude-orchestrator/config.json
4. 创建 /messages/{uuid} 目录
5. 确保 CACHE_DIR (~/.claude-orchestrator/sessions/{leader_instance_id}/) 可访问
6. 加载 .claude-orchestrator/agents/worker.md 模板
7. 启动消息监听循环:
   a. 在 /messages/{uuid} 上设置 ChildWatch
   b. Watch 触发 → 读取新消息
   c. 对每条未读消息:
      - 打印到终端
      - 生成唯一 key (如 msg-{msg_id}-{timestamp})
      - spawn $COMMAND -p "$MESSAGE" | tee $CACHE_DIR/{key}.log
        注意: $COMMAND 来自 config.command 配置
      - 等待执行完成
      - 标记消息已读
   d. 重建 Watch，继续监听
8. 阻塞等待 SIGINT
9. 清理: 删除 /instances/{uuid}, 关闭 ZK 连接
```

### 4.2 Worker 能力

Worker 通过以下方式与团队交互：

1. **自动消息处理**：`register --work-dir` 启动的 watcher 自动监听并处理收到的消息，执行 `$COMMAND -p | tee` 双写终端和文件
2. **模板消息发送**：Worker 发送消息时，使用 `worker.md` 模板填充变量后发送
3. **显式 CLI 操作**：Worker 的 Claude Code 实例可以调用 CLI 命令：
   - `claim-task` — 认领下一个待办任务
   - `complete-task` — 完成任务
   - `send-message` — 发消息给其他成员（模板渲染）
   - `request-help` — 广播求助（模板渲染）
   - `poll-messages` — 检查消息
   - `set-context` / `get-context` — 共享上下文

### 4.3 Worker 消息发送 (worker.md 模板)

Worker 发送消息时，使用 `worker.md` 模板：

```
Worker 发送消息:
  1. 读取 .claude-orchestrator/agents/worker.md 模板
  2. 填充变量:
     - {{name}}: Worker 名称
     - {{role}}: Worker 角色
     - {{time}}: 发送时间
     - {{result_path}}: $CACHE_DIR/{key}.log (如适用)
     - {{content}}: 消息正文
  3. 通过 $COMMAND -p "按照模板格式化以下消息..." | tee $CACHE_DIR/{key}.log
     或直接渲染模板(简单消息可跳过 Claude 处理)
  4. 将渲染后的消息写入 ZK /messages/{target_id}/msg-{seq}
```

### 4.4 Worker 心跳

Worker 本地 watcher 通过 ZK session keep-alive 维持临时节点。可选地更新 `current_task_id`：

```bash
claude-orchestrator heartbeat --current-task "实现 POST /api/items"
```

## 5. Agent 模板系统

### 5.1 模板文件

`setup` 命令自动在项目目录下生成模板文件：

```
.claude-orchestrator/
├── agents/
│   ├── leader.md          # Leader 任务指令模板
│   └── worker.md          # Worker 消息模板
└── config.json            # 项目级实例配置
```

### 5.2 leader.md 模板

Leader 发送消息时，模板指示如何将任务文档路径以相对路径提供给 Worker：

```markdown
You are the team leader coordinating workers. Send a clear task assignment message to a worker.

## Identity
- Leader: {{leader_name}}
- Sent at: {{created_at}}

## Task Assignment
{{content}}

## Task Document
A detailed task specification is available at the relative path below.
The worker should read this file for complete instructions:
{{task_doc_path}}

## Cache Path
Execution logs are written to the shared cache directory:
{{result_path}}

After sending this message, the worker will process the task and respond with
the result path. Wait for their response before proceeding to the next step.
```

### 5.3 worker.md 模板

Worker 完成工作后，仅需告知 Leader 结果路径并指示进入下一步：

```markdown
You are a worker in a multi-agent team. Report your completion status to the leader.

## Identity
- Name: {{name}}
- Role: {{role}}
- Time: {{time}}

## Completion Report
{{content}}

## Result Path
The execution result and logs are available at:
{{result_path}}

## Next Step
The task has been completed. Leader, please review the result at the path above
and assign the next task.
```

### 5.4 模板变量

| 变量 | 来源 | 适用模板 | 说明 |
|------|------|---------|------|
| `{{leader_name}}` | config.name | leader.md | Leader 显示名称 |
| `{{name}}` | config.name | worker.md | Worker 显示名称 |
| `{{role}}` | config.role | worker.md | Worker 角色 |
| `{{created_at}}` / `{{time}}` | 系统生成 | 两者 | ISO 时间戳 |
| `{{content}}` | 用户输入 | 两者 | 消息正文 |
| `{{task_doc_path}}` | 系统生成 | leader.md | 任务文档的相对路径（如 `./tasks/task-0000000001.md`） |
| `{{result_path}}` | 系统生成 | 两者 | `$CACHE_DIR/{uniqueKey}.log` 的相对路径 |

## 6. Command 配置与执行

### 6.1 配置项

在 `~/.claude-orchestrator/config.json` 中增加 `command` 字段：

```json
{
  "instance_id": "a1b2c3d4...",
  "name": "Jerry",
  "role": "developer",
  "command": "claude --dangerously-skip-permissions -v",
  "cache_dir": "~/.claude-orchestrator/sessions",
  "port": "3100",
  "host": "127.0.0.1"
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `command` | `claude --dangerously-skip-permissions -v` | Claude CLI 基础命令，`-v` 启用详细输出 |
| `cache_dir` | `~/.claude-orchestrator/sessions` | 共享日志/结果目录根路径 |

### 6.2 执行模式

所有消息处理统一使用以下模式：

```bash
$COMMAND -p "$MESSAGE" | tee $CACHE_DIR/${uniqueKey}.log
```

- `$COMMAND`: 来自 `config.command` 配置
- `$MESSAGE`: 消息内容（模板渲染后或原始消息）
- `$CACHE_DIR`: 来自 `config.cache_dir` / `{leader_instance_id}`
- `uniqueKey`: 每次执行生成的唯一标识（如 `task-{task_id}-{timestamp}`）

此模式确保：
1. **终端输出**：实时查看 Claude 处理过程
2. **文件持久化**：日志完整写入 `$CACHE_DIR/{key}.log`，供其他节点读取

### 6.3 uniqueKey 生成规则

```
uniqueKey = {prefix}-{identifier}-{timestamp}

prefix:
  - task-{task_id}  → Leader 下发任务时
  - help-{msg_id}   → Worker 处理求助消息时
  - msg-{msg_id}    → Worker 处理普通消息时
  - reply-{msg_id}  → Worker 发送回复时

identifier: task_id 或 msg_id
timestamp: ISO 字符串简化版 (如 20260511T103000)
```

## 7. CACHE_DIR 共享目录

### 7.1 目录结构

```
~/.claude-orchestrator/sessions/        ← config.cache_dir 默认值
├── {leader_instance_id}/               ← Leader 实例 ID
│   ├── task-0000000001-20260511T103000.log
│   ├── task-0000000001-20260511T110000_result.log
│   ├── help-msg-042-20260511T101500.log
│   └── msg-msg-044-20260511T103500.log
├── {leader_instance_id_2}/             ← 另一个 Leader (不同 session)
│   └── ...
```

### 7.2 配置要求

- Leader 和所有 Worker 必须配置相同的 `cache_dir` 路径
- 默认路径: `~/.claude-orchestrator/sessions`
- 支持绝对路径和环境变量展开（如 `$HOME/project/sessions`）
- 在共享文件系统环境下（NFS / 同一主机），Worker 可直接读取 Leader 的 `.log` 文件
- Leader 启动时创建 `$CACHE_DIR/{leader_instance_id}/` 子目录
- Worker 注册时验证 `$CACHE_DIR/{leader_instance_id}/` 可访问

### 7.3 生命周期

- `.log` 文件由 `tee` 在每次 `$COMMAND -p` 执行时自动创建
- Leader 可配置日志保留策略（默认保留最近 50 条，或按 TTL 7 天自动清理）
- 任务完成后，关联的日志文件可选保留或删除

## 8. setup 命令设计

### 8.1 Leader 环境初始化

```bash
claude-orchestrator setup --leader --name Tom
```

执行操作：
1. 在项目根目录创建 `.claude-orchestrator/` 目录
2. 写入 `agents/leader.md` 和 `agents/worker.md` 模板
3. 在 `.claude-orchestrator/config.json` 写入: `{"name": "Tom", "role": "leader"}`
4. 在 `~/.claude-orchestrator/config.json` 写入全局配置：
   ```json
   {
     "command": "claude --dangerously-skip-permissions -v",
     "cache_dir": "~/.claude-orchestrator/sessions"
   }
   ```

### 8.2 Worker 环境初始化

```bash
claude-orchestrator setup --name Jerry --role developer
```

执行操作：
1. 在项目根目录创建 `.claude-orchestrator/` 目录
2. 写入 `agents/leader.md` 和 `agents/worker.md` 模板
3. 在 `.claude-orchestrator/config.json` 写入: `{"name": "Jerry", "role": "developer"}`
4. 在 `~/.claude-orchestrator/config.json` 写入全局配置（同 Leader）

### 8.3 setup 参数

| 参数 | 必需 | 说明 |
|------|------|------|
| `--leader` | 否 | 指定为 Leader 环境（与 `--name` / `--role` 互斥用于身份） |
| `--name <name>` | 是 | 实例显示名称 |
| `--role <role>` | 否 | 实例角色，Leader 自动设为 `leader`，Worker 默认 `general` |
| `--cache-dir <path>` | 否 | 自定义共享缓存目录（默认 `~/.claude-orchestrator/sessions`） |
| `--command <cmd>` | 否 | 自定义 Claude CLI 命令（默认 `claude --dangerously-skip-permissions -v`） |
| `--global` | 否 | 仅写入全局配置 `~/.claude-orchestrator/config.json`，不创建项目目录 |


## 9. 通信流程

### 9.1 Leader 分配任务给 Worker (模板指令)

```
Leader (TUI)                ZK                         Worker (Jerry)
    │                         │                              │
    │── task push ───────────>│                              │
    │   /tasks/pending/       │                              │
    │   task-0000000003       │                              │
    │   assignee=Jerry        │                              │
    │                         │                              │
    │   读取 leader.md 模板    │                              │
    │   填充变量 (task_id,     │                              │
    │   description,          │                              │
    │   result_path)          │                              │
    │                         │                              │
    │   $COMMAND -p           │                              │
    │   "模板内容..." | tee    │                              │
    │   $CACHE_DIR/task-003   │                              │
    │   -xxx.log              │                              │
    │                         │                              │
    │── send_message ────────>│                              │
    │   to=Jerry              │── /messages/Jerry/msg-042    │
    │   content=模板渲染结果    │   (含 result_path 引用)      │
    │   result_path=...       │                              │
    │                         │                              │
    │                         │<── claim_task ───────────────│
    │                         │── /tasks/claimed/            │
    │                         │   Jerry-task-0000000003      │
    │                         │   [EPHEMERAL]                │
    │                         │── delete /pending/task-...   │
    │                         │                              │
    │<── ZK Watch 触发 ──────│                              │
    │   (TUI: Jerry busy)     │                              │
    │                         │                              │
    │                         │   Jerry watcher 收到消息:     │
    │                         │   $COMMAND -p "msg内容" |    │
    │                         │   tee $CACHE_DIR/task-003    │
    │                         │   -xxx_result.log            │
    │                         │   (可从 result_path 读取      │
    │                         │    Leader 的详细指令)         │
    │                         │                              │
    │                         │<── complete_task ────────────│
    │                         │── /tasks/completed/task-...  │
    │                         │── delete /claimed/...        │
    │                         │                              │
    │<── ZK Watch 触发 ──────│                              │
    │   (TUI: Jerry idle)     │                              │
```

### 9.2 Worker 求助 → 其他 Worker 响应 (模板消息)

```
Worker A (Jerry)            ZK                         Worker B (Tom)
    │                         │                              │
    │   读取 worker.md 模板    │                              │
    │   填充 {{name}},        │                              │
    │   {{role}}, {{time}},   │                              │
    │   {{content}}           │                              │
    │                         │                              │
    │── request_help ────────>│                              │
    │   (模板渲染后的消息)      │── /messages/Tom/msg-042      │
    │                         │── /messages/Lucy/msg-043     │
    │                         │   (含 worker 模板变量)        │
    │                         │                              │
    │                         │<── ZK Watch 触发 ─────────────│
    │                         │   Tom watcher:               │
    │                         │   $COMMAND -p "msg内容" |    │
    │                         │   tee $CACHE_DIR/            │
    │                         │   help-msg-042-xxx.log       │
    │                         │                              │
    │                         │   Tom 的 Claude 分析消息      │
    │                         │   并生成回复...               │
    │                         │                              │
    │                         │   读取 worker.md 模板         │
    │                         │   填充回复变量                │
    │                         │                              │
    │                         │── send_message ─────────────>│
    │                         │   to=Jerry                    │
    │                         │── /messages/Jerry/msg-044     │
    │                         │   (模板渲染的回复 +           │
    │                         │    result_path 引用)          │
    │                         │                              │
    │<── ZK Watch 触发 ──────│                              │
    │   Jerry watcher:        │                              │
    │   $COMMAND -p "回复" |  │                              │
    │   tee $CACHE_DIR/       │                              │
    │   reply-msg-044-xxx.log │                              │
```

### 9.3 Leader 断开 → 自动恢复

```
Leader 进程崩溃
    │
    ├── /leader 临时节点自动删除 (ZK session timeout)
    │
    ├── Worker 不受影响 — 各自直连 ZK，继续工作
    │
    ├── 已认领的任务不受影响 — claimed 节点是各 Worker 创建的
    │
    └── 新 Leader 启动:
        1. 扫描 /instances 重建团队视图
        2. 扫描 /tasks 重建任务视图
        3. 发现孤儿 claimed 任务 (Worker 已离线但 claimed 节点因 ZK session 残留)
        4. 将孤儿任务移回 /tasks/pending
        5. 创建新的 CACHE_DIR/{new_leader_instance_id}/
        6. 开始正常监控
```

### 9.4 Worker 断开 → 任务回收

```
Worker 进程崩溃 / 网络断开
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
    └── 其他 Worker 不受影响
```

## 10. 任务生命周期 (增强版)

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

## 11. ZooKeeper 节点树 (v0.3.0)

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

## 12. CLI 命令变化

### 12.1 命令对照表

| v0.2.0 命令 | v0.3.0 命令 | 变化说明 |
|------------|------------|---------|
| `server` | `leader` | **重命名**，从启动 MCP 服务改为启动 Leader TUI |
| `setup` | `setup` | **增强**，增加 `--leader` 区分 Leader/Worker 环境，写入 Agent 模板 |
| `register` | `register` | 保留，增强 `--work-dir` 模式，使用 `$COMMAND` 和 `worker.md` 模板 |
| `status` | `status` | 保留 |
| `heartbeat` | `heartbeat` | 保留，增加 `--status blocked\|in_progress` |
| `list-instances` | `list-instances` | 保留 |
| `push-task` | `push-task` | 保留 |
| `claim-task` | `claim-task` | 保留 |
| `complete-task` | `complete-task` | 保留，`--result` 可选 |
| `list-tasks` | `list-tasks` | 保留，增加 `--status blocked\|failed` |
| `send-message` | `send-message` | 保留，支持模板渲染 |
| `poll-messages` | `poll-messages` | 保留 |
| `wait-for-message` | `wait-for-message` | 保留 |
| `dismiss-message` | `dismiss-message` | 保留 |
| `request-help` | `request-help` | 保留，使用 `worker.md` 模板 |
| `set-context` | `set-context` | 保留 |
| `get-context` | `get-context` | 保留 |
| `delete-context` | `delete-context` | 保留 |
| `list-context-keys` | `list-context-keys` | 保留 |
| `watch-context` | `watch-context` | 保留 |
| `watch-tasks` | `watch-tasks` | 保留 |
| `unregister` | `unregister` | 保留 |
| `config` | `config` | 保留，增加 `command` 和 `cache_dir` 字段 |
| — | **新增** `leader` | 启动 Leader 节点 (TUI) |
| — | **新增** `task-block` | 标记任务为 blocked |
| — | **新增** `task-fail` | 标记任务为 failed |
| — | **新增** `task-retry` | 将 failed 任务重新入队 |

### 12.2 新增的命令

```bash
# 标记任务阻塞
claude-orchestrator task-block --task-id task-0000000003 --reason "等待 PR #42 合并"

# 标记任务失败
claude-orchestrator task-fail --task-id task-0000000003 --reason "测试环境不可用"

# 重试失败任务
claude-orchestrator task-retry --task-id task-0000000003
```

### 12.3 setup 命令详情

详见第 8 节。

```bash
# Leader 环境初始化
claude-orchestrator setup --leader --name Tom

# Worker 环境初始化
claude-orchestrator setup --name Jerry --role developer

# 自定义 cache_dir 和 command
claude-orchestrator setup --leader --name Tom \
  --cache-dir /shared/sessions \
  --command "claude --dangerously-skip-permissions -v"
```

## 13. 数据模型变化

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

## 14. 安全设计

| 层面 | 措施 | 说明 |
|------|------|------|
| 网络 | ZK 连接可选 TLS | 生产环境建议配置 ZK SSL |
| 身份 | Instance Name 作为标识 | 通过 `--name` 指定 |
| 授权 | 实例只能操作自己的 claimed task | `complete_task` 校验 claimed 节点归属 |
| Leader | 单 Leader (无选举) | 先启动的 Leader 占 `/leader` 节点，后来的无法启动 |
| ZooKeeper | ACL + Digest 认证 (可选) | 生产环境配置 |

## 15. 依赖变化

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

## 16. 文件结构 (v0.3.0)

```
claude-orchestrator-server/            ← npm 包根目录
├── package.json
├── tsconfig.json
├── docker-compose.yml
├── src/
│   ├── index.ts                       # CLI 入口 (commander)
│   ├── config.ts                      # 配置管理 (含 command/cache_dir)
│   ├── cli/
│   │   └── commands.ts                # CLI 子命令实现
│   ├── leader/
│   │   ├── index.ts                   # Leader 启动入口
│   │   ├── tui.ts                     # TUI 渲染与输入处理
│   │   ├── monitor.ts                 # ZK Watch 管理 (Worker/任务/消息)
│   │   └── recovery.ts                # 孤儿任务回收
│   ├── worker/
│   │   └── watcher.ts                 # 本地消息监听 + $COMMAND -p | tee 处理
│   ├── templates/
│   │   ├── leader.md                  # 内置 Leader Agent 模板
│   │   └── worker.md                  # 内置 Worker Agent 模板
│   ├── zk/
│   │   ├── client.ts                  # ZK 连接管理
│   │   ├── paths.ts                   # ZK 路径常量
│   │   └── watcher.ts                 # ZK Watch 工具
│   ├── modules/
│   │   ├── registry.ts                # 实例注册表
│   │   ├── task-queue.ts              # 任务队列
│   │   ├── message-router.ts          # 消息路由 + 模板渲染
│   │   └── context-store.ts           # 共享键值存储
│   ├── models/
│   │   └── schemas.ts                 # Zod schemas + 类型
│   └── utils/
│       └── output.ts                  # CLI 输出格式化
├── bin/
│   └── claude-orchestrator
├── scripts/
│   ├── start-zk.sh
│   ├── start-leader.sh                # 新增: 启动 Leader
│   ├── start-worker.sh                # 新增: 启动 Worker
│   ├── stop-all.sh
│   └── publish.sh
├── docs/                              # 本文档
├── tests/
│    ├── unit/
│    └── integration/

项目目录 (setup 命令生成):
├── .claude-orchestrator/              ← setup 命令创建
│   ├── agents/
│   │   ├── leader.md                  ← Leader 任务指令模板
│   │   └── worker.md                  ← Worker 消息模板
│   └── config.json                    ← 项目级实例配置

全局目录:
├── ~/.claude-orchestrator/
│   ├── config.json                    ← 全局配置 (command, cache_dir, instance_id)
│   └── sessions/                      ← 默认 CACHE_DIR
│       └── {leader_instance_id}/
│           ├── task-xxx-yyy.log
│           └── help-xxx-yyy.log
```

### 关键变化

- **删除** `src/server.ts` — 不再有 MCP 服务端
- **删除** `src/modules/message-watcher.ts` — 功能移到 `src/worker/watcher.ts`
- **新增** `src/leader/` — Leader 节点实现
- **新增** `src/worker/` — Worker watcher 实现
- **新增** `src/templates/` — 内置 Agent 模板源文件（setup 命令复制到项目目录）
- **增强** `src/modules/message-router.ts` — 增加模板渲染功能
- **增强** `src/config.ts` — 增加 `command` 和 `cache_dir` 配置字段
- **简化** `src/cli/commands.ts` — 移除 HTTP 相关的注册逻辑，全部走 ZK 直连

## 17. 实施路线

| 阶段 | 内容 | 产出 | 工期 |
|------|------|------|------|
| Phase 1 | 删除 MCP 依赖，清理 `server.ts`、Express、SSE | 代码清理 + 依赖更新 | 0.5 天 |
| Phase 2 | 增强 `config.ts` (command/cache_dir)，实现 `setup` 命令 + Agent 模板写入 | `config.ts`, `setup` 命令, `src/templates/` | 0.5 天 |
| Phase 3 | 实现 Leader 节点 (`src/leader/`) + ZK Watch 协调 | `leader/index.ts`, `monitor.ts`, `recovery.ts` | 1.5 天 |
| Phase 4 | 实现 Leader TUI (`src/leader/tui.ts`) + 模板消息下发 | 交互式终端界面 + `leader.md` 模板渲染 | 1 天 |
| Phase 5 | 重构 Worker watcher (`src/worker/watcher.ts`)，集成 `$COMMAND -p \| tee` 执行模式 | `worker/watcher.ts`, `worker.md` 模板 | 0.5 天 |
| Phase 6 | 增强任务状态机 (blocked/failed/retry) + 消息模板渲染 | `task-queue.ts`, `message-router.ts` 更新 | 0.5 天 |
| Phase 7 | 集成测试 + 端到端验证 (Leader + Worker 完整流程) | `tests/integration/` | 0.5 天 |

## 18. 典型工作流 (v0.3.0)

```
终端 1 (Leader):
  $ claude-orchestrator setup --leader --name Tom
  $ claude-orchestrator leader
  ┌─ Team: 0 workers ──────────────────────────────────────────┐
  │ No workers online. Waiting...                               │
  └─────────────────────────────────────────────────────────────┘
  [10:00:00] 🟢 Leader started (instance: a1b2c3...)

终端 2 (Jerry, 开发者):
  $ claude-orchestrator setup --name Jerry --role developer
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
  > msg Jerry "请实现 POST /api/items 接口，参考 OpenAPI 契约。完成后将结果路径发给我。"
  [10:01:00] 📨 Leader → Jerry (direct)
  (Leader 使用 leader.md 模板渲染消息，task doc 以相对路径提供给 Worker)

Jerry 的终端 (watcher 自动处理):
  [10:01:05] 📨 Message from Tom (Leader, direct):
     请实现 POST /api/items 接口...
     Task doc: ./tasks/task-0000000001.md
  🔄 Processing with claude...
  ✅ Response: 已完成实现，PR #42

  Jerry 的 Claude Code 回复 (worker.md 模板):
  > claude-orchestrator send-message --to-name Tom --content \
      "任务 task-0000000001 已完成。结果路径: sessions/a1b2c3.../task-0000000001-xxx_result.log。请指示下一步。"

Leader TUI:
  [10:30:00] 📨 Jerry → Leader: 任务 task-0000000001 已完成...
  (Leader 读取结果路径，评估完成情况)
  > status
  ┌─ Team: 2 workers ─────────────────────────────────────────┐
  │ Name   Role       Status   Current Task                    │
  │ Jerry  developer idle     -                                │
  │ Lucy   tester     idle     -                                │
  └────────────────────────────────────────────────────────────┘
  > exit
```

## 19. 与 v0.2.0 的关键差异总结

| 维度 | v0.2.0 | v0.3.0 |
|------|--------|--------|
| 架构模式 | 中心化 MCP Server | Leader-Worker CLI-native |
| 身份体系 | 无区分（统一 instance） | Leader / Worker 严格区分 |
| 通信协议 | Streamable HTTP (SSE) + JSON-RPC | ZK 原生协议 (TCP) |
| 服务启动 | `claude-orchestrator server` | `claude-orchestrator leader` (TUI, 3 命令: msg/status/exit) |
| 实例注册 | 通过 MCP 工具或 HTTP REST | CLI 直连 ZK + `setup` 初始化环境 |
| 消息推送 | MCP Resource Subscription | ZK Watch → `$COMMAND -p "$MSG" \| tee $CACHE_DIR/{key}.log` |
| 消息模板 | 无 | `leader.md` (任务文档 + 相对路径) / `worker.md` (结果路径 + 下一步指示) |
| MCP 依赖 | `@modelcontextprotocol/sdk` | 无 |
| HTTP 依赖 | Express | 无 |
| 配置 | `.claude/mcp.json` | `~/.claude-orchestrator/config.json` (含 command, cache_dir) |
| 可视化 | 无 (依赖 MCP client 日志) | Leader TUI 实时面板 (仅 msg/status/exit) |
| 任务状态 | 3 种 | 6 种 |
| 任务恢复 | MCP Server 负责 | Leader 负责 |
| 共享存储 | 无 | CACHE_DIR 共享日志/结果目录 |
| 扩展性 | MCP Server 单点 | 任意节点直连 ZK |
