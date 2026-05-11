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

```
┌──────────────────────────────────────────────────────────┐
│                    Claude Orchestrator                    │
│                   (MCP Server :3100)                      │
│                                                          │
│  ┌──────────────┐  ┌──────────┐  ┌──────────────┐       │
│  │   注册中心    │  │  任务队列  │  │   消息路由   │       │
│  │  谁在线？    │  │  FIFO Q   │  │  点对点+广播  │       │
│  └──────┬───────┘  └────┬─────┘  └──────┬───────┘       │
│         └────────────────┼──────────────┘                │
│                   ┌──────┴──────┐                        │
│                   │  ZooKeeper  │                        │
│                   └──────┬──────┘                        │
│                   ┌──────┴──────┐                        │
│                   │  共享上下文  │                        │
│                   │  KV 存储    │                        │
│                   └─────────────┘                        │
└──────────────────────────────────────────────────────────┘
         ▲                    ▲                    ▲
         │                    │                    │
    ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
    │  Tom    │          │ Jerry   │          │  Bob    │
    │ 架构师   │          │ 开发者   │          │ 测试    │
    └─────────┘          └─────────┘          └─────────┘
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

### 3. 启动 MCP 服务端

```bash
# 从源码运行
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server
npm install
npm run build
node dist/index.js server
# → MCP server listening on http://127.0.0.1:3100
```

### 4. 配置 Claude Code

在项目目录的 `.claude/mcp.json`（或 `~/.claude/mcp.json`）中：

```json
{
  "mcpServers": {
    "orchestrator": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

### 5. 注册并开始

打开 Claude Code，然后说：

```
我有一个 MCP 工具叫 orchestrator。请调用 register_instance，
name 设为 "Tom"，role 设为 "architect"。记下返回的 instance_id。
```

再打开第二个终端，启动另一个 Claude Code 实例，将 Jerry 注册为 developer。它们会自动互相发现、传递任务、协作开发。

---

## 工作原理

### 四个模块，一个 ZK

| 模块 | 功能 | ZK 魔法 |
|------|------|---------|
| **实例注册** | 注册、心跳、发现、注销 | 临时节点 → 断线自动清理 |
| **任务队列** | 推送 → 认领 → 完成 | 顺序节点保证 FIFO，临时认领节点实现原子锁 |
| **消息路由** | 点对点消息、广播、求助、长轮询 | 持久顺序节点 + ZK Watch 推送 |
| **上下文存储** | 共享键值存储、变更监听 | 持久节点，跨实例可见 |

### MCP 工具清单（18 个）

每个 Claude Code 实例通过调用以下工具参与协作：

| # | 工具 | 功能 |
|---|------|------|
| 1 | `register_instance` | 加入团队，设置名称和角色 |
| 2 | `heartbeat` | 保持在线，可选报告当前工作 |
| 3 | `list_instances` | 查看当前在线的实例 |
| 4 | `push_task` | 创建任务（可指定分配给某人） |
| 5 | `claim_task` | 领取下一个任务 —— 原子操作，不会重复认领 |
| 6 | `complete_task` | 标记任务完成并提交结果 |
| 7 | `list_tasks` | 按状态查看任务（pending / claimed / completed） |
| 8 | `send_message` | 私聊其他实例或广播给所有人 |
| 9 | `poll_messages` | 检查收件箱 |
| 10 | `wait_for_message` | 长轮询 —— 阻塞等待新消息 |
| 11 | `dismiss_message` | 删除收件箱中的消息 |
| 12 | `request_help` | 向整个团队广播求助 |
| 13 | `set_context` | 写入共享键值对 |
| 14 | `get_context` | 读取共享键值对 |
| 15 | `delete_context` | 删除共享上下文键 |
| 16 | `list_context_keys` | 列出所有上下文键 |
| 17 | `mark_read` | 标记指定消息为已读 |
| 18 | `server_status` | 健康检查 |

### 或直接用命令行

如果更喜欢终端操作而不是 Claude Code：

```bash
# 注册
claude-orchestrator register --name Alice --role developer

# 查看在线实例
claude-orchestrator list-instances

# 推送任务
claude-orchestrator push-task --title "添加限流功能" --priority 0

# 认领下一个任务
claude-orchestrator claim-task

# 发送消息
claude-orchestrator send-message --to <instance-id> --content "PR #42 进展如何？"

# 检查收件箱
claude-orchestrator poll-messages

# 等待消息（阻塞直到收到或超时）
claude-orchestrator wait-for-message --timeout 60

# 删除消息
claude-orchestrator dismiss-message --message-id msg-0000000000

# 共享上下文
claude-orchestrator set-context --key "api_version" --value "v2.1"

# 读取共享上下文
claude-orchestrator get-context --key "api_version"

# 列出上下文键
claude-orchestrator list-context-keys

# 删除上下文
claude-orchestrator delete-context --key "api_version"

# 监听上下文变更
claude-orchestrator watch-context --key "jwt_strategy"

# 监听新任务
claude-orchestrator watch-tasks

# 注销实例
claude-orchestrator unregister

# 查看配置
claude-orchestrator config

# 健康检查
claude-orchestrator status
```

所有 CLI 命令返回 JSON 格式。每个命令都支持 `--zookeeper` / `-z`（或环境变量 `ZK_HOSTS`）以指向远程 ZooKeeper。

---

## 实战演示

以下是用两个实例 —— Tom（架构师）和 Jerry（开发者）的真实协作流程：

**Tom 注册：**
```json
{ "id": "a1b2c3d4...", "name": "Tom", "role": "architect", "status": "idle" }
```

**Jerry 注册：**
```json
{ "id": "f6e5d4c3...", "name": "Jerry", "role": "developer", "status": "idle" }
```

**Tom 查看在线实例：**
```
2 active instances:
  [architect] Tom (a1b2c3d4...) status=idle
  [developer] Jerry (f6e5d4c3...) status=idle
```

**Tom 分配工作：**
```
push_task:
  title: "实现用户登录接口 POST /api/auth/login"
  description: "邮箱+密码登录，返回 JWT。需要处理参数校验和错误码。"
  priority: HIGH (0)
  assignee: f6e5d4c3... (Jerry)
```

**Jerry 认领任务：**
```
claim_task → 拿到了！task-0000000000
heartbeat current_task="task-0000000000"
```

**Jerry 遇到问题，求助：**
```
request_help:
  question: "JWT token 的过期时间应该设多久？access token 和 refresh token 分别怎么处理？"
  context: "Express + jsonwebtoken，用户量预期 10万 DAU"
```

**Tom 检查消息并回复：**
```
poll_messages → 收到 Jerry 的 1 条新消息
send_message to=Jerry: "access_token 设 15 分钟，refresh_token 设 7 天。用 Redis 黑名单处理登出。"
```

**Tom 记录架构决策：**
```
set_context key="jwt_strategy" value="access:15min, refresh:7d, 黑名单:redis"
```

**Jerry 完成任务：**
```
complete_task task_id="task-0000000000" result="PR #42 — 实现了登录接口，包含单元测试"
```

这就是真实的协作流程。任务认领是原子操作，不会出现两个人抢到同一个任务的情况。消息通过 ZooKeeper 持久顺序节点即时传递。

---

## ZooKeeper 节点结构

```
/claude-orchestrator
├── instances/
│   ├── a1b2c3d4...    [EPHEMERAL] Tom 的注册
│   └── f6e5d4c3...    [EPHEMERAL] Jerry 的注册
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

**关键洞察：** 临时节点意味着崩溃的实例自动注销，被放弃的任务自动释放。没有死锁，没有孤儿数据。ZooKeeper 负责生命周期管理。

---

## 安装与开发

### 环境要求

- Node.js 18+
- Docker（用于 ZooKeeper）
- Claude Code（用于 MCP 集成）

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

# 启动服务端
node dist/index.js server

# 或直接使用 CLI
node dist/index.js status
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
| `claude-orchestrator` | 完整 CLI 参考 —— 全部 21 条命令及示例 |
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
| 变更通知 | 内置 Watch → 推送，而非轮询。 |
| 依赖项 | 一个依赖（ZK）。无需外部数据库。 |

所有状态都在 ZooKeeper 中。零外部数据库。

---

## 角色

| 角色 | 值 | 典型职责 |
|------|-----|---------|
| 架构师 | `architect` | 制定规范、分配任务、审核结果 |
| 开发者 | `developer` | 认领任务、编码实现、提交 PR |
| 测试 | `tester` | 认领测试任务、E2E 验证 |
| 通用 | `general` | 任意角色 |

---

## 配置参考

| 配置项 | 位置 | 默认值 |
|--------|------|--------|
| ZK 地址 | `-z, --zookeeper` 参数或 `ZK_HOSTS` 环境变量 | `127.0.0.1:2181` |
| 实例 ID | `-i, --instance-id` 参数或 `~/.claude-orchestrator/config.json` | `register` 后自动保存 |
| MCP 服务端地址 | `--host` 参数或 `ORCHESTRATOR_HOST` 环境变量 | `127.0.0.1` |
| MCP 服务端端口 | `--port` 参数或 `ORCHESTRATOR_PORT` 环境变量 | `3100` |

---

## 项目结构

```
├── src/
│   ├── index.ts               # CLI 入口 (commander)
│   ├── server.ts              # MCP 服务端 — 18 工具, 5 资源, 2 提示
│   ├── config.ts              # 配置管理
│   ├── cli/
│   │   └── commands.ts        # CLI 子命令实现
│   ├── zk/
│   │   ├── client.ts          # ZooKeeper 连接管理
│   │   ├── paths.ts           # ZK 路径常量
│   │   └── watcher.ts         # ZK Watch 管理器
│   ├── modules/
│   │   ├── registry.ts        # 实例注册
│   │   ├── task-queue.ts      # 任务队列（原子认领）
│   │   ├── message-router.ts  # 消息路由 + 长轮询
│   │   └── context-store.ts   # 共享键值存储
│   ├── models/
│   │   └── schemas.ts         # Zod 模式 + 推断类型
│   └── utils/
│       └── output.ts          # CLI 输出格式化
├── bin/
│   └── claude-orchestrator     # npm CLI 入口 (Node.js)
├── scripts/
│   ├── start-zk.sh             # Docker ZK 启动器
│   ├── start-server.sh         # 服务端启动器
│   ├── stop-all.sh             # 一键停止
│   └── publish.sh              # npm 发布流程
├── skills/                     # Claude Code 技能
├── docs/
│   ├── v0.1.0/                 # 存档：Python v0.1.0 文档
│   └── v0.2.0/                 # 当前 TypeScript 文档
│       ├── prd/                # 完整规格 + 架构
│       └── operations-guide.md # 分步操作手册
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
  <sub>基于 TypeScript、ZooKeeper 和 MCP 协议构建。请负责任地编排。</sub>
</p>
