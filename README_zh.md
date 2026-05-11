# Claude Orchestrator

<p align="center">
  <strong>将多个 Claude Code 实例编排成一支协作的 AI 团队 —— 基于 ZooKeeper 分布式协调。</strong>
  <br/>
  <em>Turn Claude Code instances into a multi-agent swarm — coordinated through ZooKeeper.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@adamancyzhang/claude-orchestrator"><img src="https://img.shields.io/npm/v/@adamancyzhang/claude-orchestrator?color=blue" alt="npm"></a>
  <a href="https://github.com/adamancyzhang/claude-orchestrator-server"><img src="https://img.shields.io/github/license/adamancyzhang/claude-orchestrator-server" alt="license"></a>
  <img src="https://img.shields.io/badge/node-18%2B-green" alt="node">
  <img src="https://img.shields.io/badge/typescript-5.6%2B-blue" alt="typescript">
  <img src="https://img.shields.io/badge/ZooKeeper-3.8%2B-orange" alt="zookeeper">
</p>

---

## 这是什么？

**Claude Orchestrator** 让你可以同时运行多个 Claude Code 实例，它们互相发现、认领任务、收发消息、共享上下文，像一支真正的开发团队一样协作。想象一下，给每个 Claude Code 实例配一个对讲机和一块共享看板，然后看它们一起构建软件。

底层通过 ZooKeeper 实现分布式协调：临时节点管理实例心跳，顺序节点保证任务 FIFO 排序，Watch 机制实现实时通知。

v0.3.0 引入了 **Leader-Worker CLI 原生架构**：不再依赖 MCP 服务器，没有 HTTP 协议。Leader 运行只读 TUI 监控团队，Worker 直连 ZooKeeper 并通过 `claude -p` 处理消息。所有通信都通过 CLI 完成。

```
┌─────────────────────────────────────────────────┐
│                  ZooKeeper                       │
│  /leader  /instances  /tasks  /messages  /context│
└──────┬──────────────┬──────────────┬────────────┘
       │              │              │
  ┌────┴────┐    ┌────┴────┐    ┌────┴────┐
  │ Leader  │    │ Worker  │    │ Worker  │
  │  (TUI)  │    │ (CLI)   │    │ (CLI)   │
  │  Tom    │    │ Jerry   │    │  Bob    │
  │ 架构师   │    │ 开发者   │    │ 测试    │
  └─────────┘    └─────────┘    └─────────┘
       │              │              │
       └──────────────┼──────────────┘
                      │
              claude-orchestrator CLI
              (send-message, push-task, …)
```

---

## 快速开始

### 1. 安装命令行工具

```bash
npm install -g @adamancyzhang/claude-orchestrator
```

### 2. 启动 ZooKeeper

```bash
docker-compose up -d
```

### 3. 初始化环境

```bash
# Leader（团队协调者）：
claude-orchestrator setup --leader --name Tom

# Worker（执行者——每个 Worker 一个）：
claude-orchestrator setup --name Jerry --role developer
```

这会创建 `.claude-orchestrator/agents/` 目录并写入消息模板，同时写入项目和全局配置。

### 4. 启动 Leader

```bash
claude-orchestrator leader --name Tom
# → TUI 启动：团队面板、任务看板、事件日志、页脚
```

Leader TUI 是只读的 —— 它显示谁在线、任务状态（待处理/进行中），以及滚动的事件日志。所有操作通过 CLI 命令或 Worker 注册触发。

### 5. 注册 Worker

```bash
# 持久模式 —— 保持连接，自动处理消息：
claude-orchestrator register --name Jerry --role developer --work-dir /path/to/project

# 一次性模式 —— 仅注册，不启动持久监听器：
claude-orchestrator register --name Jerry --role developer
```

### 6. 开始使用

Leader TUI 会立刻显示 Jerry 上线。你可以从任意终端推送任务、发送消息、管理完整生命周期。

```bash
claude-orchestrator push-task --title "实现登录接口" --priority 0
claude-orchestrator send-message --to-name Jerry --content "开始写认证模块了吗？"
claude-orchestrator list-tasks --status pending
```

---

## 工作原理

### Leader-Worker 模型

| 组件 | 功能 | ZK 魔法 |
|------|------|---------|
| **Leader** | 只读 TUI，监控团队，恢复孤儿任务 | `/leader` EPHEMERAL — 同时只有一个 Leader |
| **Worker** | 持久 ZK 连接，通过 `claude -p` 自动处理消息 | 临时节点 → 断线自动清理 |
| **任务队列** | 推送 → 认领 → 进行中 → 完成（或阻塞/失败/重试） | 顺序节点保证 FIFO，临时节点实现原子锁 |
| **消息路由** | 点对点消息、广播、求助、模板渲染 | 持久顺序节点 + ZK Watch 推送 |
| **上下文存储** | 共享键值存储、变更监听 | 持久节点，跨实例可见 |

### CLI 原生 —— 零 MCP 服务器

v0.3.0 完全移除了中心化的 MCP 服务器。Leader 和 Worker 各自直连 ZooKeeper。消息通过 ZK Watch 触发接收方执行 `$COMMAND -p "$MSG" | tee $CACHE_DIR/{key}.log`。这消除了 3 层中间层（MCP 协议、SSE、HTTP），让每个节点完全自包含。

### CLI 命令（25 个）

| 命令 | 功能 |
|------|------|
| `leader` | 启动 Leader 节点，显示只读 TUI |
| `setup` | 初始化环境：模板、配置、agent 目录 |
| `register` | 加入团队。加 `--work-dir` 启用持久消息监听 |
| `heartbeat` | 保持在线，可选报告当前任务 |
| `status` | 健康检查（ZK 连接状态） |
| `list-instances` | 查看当前在线实例 |
| `push-task` | 创建任务（可指定分配给某人） |
| `claim-task` | 认领下一个任务 —— 原子操作，不会重复认领 |
| `complete-task` | 标记任务完成并提交结果 |
| `task-block` | 标记任务为阻塞（附原因） |
| `task-fail` | 标记任务为失败（附原因） |
| `task-retry` | 重新入队失败任务（retry_count + 1，最多 3 次） |
| `list-tasks` | 按状态查看任务（pending/claimed/in_progress/completed/blocked/failed） |
| `send-message` | 按名称私聊其他实例或广播给所有人 |
| `poll-messages` | 检查收件箱 |
| `wait-for-message` | 长轮询 —— 阻塞等待新消息 |
| `dismiss-message` | 删除收件箱中的消息 |
| `request-help` | 向整个团队广播求助 |
| `set-context` | 写入共享键值对 |
| `get-context` | 读取共享键值对 |
| `delete-context` | 删除共享上下文键 |
| `list-context-keys` | 列出所有上下文键 |
| `watch-context` | 监听上下文键变更（阻塞直到变化） |
| `watch-tasks` | 监听新任务（阻塞直到新任务） |
| `unregister` | 显式注销实例 |
| `config` | 查看当前配置 |

所有 CLI 命令返回 JSON 格式。每个命令都支持 `--zookeeper` / `-z`（或环境变量 `ZK_HOSTS`）以指向远程 ZooKeeper。

---

## 实战演示

以下是一个 Leader（Tom）和两个 Worker（Jerry、Bob）的真实协作流程：

**Tom 启动 Leader：**
```
claude-orchestrator leader --name Tom
→ TUI 显示：[TEAM] Tom (leader), [PENDING] 空, [EVENT LOG] Leader started
```

**Jerry 注册为 Worker：**
```bash
claude-orchestrator register --name Jerry --role developer --work-dir ~/project
```
```
TUI 更新：
  [TEAM] Jerry joined (developer)
  [EVENT] 9:15:03 PM Jerry joined (developer)
```

**Tom 分配工作（从另一个终端）：**
```bash
claude-orchestrator push-task --title "实现用户登录接口 POST /api/auth/login" \
  --description "邮箱+密码登录，返回 JWT。需要处理参数校验和错误码。" --priority 0
```

**Jerry 认领任务：**
```bash
claude-orchestrator claim-task
# → { "id": "task-0000000000", "status": "claimed", ... }
```

**Jerry 遇到阻塞：**
```bash
claude-orchestrator task-block --task-id task-0000000000 --reason "等待 API key"
```

**Tom 在 TUI 中看到阻塞状态，发送 API key：**
```bash
claude-orchestrator send-message --to-name Jerry --content "API key 在 1Password: auth/third-party/google-oauth"
```

**Jerry 完成任务：**
```bash
claude-orchestrator complete-task --task-id task-0000000000 --result "PR #42 — 实现了登录接口，包含单元测试"
```

**Bob 的任务失败（测试环境不可用）：**
```bash
claude-orchestrator task-fail --task-id task-0000000001 --reason "测试环境不可用"
claude-orchestrator task-retry --task-id task-0000000001
# → 重新入队为 task-0000000002，retry_count: 1
```

---

## ZooKeeper 节点结构（v0.3.0）

```
/claude-orchestrator
├── leader                     [EPHEMERAL] Leader 元数据
├── instances/
│   ├── a1b2c3d4...            [EPHEMERAL] Tom（Leader）
│   ├── f6e5d4c3...            [EPHEMERAL] Jerry（开发者）
│   └── e7f8a9b0...            [EPHEMERAL] Bob（测试）
├── tasks/
│   ├── pending/
│   │   ├── task-0000000000    [PERSISTENT_SEQUENTIAL]
│   │   └── task-0000000001    [PERSISTENT_SEQUENTIAL]
│   ├── claimed/
│   │   └── f6e5d4c3-task-0000000000  [EPHEMERAL] ← 原子锁！
│   └── completed/
│       └── task-0000000000    [PERSISTENT]
├── messages/
│   ├── a1b2c3d4.../
│   │   └── msg-0000000000    [PERSISTENT_SEQUENTIAL]
│   └── f6e5d4c3.../
│       └── msg-0000000000    [PERSISTENT_SEQUENTIAL]
└── context/
    └── jwt_strategy          [PERSISTENT]
```

**关键洞察：** 临时节点意味着崩溃的实例自动注销，被放弃的任务自动释放。Leader 监控 `/instances`，当 Worker 断线时自动恢复其孤儿任务（最多重试 3 次，之后归档为失败）。

---

## 任务状态机（v0.3.0）

```
pending → claimed → in_progress → completed
                            → blocked → pending（重试）
                            → failed  → pending（重试，最多 3 次）
claimed → pending（Worker 断线，Leader 恢复孤儿任务）
```

| 状态 | 含义 | 触发方式 |
|------|------|---------|
| `pending` | 等待认领 | `push_task` |
| `claimed` | 已认领，尚未开始 | `claim_task` |
| `in_progress` | 正在执行 | `heartbeat(current_task=...)` |
| `completed` | 已完成 | `complete_task` |
| `blocked` | 阻塞中，等待解除 | `task-block` |
| `failed` | 已失败，可重试 | `task-fail` |

---

## 安装与开发

### 环境要求

- Node.js 18+
- Docker（用于 ZooKeeper）
- Claude Code CLI（用于 `register --work-dir` 消息处理）

### 源码安装

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server

# 安装依赖
npm install

# 启动 ZooKeeper
docker-compose up -d

# 编译 TypeScript
npm run build

# 启动 Leader
claude-orchestrator leader

# 或直接使用 CLI
claude-orchestrator status
```

### 运行测试

```bash
npm test
```

---

## 内置技能

仓库内置了 Claude Code 技能，让编排器更好用：

| 技能 | 功能 |
|------|------|
| `claude-orchestrator` | 完整 CLI 参考 —— 全部 25 条命令及示例 |
| `orchestrator-setup` | 自动配置环境和 agent 模板 |
| `orchestrator-register` | 引导式注册流程 |
| `orchestrator-status` | 仪表盘：健康状态、实例、任务 |
| `orchestrator-communicate` | 消息模式：轮询、私聊、广播 |
| `orchestrator-help` | 求助工作流 |
| `orchestrator-agent` | 自主代理循环：检查 → 认领 → 工作 → 完成 |

---

## 为什么选择 ZooKeeper？

| 关注点 | ZooKeeper 的答案 |
|--------|-----------------|
| 实例生命周期 | 临时节点 → 自动清理。无需心跳轮询。 |
| 任务排序 | 顺序节点 → 保证 FIFO。无竞态条件。 |
| 认领原子性 | `create(path, ephemeral=true)` 在 ZK 层面是原子的。只有一个赢家。 |
| Leader 选举 | `/leader` EPHEMERAL → 保证只有一个 Leader。崩溃自动释放。 |
| 变更通知 | 内置 Watch → 推送，而非轮询。 |
| 依赖项 | 一个依赖（ZK）。无需外部数据库，无需 HTTP 服务器。 |

所有状态都在 ZooKeeper 中。零外部数据库。

---

## 角色

| 角色 | 值 | 典型职责 |
|------|-----|---------|
| Leader | `leader` | 运行 TUI，监控团队，恢复孤儿任务 |
| 架构师 | `architect` | 制定规范、设计任务、审核结果 |
| 开发者 | `developer` | 认领任务、编码实现、提交 PR |
| 测试 | `tester` | 认领测试任务、E2E 验证 |
| 通用 | `general` | 任意角色 |

---

## 配置参考

| 配置项 | 位置 | 默认值 |
|--------|------|--------|
| ZK 地址 | `-z, --zookeeper` 参数或 `ZK_HOSTS` 环境变量 | `127.0.0.1:2181` |
| 实例 ID | `-i, --instance-id` 参数或 `.claude-orchestrator/config.json`（项目）/ `~/.claude-orchestrator/config.json`（全局） | `register` 后自动保存 |
| Claude 命令 | `--command` 参数或 `config.json` → `command` | `claude --dangerously-skip-permissions -v` |
| 缓存目录 | `--cache-dir` 参数或 `config.json` → `cache_dir` | `~/.claude-orchestrator/sessions` |

---

## 项目结构

```
├── src/
│   ├── index.ts               # CLI 入口（commander，25 条命令）
│   ├── config.ts              # 配置管理
│   ├── cli/
│   │   └── commands.ts        # CLI 子命令实现
│   ├── leader/                # Leader 节点（v0.3.0 新增）
│   │   ├── index.ts           #   启动 / 关闭编排
│   │   ├── tui.ts             #   ANSI 只读 TUI
│   │   ├── event-bus.ts       #   类型化 EventEmitter
│   │   ├── state.ts           #   LeaderState 中心状态
│   │   ├── monitor.ts         #   WorkerMonitor — 上下线检测
│   │   ├── orchestrator.ts    #   TaskOrchestrator — 任务生命周期
│   │   ├── recovery.ts        #   TaskRecovery — 孤儿恢复（最多 3 次重试）
│   │   └── watcher.ts         #   LeaderWatcher — 消息处理
│   ├── worker/                # Worker 节点（v0.3.0 新增）
│   │   └── watcher.ts         #   WorkerWatcher — 持久消息监听
│   ├── templates/             # 内置 agent 模板（v0.3.0 新增）
│   │   ├── leader.md          #   Leader 消息模板
│   │   └── worker.md          #   Worker 完成报告模板
│   ├── zk/
│   │   ├── client.ts          # ZooKeeper 连接管理
│   │   ├── paths.ts           # ZK 路径常量
│   │   └── watcher.ts         # ZK Watch 管理器
│   ├── modules/
│   │   ├── registry.ts        # 实例注册
│   │   ├── task-queue.ts      # 任务队列（6 状态：push/claim/block/fail/retry）
│   │   ├── message-router.ts  # 消息路由 + 模板渲染 + 长轮询
│   │   └── context-store.ts   # 共享键值存储
│   ├── models/
│   │   └── schemas.ts         # Zod 模式 + 推断类型
│   └── utils/
│       ├── exec.ts            # Shell 执行工具（execWithTee）
│       └── output.ts          # CLI 输出格式化
├── bin/
│   └── claude-orchestrator     # npm CLI 入口（Node.js）
├── scripts/
│   ├── start-zk.sh             # Docker ZK 启动器
│   ├── start-leader.sh         # Leader 启动器
│   ├── start-worker.sh         # Worker 启动器
│   ├── stop-all.sh             # 一键停止
│   └── publish.sh              # npm 发布流程
├── skills/                     # Claude Code 技能
├── docs/
│   ├── v0.1.0/                 # 存档：Python v0.1.0 文档
│   ├── v0.2.0/                 # 存档：MCP 架构 v0.2.x 文档
│   └── v0.3.0/                 # 当前 v0.3.0 文档
│       ├── prd/                # 完整规格 + 架构 + ZK 模式
│       └── migration-guide.md  # v0.2.0 → v0.3.0 迁移指南
├── tests/
│   ├── unit/
│   └── integration/
├── docker-compose.yml          # ZooKeeper
├── package.json                # npm 包定义
└── tsconfig.json               # TypeScript 配置
```

---

## License

MIT — 随便用，随便改，随便发。

---

<p align="center">
  <sub>基于 TypeScript 和 ZooKeeper 构建。请负责任地编排。</sub>
</p>
