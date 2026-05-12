# Claude Orchestrator v0.3.0 — Leader-based CLI-native 协同编排

## 1. 概述

v0.3.0 采用 **Leader-Worker CLI-native** 架构，通过 ZooKeeper 直连实现分布式任务编排。

核心特征：

- **Leader-Worker 身份体系**：`claude-orchestrator leader` 启动 Leader 协调节点（TUI），`claude-orchestrator register` 启动 Worker 执行节点
- **Agent 模板系统**：Leader 使用 `leader-decompose.md` / `leader-decide.md` 模板，Worker 使用五个 link 模板（`worker-plan.md` / `worker-build.md` / `worker-verify.md` / `worker-review.md` / `worker-accept.md`）
- **可配置执行命令**：通过 `command` 配置项指定 Claude CLI（默认 `claude --dangerously-skip-permissions -v`），消息处理统一通过 `$COMMAND -p "$MESSAGE" | tee $CACHE_DIR/{key}.log` 执行
- **共享 Cache 目录**：`$CACHE_DIR` 作为 Leader 和 Worker 共享的日志/结果目录（默认 `~/.claude-orchestrator/sessions/{leader_instance_id}/`）
- **CLI-native**：所有交互通过 CLI + ZooKeeper 直连完成，不依赖 MCP 协议或 HTTP 服务

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                          ZooKeeper                                   │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │/leader   │  │/instances│  │/tasks    │  │/messages │ │
│  │[EPHEMERAL]│  │[EPHEMERAL]│  │[SEQ+EPH] │  │[SEQ]     │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └───────┘ │
└──────┬───────────────┬──────────────┬──────────────┬─────────────────┘
       │               │              │              │
  ┌────┴────┐    ┌─────┴─────┐  ┌─────┴─────┐  ┌───┴───────────┐
  │ Leader  │    │ Worker A  │  │ Worker B  │  │ CLI (ad-hoc)  │
  │         │    │           │  │           │  │               │
  │ TUI     │    │ watcher + │  │ watcher + │  │  push_task    │
  │ (read-  │    │ $COMMAND  │  │ $COMMAND  │  │  send_message │
  │  only)  │    │ -p | tee  │  │ -p | tee  │  │    → Leader   │
  │         │    │           │  │           │  │    → Worker   │
  │ watcher │    │ per-link  │  │ per-link  │  │  ...          │
  │ +       │    │ template  │  │ template  │  │               │
  │ $COMMAND│    │           │  │           │  │               │
  │ -p |tee │    │           │  │           │  │               │
  └────┬────┘    └─────┬─────┘  └─────┬─────┘  └───────────────┘
       │               │              │
       └───────────────┴──────────────┘
                       │
              ┌────────┴────────┐
              │  $CACHE_DIR     │
              │  (共享文件系统)  │
              │  sessions/{id}/ │
              │  ├── tasks/*.md │
              │  └── *.log      │
              └─────────────────┘
```

### 身份体系

| 身份 | Role | 注册方式 | 启动命令 | 能力 |
|------|------|---------|---------|------|
| **Leader** | `leader` | 自动 (启动时创建 `/leader` 节点) | `claude-orchestrator leader` | TUI 只读监控、watcher 接收 Worker 消息、孤儿回收 |
| **Worker** | `planner` / `builder` / `verifier` / `reviewer` / `accepter` | 显式注册 (`register`) | `claude-orchestrator register` | 认领任务、消息处理、本地 `$COMMAND -p` 执行 |

### 核心概念

| 概念 | 说明 | 进程模型 |
|------|------|---------|
| **Leader** | 团队协调者，TUI 只读显示，watcher 接收 Worker 完成报告并自动处理 | 长期运行 (`claude-orchestrator leader`) |
| **Worker** | 工作实例，watcher 接收消息并通过 `$COMMAND -p` 处理 | 长期运行 (`claude-orchestrator register`) |
| **CLI** | 一次性命令，直接操作 ZK，是所有消息发送的唯一入口 | 短期运行 (如 `push-task`, `send-message`) |

### 核心模块

| 模块 | 职责 | 运行位置 |
|------|------|---------|
| Instance Registry | 实例注册、心跳、存活检测 | 所有节点直连 ZK |
| Task Queue | 任务入队、认领、完成、超时恢复 | Leader 监控 + Worker 认领 |
| Message Router | 点对点消息、广播，模板渲染 | 所有节点 via ZK sequential + watcher `$COMMAND -p` |
| Recovery Handler | 孤儿任务回收、实例断线处理 | Leader 专属 |
| Agent Templates | Worker/Leader 消息模板渲染 | `setup` 写入，运行时读取 |
| Cache Manager | 共享日志/结果目录管理 | Leader 写入，Worker 读取 |

## 3. Leader 节点设计

### 3.1 启动

```bash
# 初始化 Leader 环境
claude-orchestrator setup --leader --name Tom

# 启动 Leader
claude-orchestrator leader [--name <name>]
```

启动后：
1. 连接 ZooKeeper，创建 `/leader` EPHEMERAL 节点声明领导权
2. 创建自身 Instance 节点 (`role=leader`)，获得 `instance_id`
3. 初始化 CACHE_DIR: `~/.claude-orchestrator/sessions/{instance_id}/`
4. 加载 `.claude-orchestrator/agents/leader-decompose.md` 和 `leader-decide.md` 模板
5. 启动 **Leader Watcher** 监听 `/messages/{leader_instance_id}/` 上的新消息
6. 初始化 TUI 界面（**只读显示**，不接收用户输入）
7. 注册所有 ZK Watch 监听团队状态变化
8. 进入事件循环，等待 ZK 事件

### 3.2 Leader Watcher

```
Leader watcher 流程:
  1. 在 /messages/{leader_instance_id}/ 上设置 ChildWatch
  2. Watch 触发 → 读取新消息
  3. 对每条未读消息:
     - 打印到 TUI 事件日志
     - $COMMAND -p "$MESSAGE" | tee $CACHE_DIR/{key}.log
     - 标记消息已读
  4. 重建 Watch，继续监听
```

### 3.3 Leader TUI (只读显示)

Leader TUI 使用终端 ANSI 控制字符实现，**仅用于可视化，不接收用户输入**。

**A. 团队面板 (Team Panel)** — 顶部，实时显示所有在线成员：

```
┌─ Team: 3 members ───────────────────────────────────────────────────┐
│ Identity  Name    Role        Status    Current Task                 │
│ Leader    Tom     leader      idle      -                            │
│ Worker    Jerry   builder     busy      task-0000000003              │
│ Worker    Lucy    verifier    idle      -                            │
└──────────────────────────────────────────────────────────────────────┘
```

**B. 任务面板 (Task Panel)** — 中部左侧：

```
┌─ Pending (2) ──────────────────┐  ┌─ In Progress (1) ───────────┐
│ [HIGH] 实现登录 (→Jerry)       │  │ Jerry: 实现 POST /api/items  │
│ [MED] 写单元测试                │  │                              │
└────────────────────────────────┘  └──────────────────────────────┘
```

**C. 事件日志 (Event Log)** — 中部，滚动显示实时事件：

```
[10:30:01] ✓ Jerry joined (builder)
[10:30:15] 📋 Task task-0000000003 created
[10:30:20] 🔒 Jerry claimed task-0000000003
[10:35:00] 📨 Jerry → Leader: 任务 task-0000000003 已完成
[10:35:05] 🔄 Leader processing: $COMMAND -p "..." | tee $CACHE_DIR/xxx.log
[10:35:30] ✅ Leader done. Log: sessions/xxx/xxx.log
```

**D. 页脚** — 底部提示：

```
Leader: Tom | Instance: a1b2c3... | CACHE_DIR: ~/.claude-orchestrator/sessions/a1b2c3.../
Press Ctrl+C to stop.
```

### 3.4 Leader 职责

Leader 是责任链的协调者，核心工作是：**将需求转化为可执行的任务链，并推动任务走完 Plan → Build → Verify → Review → Accept 闭环。**

Leader 通过 Claude（`$COMMAND -p`）来处理两件事：
1. **任务生成**：将自然语言需求拆解为结构化的环节任务（使用 `leader-decompose.md` 模板）
2. **消息处理**：理解 Worker 的完成报告，决定下一步调度（使用 `leader-decide.md` 模板）

### 3.5 Leader 消息发送

所有消息发送通过 CLI `send-message` 命令统一入口：

```bash
# Worker 通过 CLI 向 Leader 报告完成
claude-orchestrator send-message --to-name Tom --content \
  "任务 task-0000000001 已完成，结果路径: sessions/xxx/task-0000000001_result.log。请指示下一步。"

# Leader 响应 Worker
claude-orchestrator send-message --to-name Jerry --content \
  "收到结果，请继续实现 E2E 测试，任务文档见 ./tasks/task-0000000002.md"
```

## 4. Worker 设计

### 4.1 注册与启动

```bash
# 初始化 Worker 环境
claude-orchestrator setup --name Jerry --role builder

# 启动 Worker
claude-orchestrator register
```

启动流程：

```
1. 连接 ZooKeeper
2. 创建 /instances/{uuid} EPHEMERAL 节点 (role=planner/builder/verifier/reviewer/accepter)
3. 保存 instance_id 到 <cwd>/.claude-orchestrator/config.json
4. 创建 /messages/{uuid} 目录
5. 确保 CACHE_DIR (~/.claude-orchestrator/sessions/{leader_instance_id}/) 可访问
6. 加载五个 link 模板:
   .claude-orchestrator/agents/worker-plan.md
   .claude-orchestrator/agents/worker-build.md
   .claude-orchestrator/agents/worker-verify.md
   .claude-orchestrator/agents/worker-review.md
   .claude-orchestrator/agents/worker-accept.md
7. 启动消息监听循环:
   a. 在 /messages/{uuid} 上设置 ChildWatch
   b. Watch 触发 → 读取新消息
   c. 对每条未读消息:
      - 根据消息 link 字段选择对应模板
      - 生成唯一 key
      - spawn $COMMAND -p "$MESSAGE" | tee $CACHE_DIR/{key}.log
      - 等待执行完成
      - 标记消息已读
   d. 重建 Watch，继续监听
8. 阻塞等待 SIGINT
9. 清理: 删除 /instances/{uuid}, 关闭 ZK 连接
```

### 4.2 Worker 能力

1. **自动消息处理**：watcher 自动监听并处理收到的消息
2. **按 link 执行**：根据任务 link 选择对应模板，按标准流程执行
3. **显式 CLI 操作**：Worker 的 Claude Code 实例可以调用 CLI 命令：
   - `claim-task` — 认领下一个待办任务
   - `complete-task` — 完成任务
   - `send-message` — 发消息给其他成员
   - `poll-message` — 检查消息

### 4.3 标准执行流程

所有环节的执行都建立在 `task-traceability` 基础层之上，定义了通用的五步法（追溯 → 执行 → 映射 → 举证 → 记录），每个环节按自身职责具体应用。`task-acceptance` 流程用于需要产出定义性文档的环节（Plan 和 Accept）。

| 环节 | 模板文件 | 标准流程 | 核心关注点 |
|------|---------|---------|-----------|
| Plan | `worker-plan.md` | task-traceability + task-acceptance | 追溯需求→设计蓝图→映射任务→举证完整性→记录蓝图 |
| Build | `worker-build.md` | task-traceability | 追溯蓝图→逐项实现→映射实现→举证测试→记录 commit |
| Verify | `worker-verify.md` | task-traceability | 追溯蓝图+产出→逐项验证→映射验证→举证结果→记录报告 |
| Review | `worker-review.md` | task-traceability | 追溯全链→逐项判定→映射判定→举证理据→记录审查 |
| Accept | `worker-accept.md` | task-traceability + task-acceptance | 追溯全链产出→逐项核实验收标准→映射交付→举证核实→签署 Go/No-Go |

## 5. Agent 模板系统

### 5.1 模板文件

`setup` 命令自动在项目目录下生成模板文件：

```
.claude-orchestrator/
├── agents/
│   ├── leader-decompose.md   # Leader 任务分解模板
│   ├── leader-decide.md      # Leader 调度决策模板
│   ├── worker-plan.md        # Planner 执行模板
│   ├── worker-build.md       # Builder 执行模板
│   ├── worker-verify.md      # Verifier 执行模板
│   ├── worker-review.md      # Reviewer 执行模板
│   └── worker-accept.md      # Accepter 执行模板
└── config.json               # 项目级实例配置
```

### 5.2 Leader 模板

两个独立模板，职责分离：

| 模板 | 触发时机 | 输入变量 | 输出 |
|------|---------|---------|------|
| `leader-decompose.md` | 收到用户需求 | `{{team_status}}`, `{{content}}` | 结构化任务链 JSON (tasks: {plan?, build, verify, review, accept}) |
| `leader-decide.md` | 收到 Worker 完成报告 | `{{team_status}}`, `{{task_queues}}`, `{{chain_status}}`, `{{content}}` | 调度决策指令 (pass/feedback/reject + next_action) |

### 5.3 Worker 模板变量

| 变量 | 来源 | 说明 |
|------|------|------|
| `{{name}}` | config.name | Worker 显示名称 |
| `{{preset_role}}` | config.role | Worker 注册时的预设角色 |
| `{{task_title}}` | 任务 title 字段 | 当前任务的简短标题 |
| `{{task_description}}` | 任务 description 字段 | 当前任务的详细描述 |
| `{{task_criteria}}` | 任务 criteria 字段 | 当前任务的完成标准 |
| `{{task_doc_path}}` | 系统生成 | 任务文档路径 |
| `{{result_path}}` | 系统生成 | 执行结果日志路径 |
| `{{work_dir}}` | config.work_dir | Worker 的工作目录 |
| `{{time}}` | 系统生成 | 当前时间戳 |

## 6. Command 配置与执行

### 6.1 配置项

```json
{
  "command": "claude --dangerously-skip-permissions -v",
  "cache_dir": "~/.claude-orchestrator/sessions"
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `command` | `claude --dangerously-skip-permissions -v` | Claude CLI 基础命令 |
| `cache_dir` | `~/.claude-orchestrator/sessions` | 共享日志/结果目录根路径 |

### 6.2 执行模式

所有消息处理统一使用：

```bash
$COMMAND -p "$MESSAGE" | tee $CACHE_DIR/${uniqueKey}.log
```

此模式确保终端实时输出和文件持久化。

### 6.3 uniqueKey 生成规则

```
uniqueKey = {prefix}-{identifier}-{timestamp}

prefix:
  - task-{task_id}  → Leader 下发任务 / Worker 执行任务
  - msg-{msg_id}    → Worker 处理普通消息
  - reply-{msg_id}  → Worker 发送回复

identifier: task_id 或 msg_id
timestamp: ISO 字符串简化版 (如 20260511T103000)
```

## 7. CACHE_DIR 共享目录

### 7.1 目录结构

```
~/.claude-orchestrator/sessions/        ← config.cache_dir 默认值
├── {leader_instance_id}/               ← Leader 实例 ID
│   ├── tasks/                          ← 任务文档
│   │   └── task-0000000001.md
│   ├── task-0000000001-20260511T103000.log
│   ├── task-0000000001-result.md       ← Worker 产出
│   └── msg-msg-044-20260511T103500.log
```

### 7.2 配置要求

- Leader 和所有 Worker 必须配置相同的 `cache_dir` 路径
- 默认路径: `~/.claude-orchestrator/sessions`
- 支持绝对路径和环境变量展开（如 `$HOME/project/sessions`）
- 在共享文件系统环境下（NFS / 同一主机），Worker 可直接读取 Leader 的文件
- Leader 启动时创建 `$CACHE_DIR/{leader_instance_id}/` 子目录
- Worker 注册时验证 `$CACHE_DIR/{leader_instance_id}/` 可访问

## 8. setup 命令设计

### 8.1 Leader 环境初始化

```bash
claude-orchestrator setup --leader --name Tom
```

执行操作：
1. 在项目根目录创建 `.claude-orchestrator/` 目录
2. 写入所有 Agent 模板文件
3. 在 `.claude-orchestrator/config.json` 写入: `{"name": "Tom", "role": "leader"}`
4. 在 `~/.claude-orchestrator/config.json` 写入全局配置

### 8.2 Worker 环境初始化

```bash
claude-orchestrator setup --name Jerry --role builder
```

执行操作：
1. 在项目根目录创建 `.claude-orchestrator/` 目录
2. 写入所有 Agent 模板文件
3. 在 `.claude-orchestrator/config.json` 写入: `{"name": "Jerry", "role": "builder"}`

### 8.3 setup 参数

| 参数 | 必需 | 说明 |
|------|------|------|
| `--leader` | 否 | 指定为 Leader 环境 |
| `--name <name>` | 是 | 实例显示名称 |
| `--role <role>` | 否 | 实例角色，Leader 自动设为 `leader`，Worker 默认 `builder` |
| `--cache-dir <path>` | 否 | 自定义共享缓存目录 |
| `--command <cmd>` | 否 | 自定义 Claude CLI 命令 |
| `--global` | 否 | 仅写入全局配置，不创建项目目录 |

## 9. 通信流程

### 9.1 Leader 分配任务给 Worker

```
Terminal (CLI)              ZK                         Worker (watcher)
    │                         │                              │
    │   1. 写入任务文档         │                              │
    │   $CACHE_DIR/xxx/        │                              │
    │   tasks/task-xxx.md      │                              │
    │                         │                              │
    │   2. send_message ──────>│                              │
    │   --to-name Jerry       │── /messages/Jerry/msg-042    │
    │   (含 link, task_doc)   │   sequential node            │
    │                         │                              │
    │                         │<── ZK Watch 触发 ───────────│
    │                         │   根据 link 选择模板          │
    │                         │   $COMMAND -p "$MSG" |      │
    │                         │   tee $CACHE_DIR/xxx.log    │
    │                         │                              │
    │                         │   3. Jerry 完成任务           │
    │                         │   claim_task → complete_task │
    │                         │                              │
    │                         │   4. send_message ──────────>│
    │                         │   --to-name Tom              │
    │                         │── /messages/Tom/msg-043      │
    │                         │                              │
    │<── ZK Watch 触发 ──────│                              │
    │   Leader watcher:       │                              │
    │   $COMMAND -p "完成报告" │                              │
    │   | tee $CACHE_DIR/log  │                              │
    │                         │                              │
    │   5. Leader 评估结果      │                              │
    │   决定下一步...           │                              │
```

### 9.2 Leader 断开 → 自动恢复

```
Leader 进程崩溃
    │
    ├── /leader 临时节点自动删除 (ZK session timeout)
    ├── Worker 不受影响 — 各自直连 ZK，继续工作
    ├── 已认领的任务不受影响
    └── 新 Leader 启动:
        1. 扫描 /instances 重建团队视图
        2. 扫描 /tasks 重建任务视图
        3. 发现孤儿 claimed 任务并移回 /tasks/pending
        4. 创建新的 CACHE_DIR/{new_leader_instance_id}/
        5. 开始正常监控
```

### 9.3 Worker 断开 → 任务回收

```
Worker 进程崩溃 / 网络断开
    │
    ├── /instances/{id} 临时节点自动删除 (ZK session timeout)
    ├── /tasks/claimed/{id}-task-X 临时节点自动删除
    ├── Leader ZK Watch 触发:
    │   1. TUI 显示: ✗ Worker disconnected
    │   2. 检测到孤儿任务 task-X
    │   3. 将 task-X 重新写入 /tasks/pending (保留原 priority 和 assignee)
    │   4. TUI 事件日志: ↻ task-X 重新入队
    └── 其他 Worker 不受影响
```

## 10. 任务生命周期

```
                    ┌─────────┐
                    │ pending │
                    └────┬─────┘
                         │ claim_task
                    ┌────▼────┐
               ┌────│ claimed │────┐
               │    └─────────┘    │
               │ task-block        │ task-fail
          ┌────▼─────┐       ┌────▼─────┐
          │ blocked  │       │  failed  │
          └──────────┘       └────┬─────┘
                                  │ task-retry
                                  ▼
                             pending (retry)

               │
               │ complete-task
          ┌────▼──────┐
          │ completed │
          └───────────┘
```

| 状态 | 含义 | 触发方式 |
|------|------|---------|
| `pending` | 等待认领 | `push_task` |
| `claimed` | 已认领，执行中 | `claim_task` |
| `completed` | 已完成 | `complete_task` |
| `blocked` | 被阻塞，等待解除 | `task-block` |
| `failed` | 执行失败，可重试 | `task-fail` |

## 11. ZooKeeper 节点树

```
/claude-orchestrator
│
├── /leader                              [EPHEMERAL]  Leader 存在声明
│   data: {"instance_id":"...", "name":"...", "started_at":"..."}
│
├── /instances/
│   └── /{instance_id}                   [EPHEMERAL]  成员实例
│       data: {"id":"...", "name":"Jerry", "role":"builder",
│              "status":"busy", "current_task_id":"task-003",
│              "connected_since":"...", "work_dir":"..."}
│
├── /tasks/
│   ├── /pending/
│   │   └── /task-{seq}                  [PERSISTENT_SEQUENTIAL]
│   │       data: {"id":"...", "title":"...", "description":"...",
│   │              "priority":0, "status":"pending",
│   │              "link":"build", "chain_id":"chain-001",
│   │              "created_by":"...", "assigned_to":"...",
│   │              "created_at":"...", "retry_count":0,
│   │              "depends_on":[], "task_doc_path":"..."}
│   ├── /claimed/
│   │   └── /{instance_id}-{task_id}     [EPHEMERAL]
│   │       data: {"task_id":"...", "instance_id":"...",
│   │              "claimed_at":"...", "status":"claimed",
│   │              "task_data":{...}}
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
│                  "from_role":"...", "to_instance":"...",
│                  "to_name":"...", "content":"...",
│                  "link":"build", "task_id":"...",
│                  "task_doc_path":"...", "result_path":"...",
│                  "created_at":"...", "read":false,
│                  "reply_to":null}
```

## 12. CLI 命令

| 分类 | 命令 | 说明 |
|------|------|------|
| 控制 | `leader` | 启动 Leader TUI 编排控制台 |
| 控制 | `register` | 注册为 Worker，监听当前目录 |
| 控制 | `unregister` | 注销实例 |
| 控制 | `config` | 查看当前配置 |
| 控制 | `setup` | 初始化环境与配置文件 |
| 消息 | `send-message` | 发送消息（直发/广播） |
| 消息 | `poll-message` | 检查新消息 |
| 消息 | `delete-message` | 删除消息 |
| 任务 | `push-task` | 创建新任务 |
| 任务 | `poll-task` | 查看任务列表 |
| 任务 | `claim-task` | 认领任务 |
| 任务 | `complete-task` | 完成任务 |
| 任务 | `task-block` | 标记任务阻塞 |
| 任务 | `task-fail` | 标记任务失败 |
| 任务 | `task-retry` | 重试失败任务 |

## 13. 数据模型

### Instance

```typescript
interface Instance {
  id: string;
  name: string;
  role: "planner" | "builder" | "verifier" | "reviewer" | "accepter" | "leader";
  status: "idle" | "busy";
  current_task_id: string | null;
  connected_since: string;
  work_dir: string;
}
```

role 语义：注册时的预设权重偏好，Worker 的当前实际角色由认领的任务所属 link 决定。

### Task

```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  priority: 0 | 1 | 2;
  status: "pending" | "claimed" | "completed" | "blocked" | "failed";
  link: "plan" | "build" | "verify" | "review" | "accept";
  chain_id: string | null;
  depends_on: string[];
  blocked_by: string[];
  task_doc_path: string | null;
  created_by: string;
  assigned_to: string | null;
  created_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
  result: string | null;
  retry_count: number;
  blocked_reason: string | null;
  fail_reason: string | null;
}
```

## 14. 安全设计

| 层面 | 措施 | 说明 |
|------|------|------|
| 网络 | ZK 连接可选 TLS | 生产环境建议配置 ZK SSL |
| 身份 | Instance Name 作为标识 | 通过 `--name` 指定 |
| 授权 | 实例只能操作自己的 claimed task | `complete_task` 校验 claimed 节点归属 |
| Leader | 单 Leader (无选举) | 先启动的 Leader 占 `/leader` 节点 |
| ZooKeeper | ACL + Digest 认证 (可选) | 生产环境配置 |

## 15. 文件结构

```
claude-orchestrator-server/            ← npm 包根目录
├── package.json
├── tsconfig.json
├── docker-compose.yml
├── src/
│   ├── index.ts                       # CLI 入口 (commander)
│   ├── config.ts                      # 配置管理
│   ├── cli/
│   │   └── commands.ts                # CLI 子命令实现
│   ├── leader/
│   │   ├── index.ts                   # Leader 启动入口
│   │   ├── tui.ts                     # TUI 只读渲染
│   │   ├── watcher.ts                 # Leader 消息监听
│   │   ├── monitor.ts                 # ZK Watch 管理
│   │   ├── orchestrator.ts            # 任务 Watch 编排
│   │   ├── recovery.ts                # 孤儿任务回收
│   │   ├── task-generator.ts          # Claude 任务拆解
│   │   ├── decision-engine.ts         # Claude 调度决策
│   │   ├── event-bus.ts              # 事件总线
│   │   └── state.ts                  # Leader 状态管理
│   ├── worker/
│   │   └── watcher.ts                 # Worker 消息监听
│   ├── templates/
│   │   ├── leader-decompose.md        # Leader 任务分解模板
│   │   ├── leader-decide.md           # Leader 调度决策模板
│   │   ├── worker-plan.md            # Planner 模板
│   │   ├── worker-build.md           # Builder 模板
│   │   ├── worker-verify.md          # Verifier 模板
│   │   ├── worker-review.md          # Reviewer 模板
│   │   └── worker-accept.md          # Accepter 模板
│   ├── zk/
│   │   ├── client.ts                  # ZK 连接管理
│   │   ├── paths.ts                   # ZK 路径常量
│   │   └── watcher.ts                 # ZK Watch 工具
│   ├── modules/
│   │   ├── registry.ts                # 实例注册表
│   │   ├── task-queue.ts              # 任务队列
│   │   └── message-router.ts          # 消息路由 + 模板渲染
│   ├── models/
│   │   └── schemas.ts                 # Zod schemas + 类型
│   └── utils/
│       ├── exec.ts                     # Claude CLI 执行 + tee 日志
│       └── output.ts                  # CLI 输出格式化
├── scripts/
│   ├── start-zk.sh
│   ├── start-leader.sh
│   ├── start-worker.sh
│   ├── stop-all.sh
│   └── publish.sh
└── tests/
    ├── unit/
    └── integration/

项目目录 (setup 命令生成):
├── .claude-orchestrator/
│   ├── agents/
│   │   ├── leader-decompose.md
│   │   ├── leader-decide.md
│   │   ├── worker-plan.md
│   │   ├── worker-build.md
│   │   ├── worker-verify.md
│   │   ├── worker-review.md
│   │   └── worker-accept.md
│   └── config.json

全局目录:
├── ~/.claude-orchestrator/
│   ├── config.json
│   └── sessions/
│       └── {leader_instance_id}/
│           ├── tasks/
│           │   └── task-xxx.md
│           ├── task-xxx-yyy.log
│           └── task-xxx-result.md
```
