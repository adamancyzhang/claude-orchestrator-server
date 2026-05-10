# Claude Orchestrator

<p align="center">
  <strong>将多个 Claude Code 实例编排成一支协作的 AI 团队 —— 基于 ZooKeeper 分布式协调。</strong>
  <br/>
  <em>Turn Claude Code instances into a multi-agent swarm — coordinated through ZooKeeper.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@adamancyzhang/claude-orchestrator"><img src="https://img.shields.io/npm/v/@adamancyzhang/claude-orchestrator?color=blue" alt="npm"></a>
  <a href="https://github.com/adamancyzhang/claude-orchestrator-server"><img src="https://img.shields.io/github/license/adamancyzhang/claude-orchestrator-server" alt="license"></a>
  <a href="https://pypi.org/project/claude-mcp-server/"><img src="https://img.shields.io/pypi/v/claude-mcp-server?color=yellow" alt="PyPI"></a>
  <img src="https://img.shields.io/badge/python-3.12%2B-blue" alt="python">
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
    │  Tom 🧑  │          │ Jerry 🧑 │          │  Bob 🧑  │
    │ 架构师   │          │ 开发者   │          │ 测试    │
    └─────────┘          └─────────┘          └─────────┘
```

---

## 快速开始

### 1. 安装命令行工具

```bash
# 一条命令，全平台支持
npm install -g @adamancyzhang/claude-orchestrator
```

安装时自动下载匹配你操作系统和架构的原生二进制文件（macOS/Linux, arm64/x64）。如果没有匹配的预编译包，运行 `scripts/build-binary.sh` 本地构建。

### 2. 启动 ZooKeeper

```bash
docker-compose up -d
```

### 3. 启动 MCP 服务端

```bash
# 从源码运行
pip install -e ".[dev]"
python -m src.server
# → 服务监听在 http://127.0.0.1:3100
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
| **实例注册** | 注册、心跳、发现 | 临时节点 → 断线自动清理 |
| **任务队列** | 推送 → 认领 → 完成 | 顺序节点保证 FIFO，临时认领节点实现原子锁 |
| **消息路由** | 点对点消息、广播、求助 | 持久顺序节点，基于轮询的检索 |
| **上下文存储** | 共享键值存储 | 持久节点，跨实例可见 |

### MCP 工具清单

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
| 10 | `request_help` | 向整个团队广播求助 |
| 11 | `set_context` | 写入共享键值对 |
| 12 | `get_context` | 读取共享键值对 |

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

# 共享上下文
claude-orchestrator set-context --key "api_version" --value "v2.1"

# 读取共享上下文
claude-orchestrator get-context --key "api_version"

# 健康检查
claude-orchestrator status
```

所有 CLI 命令返回 JSON 格式。每个命令都支持 `--zk-hosts`（或环境变量 `ZK_HOSTS`）以指向远程 ZooKeeper。

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
  context: "FastAPI + python-jose，用户量预期 10万 DAU"
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

- Python 3.12+
- Docker（用于 ZooKeeper）
- Node.js 18+（用于 npm CLI 封装）
- Claude Code（用于 MCP 集成）

### 源码安装

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server

# 安装 Python 依赖
pip install -e ".[dev]"

# 启动 ZooKeeper
docker-compose up -d

# 运行服务端
python -m src.server

# 或直接使用 CLI
claude-orchestrator status
```

### 构建独立二进制

```bash
bash scripts/build-binary.sh
# 输出: dist/claude-orchestrator-{platform}-{arch}
```

二进制文件是零依赖的单文件 —— Python、ZooKeeper 客户端及所有库通过 PyInstaller 打包。

### 运行测试

```bash
# 端到端 MCP 验证（需要先启动 server + ZK）
python tests/verify_mvp.py
```

---

## 内置技能

仓库内置了 Claude Code 技能，让编排器更好用。克隆后添加到 Claude Code 技能目录即可：

| 技能 | 功能 |
|------|------|
| `claude-orchestrator` | 完整 CLI 参考 —— 全部 12 条命令及示例 |
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
| 认领原子性 | `create(path, ephemeral=True)` 在 ZK 层面是原子的。只有一个赢家。 |
| 变更通知 | 内置 Watch → 推送，而非轮询。 |
| 依赖项 | 一个依赖（ZK）vs. Redis + Postgres 组合。 |

无需外部数据库。所有状态都在 ZooKeeper 中。如需超出 ZK 数据限制的归档，建议添加轻量 SQLite 日志。

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
| ZK 地址 | `--zk-hosts` 参数或 `ZK_HOSTS` 环境变量 | `127.0.0.1:2181` |
| 实例 ID | `--instance-id` 参数或 `~/.claude-orchestrator/config.json` | `register` 后自动保存 |
| MCP 服务端地址 | `src/server.py` | `127.0.0.1:3100` |

---

## 项目结构

```
├── src/
│   ├── server.py          # FastMCP 服务端 —— 12 个工具
│   ├── cli.py             # Click CLI —— 12 条命令
│   ├── zk_client.py       # ZooKeeper CRUD + 重连
│   ├── registry.py        # 实例注册 + 心跳
│   ├── task_queue.py      # 推送 → 认领 → 完成
│   ├── message_router.py  # 发送 → 轮询 → 求助
│   ├── context_store.py   # 获取 → 设置共享 KV
│   └── models.py          # Pydantic 数据模型
├── bin/
│   └── claude-orchestrator     # npm CLI 入口（Node.js 桥接）
├── scripts/
│   ├── install.js              # npm postinstall —— 下载二进制
│   ├── build-binary.sh         # PyInstaller 打包
│   ├── start-zk.sh             # Docker ZK 启动器
│   ├── start-server.sh         # 服务端启动器
│   └── stop-all.sh             # 一键停止
├── skills/                     # Claude Code 技能
├── tests/
│   └── verify_mvp.py           # 端到端 MCP 验证
├── docs/
│   ├── prd/                    # 完整规格 + 架构
│   └── operations-guide.md     # 分步操作手册
├── docker-compose.yml          # ZooKeeper
└── package.json                # npm 包定义
```

---

## License

MIT — 随便用，随便改，随便发。

---

<p align="center">
  <sub>基于 Python、ZooKeeper 和 MCP 协议构建。请负责任地编排。</sub>
</p>
