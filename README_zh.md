# Claude Orchestrator

<p align="center">
  <strong>将多个 Claude Code 实例编排成一支协作的 AI 团队 —— 基于 ZooKeeper 分布式协调。</strong>
  <br/>
  <em><a href="README.md">English Documentation</a></em>
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

**Claude Orchestrator** 将多个 Claude Code 实例作为一支 AI 团队运行。每个 Worker 在独立的 git worktree 中以拟人化名称（Tom、Jerry、Lucy 等）运行，通过 `claude -p` 自动处理分配的任务，完成后自评估并发送结构化决策给 Leader。Leader 运行只读 TUI，按 Plan → Build → Verify → Review → Accept 责任链机械路由任务。

底层通过 ZooKeeper 实现分布式协调：临时节点管理心跳，顺序节点保证 FIFO 排序，Watch 机制实现实时通知。零外部数据库 —— 所有状态都在 ZooKeeper 中。

```
┌──────────────────────────────────────────────────────┐
│                     ZooKeeper                         │
│     /leader  /instances  /tasks  /messages            │
└────────┬────────────────┬────────────────┬────────────┘
         │                │                │
    ┌────┴────┐      ┌────┴────┐      ┌────┴────┐
    │ Leader  │      │ Worker  │      │ Worker  │
    │  (TUI)  │      │(worktree)│     │(worktree)│
    │  Tom    │      │  Jerry   │      │  Lucy   │
    │planner  │      │ builder  │      │verifier │
    └─────────┘      └─────────┘      └─────────┘
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

### 3. 一键启动

```bash
claude-orchestrator run --worker 5
```

一条命令完成所有初始化：
- 为每个 Worker 创建独立的 git worktree（`.claude-orchestrator/worktree/{name}/`）
- 分配拟人化名称（Tom、Jerry、Lucy、Thomas、Jack...）和角色（planner、builder、verifier、reviewer、accepter）
- 将 agent 模板和 skills 复制到每个 worktree
- 启动 Leader TUI
- 派生 Worker 子进程（各自在独立 worktree 中运行）

### 4. 开始使用

在 TUI 输入行输入需求并按回车。Leader 将其转发给 Planner Worker，Planner 将其拆解为责任链。每个 Worker 处理自己的环节，自评估后 Leader 路由到下一环节。

```bash
# CLI 命令（可从任意终端执行）
claude-orchestrator push-task --title "实现登录接口" --priority 0
claude-orchestrator send-message --to-name Jerry --content "开始写认证模块了吗？"
claude-orchestrator list-tasks --status pending
```

---

## 架构

### Leader-Worker 模型（v0.4）

| 组件 | 功能 | ZK 魔法 |
|------|------|---------|
| **Leader** | 只读 TUI，机械消息/任务路由，合并验证，孤儿任务恢复。不调用 AI。 | `/leader` EPHEMERAL — 同时只有一个 Leader |
| **Worker** | 独立 git worktree，ZK Watch 循环，通过 `claude -p` 自动处理消息，自评估输出，自动提交变更 | EPHEMERAL 临时节点 → 断线自动清理 |
| **任务队列** | 推送 → 认领 → 完成（或阻塞/失败/重试）。角色匹配优先级排序。 | 顺序节点保证 FIFO，临时节点实现原子锁 |
| **消息路由** | 点对点消息传递 | 持久顺序节点 + ZK Watch 推送 |

### Worktree 隔离

每个 Worker 在 `.claude-orchestrator/worktree/{name}/` 下拥有独立的 `git worktree`，提供：
- **独立工作目录** — 无文件冲突
- **专属 git 分支** — `claude-orchestrator/{name}-workspace`
- **个人 CLAUDE.md** — `.claude-orchestrator/docs/{name}/CLAUDE.md` 定义角色规则
- **每日目录记忆** — `.claude-orchestrator/docs/{name}/YYYY-MM-DD/CLAUDE.md` 跨会话保持上下文

### CLI 原生 — 零 MCP 服务器

Leader 和 Worker 各自直连 ZooKeeper。Leader 是纯路由器：转发需求、从 ChainDef JSON 创建任务、机械执行 EvalDecision JSON。所有 AI 智能只在 Worker 端通过 `claude -p` 运行。无 HTTP、无 SSE、无 MCP 协议。

### 责任链闭环

```
Plan → Build → Verify → Review → Accept
```

每个环节由专属角色负责。一个人产出，下一个人验证 —— 形成 **责任链闭环**。每个产出物写入 `.claude-orchestrator/docs/{name}/YYYY-MM-DD/`，下一环节从该目录读取。每个环节内置自评估机制，确保每个步骤的质量。

---

## CLI 命令

| 命令 | 功能 |
|------|------|
| `run --worker <n>` | 启动完整编排：Leader TUI + N 个 Worker（含 worktree 隔离） |
| `unregister` | 显式注销实例 |
| `push-task` | 创建任务（可指定分配给某人） |
| `claim-task` | 认领下一个任务 —— 原子操作，不会重复认领 |
| `complete-task` | 标记任务完成并提交结果 |
| `list-tasks` | 按状态查看任务 |
| `task-block` | 标记任务为阻塞（附原因） |
| `task-fail` | 标记任务为失败（附原因） |
| `task-retry` | 重新入队失败任务（retry_count + 1，最多 3 次） |
| `send-message` | 向指定实例发送消息 |
| `poll-message` | 检查收件箱 |
| `delete-message` | 删除收件箱中的消息 |
| `config` | 查看当前配置 |

---

## 目录记忆（CLAUDE.md）

Claude Orchestrator 使用三层 **CLAUDE.md** 体系作为目录记忆：

| 层次 | 位置 | 内容 |
|------|------|------|
| **团队级** | Worktree 根目录 `CLAUDE.md` | 团队角色、目录结构、责任链流程、Git 规则 |
| **个人级** | `.claude-orchestrator/docs/{name}/CLAUDE.md` | 角色流程、产出标准、沟通规则、禁止行为 |
| **每日级** | `.claude-orchestrator/docs/{name}/YYYY-MM-DD/CLAUDE.md` | 会话上下文、任务进度、决策记录、阻塞项 |

第 1、2 层在 worktree 创建时从模板生成。第 3 层由 Worker 在任务执行中自行创建和维护 —— prompt 模板指引 Claude 管理自己的每日记忆。

---

## 模板结构

```
templates/
├── agents/                          ← Worker prompt 模板
│   ├── worker-decompose.md          #   需求 → 责任链拆解
│   ├── worker-plan.md               #   Planner：蓝图设计
│   ├── worker-build.md              #   Builder：可追溯实施
│   ├── worker-verify.md             #   Verifier：交叉验证 Plan vs Build
│   ├── worker-review.md             #   Reviewer：链路级质量把关
│   ├── worker-accept.md             #   Accepter：最终 Go/No-Go 决策
│   └── worker-evaluate.md           #   每个环节的自评估
└── claude-memory/                   ← 目录记忆模板
    ├── team-claude.md               #   工作区级 CLAUDE.md
    ├── personal-claude-planner.md   #   Planner 角色规范
    ├── personal-claude-builder.md   #   Builder 角色规范
    ├── personal-claude-verifier.md  #   Verifier 角色规范
    ├── personal-claude-reviewer.md  #   Reviewer 角色规范
    └── personal-claude-accepter.md  #   Accepter 角色规范
```

Worker 模板保持精炼 —— 提供任务上下文和关键指令后，引导 Worker 读取对应的 skill 文件（`.claude/skills/{skill}/SKILL.md`）获取详细流程。这确保 prompt 聚焦，防止 LLM 注意力分散。

---

## 内置 Skills

| Skill | 角色 | 功能 |
|-------|------|------|
| `task-planning` | Planner | 分析需求、定义蓝图、拆解任务 |
| `task-execution` | Builder | 认领任务、按蓝图实施、可追溯提交 |
| `task-verification` | Verifier | 独立验证 Builder 输出是否符合 Plan 标准 |
| `task-review` | Reviewer | 审核完整链路（Plan→Build→Verify）的设计一致性 |
| `task-acceptance` | Accepter | 按业务标准验证最终交付物，签署 Go/No-Go |
| `task-traceability` | 基础层 | Trace → Execute → Map → Evidence → Record — 所有角色共用 |

---

## ZooKeeper 节点结构

```
/claude-orchestrator
├── leader                     [EPHEMERAL] Leader 元数据
├── instances/{id}             [EPHEMERAL] 实例元数据
├── tasks/
│   ├── pending/task-NNNNN     [PERSISTENT_SEQUENTIAL]
│   ├── claimed/{insId}-task-NNNNN [EPHEMERAL] ← 原子锁
│   └── completed/task-NNNNN   [PERSISTENT]
└── messages/{instanceId}/msg-NNNNN [PERSISTENT_SEQUENTIAL]
```

---

## 为什么选择 ZooKeeper？

| 关注点 | ZooKeeper 的答案 |
|--------|-----------------|
| 实例生命周期 | 临时节点 → 崩溃自动清理 |
| 任务排序 | 顺序节点 → 保证 FIFO |
| 认领原子性 | `create(path, ephemeral=true)` 在 ZK 层面是原子的 —— 只有一个赢家 |
| Leader 选举 | `/leader` EPHEMERAL → 保证只有一个 Leader |
| 变更通知 | 内置 Watch → 推送，而非轮询 |
| 依赖项 | 一个依赖（ZK）。无需数据库，无需 HTTP 服务器 |

---

## 角色

| 角色 | 值 | 典型职责 |
|------|-----|---------|
| Leader | `leader` | 运行 TUI，机械路由，合并验证，孤儿任务恢复 |
| Planner | `planner` | 拆解需求，定义蓝图 |
| Builder | `builder` | 按蓝图实施，产出可追溯证据 |
| Verifier | `verifier` | 对照 Plan 交叉检查 Builder 输出 |
| Reviewer | `reviewer` | 全链路设计一致性质检 |
| Accepter | `accepter` | 对照业务标准的最终 Go/No-Go 决策 |

---

## 安装与开发

### 环境要求

- Node.js 18+
- Docker（用于 ZooKeeper）
- Claude Code CLI（用于 Worker 消息处理）

### 源码安装

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server

npm install
docker-compose up -d
npm run build

# 启动 3 个 Worker
node dist/index.js run --worker 3
```

### 运行测试

```bash
npm test                    # 全部单元测试（110+）
npm run test:watch          # Watch 模式
npx vitest run tests/unit/worker-prompt-rendering.test.ts  # Prompt 渲染验证
```

---

## 项目结构

```
├── src/
│   ├── index.ts                   # CLI 入口（commander）
│   ├── config.ts                  # 配置分层（全局 + 项目）
│   ├── orchestrator/
│   │   └── run.ts                 # 统一 run 编排器（5 阶段启动）
│   ├── leader/                    # Leader 节点
│   │   ├── index.ts               #   启动 / 关闭编排
│   │   ├── tui.ts                 #   ANSI TUI + Worker Messages 面板
│   │   ├── event-bus.ts           #   类型化 EventEmitter（15 个事件）
│   │   ├── state.ts               #   LeaderState 中心状态
│   │   ├── monitor.ts             #   WorkerMonitor — 上下线检测
│   │   ├── orchestrator.ts        #   TaskOrchestrator — 任务生命周期
│   │   ├── recovery.ts            #   TaskRecovery — 孤儿恢复（最多 3 次重试）
│   │   ├── watcher.ts             #   LeaderWatcher — 消息处理
│   │   ├── chain-router.ts        #   ChainRouter — 机械路由（无 AI 调用）
│   │   └── merge-validator.ts     #   交叉验证 + 合并 Worker 分支
│   ├── worker/                    # Worker 节点
│   │   ├── worktree-initializer.ts#   名称生成、worktree 创建、角色分配
│   │   ├── child.ts               #   子进程入口
│   │   ├── child-runner.ts        #   子进程核心（chdir → ZK → Watcher）
│   │   ├── watcher.ts             #   WorkerWatcher — ZK Watch 循环 + 编排
│   │   ├── evaluator.ts           #   SelfEvaluator — 内置自评估（最多 3 次重试）
│   │   └── commit-checker.ts      #   任务完成后自动提交
│   ├── executor/                  # 模板执行引擎
│   │   ├── template.ts            #   TemplateEngine — 加载 + 名片 + 渲染
│   │   └── runner.ts              #   ClaudeRunner — CLI 执行封装
│   ├── zk/
│   │   ├── client.ts              # ZooKeeper 连接管理
│   │   └── paths.ts               # ZK 路径常量
│   ├── modules/
│   │   ├── registry.ts            # 实例注册
│   │   ├── task-queue.ts          # 任务队列（push/claim/complete/block/fail/retry）
│   │   └── message-router.ts      # 消息路由 + 模板渲染
│   ├── models/
│   │   └── schemas.ts             # Zod 模式（Instance, Task, Message, ChainDef, EvalDecision）
│   └── utils/
│       ├── exec.ts                # Shell 执行工具（execWithTee）
│       └── logger.ts              # 标记化日志（+ --debug 模式）
├── templates/                     # Prompt 与记忆模板（v0.4）
│   ├── agents/                    #   7 个 Worker prompt 模板
│   └── claude-memory/             #   6 个 CLAUDE.md 目录记忆模板
├── skills/                        # Claude Code 技能（8 个）
│   ├── task-traceability/         #   基础层
│   ├── task-planning/             #   Planner 技能
│   ├── task-execution/            #   Builder 技能
│   ├── task-verification/         #   Verifier 技能
│   ├── task-review/               #   Reviewer 技能
│   ├── task-acceptance/           #   Accepter 技能
│   ├── claude-orchestrator/       #   CLI 参考
│   └── claude-code-developer/     #   Claude Code 开发者参考
├── docs/
│   ├── v0.4/
│   │   ├── design.md              #   v0.4 完整设计文档
│   │   ├── CLAUDE.md              #   v0.4 变更摘要
│   │   └── worker-init/
│   │       └── design.md          #   Worker 初始化 + 目录记忆设计
│   └── v0.3/                      #   存档：v0.3 文档
├── tests/
│   ├── unit/                      #   11 个测试文件，110+ 测试
│   │   └── worker-prompt-rendering.test.ts  # Prompt 变量替换验证
│   └── integration/               #   Leader-Worker 集成测试
├── examples-workspace/            # 多智能体模式参考实现
├── docker-compose.yml             # ZooKeeper
├── package.json
└── tsconfig.json
```

---

## 配置参考

| 配置项 | 位置 | 默认值 |
|--------|------|--------|
| ZK 地址 | `-z, --zookeeper` 参数或 `ZK_HOSTS` 环境变量 | `127.0.0.1:2181` |
| 实例 ID | 每个 Worker 自动生成 | 保存在 `.claude-orchestrator/config.json` |
| Claude 命令 | `config.json` → `commands.claude-cli` | `claude --dangerously-skip-permissions --permission-mode dontAsk` |
| 缓存目录 | `config.json` → `cache_dir` | `~/.claude-orchestrator/sessions` |

---

## License

MIT — 随便用，随便改，随便发。

---

<p align="center">
  <sub>基于 TypeScript 和 ZooKeeper 构建。请负责任地编排。</sub>
</p>
