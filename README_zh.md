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
  <img src="https://img.shields.io/badge/pnpm-workspaces-orange" alt="pnpm">
  <img src="https://img.shields.io/badge/ZooKeeper-3.8%2B-orange" alt="zookeeper">
  <img src="https://img.shields.io/badge/protocol-v0.5.0-purple" alt="protocol">
</p>

---

## 这是什么？

**Claude Orchestrator** 将多个 Claude Code 实例作为一支 AI 团队运行。每个 Worker 在独立的 git worktree 中以拟人化名称（Tom、Jerry、Lucy 等）运行，通过 `claude -p` 自动处理分配的任务，使用 `--fork-session` 自评估输出，并向 Leader 回报一份 4 态判别联合的 `EvalDecision`。Leader 运行交互式 TUI（输入行 + Tab/1–9 切换 Worker），按 **Plan → Build → Verify → Review → Accept** 责任链机械路由任务。

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

## v0.5 新增

| 维度 | 改动 |
|------|------|
| 工程结构 | 单一 `src/` → **8 个严格分层的 pnpm workspace 包**（`@co/contracts` → `@co/cli`），由 `dependency-cruiser` 强制约束 |
| 类型系统 | 全部 ID 改为 **branded 类型**（`InstanceId / TaskId / MessageId / ChainId / SessionId / WorktreeName / ProjectId / ZkPath`），并引入 `PROTOCOL_VERSION = "0.5.0"` 握手 |
| EvalDecision | 升级为 **4 态判别联合**：`activate_next` / `feedback` / `reject` / `close_chain` |
| MergeDecision | **新增 Schema**：`merge` / `skip` / `review_first`，遇冲突自动 `merge --abort` |
| MessageType | 扩展到 6 类（新增 `task_dispatch` / `completion_report` / `user_input`） |
| 会话续接 | ClaudeRunner 支持主任务 → commit → eval 通过 `--resume` 共享 session；评估重试使用 `--fork-session` 摆脱格式错误锚定 |
| TUI 三段拆分 | `tui/renderer.ts`（纯函数）+ `tui/input.ts`（键盘事件源）+ `tui/controller.ts`（订阅与 IO） |
| Worker 隔离 | `worktree-initializer` 从 `@co/worker` 迁入 `@co/orchestrator`；新增 `ChildSupervisor`，max-3 次重启 + `process.kill(ppid, 0)` 父进程存活检测 |
| TaskQueue | 新增 `ITaskQueue.watchPending / watchClaimed / getPending` 接口 —— Leader 不再直接接触 `IZkClient` |
| 角色权重 | `ROLE_WEIGHTS` 矩阵替换硬编码 role→link 映射；Leader（`role: leader`）权重全 0，不参与普通任务认领 |
| 错误层级 | `CoError` 类层级，含 11 个稳定 `code`（`ZK_SESSION_EXPIRED`、`ORPHAN_RETRY_EXHAUSTED`…） |
| 多项目命名空间 | `zkPaths` 支持可选 `project_id`：未传 → `/claude-orchestrator/...`；传入 → `/co/{project_id}/...` |
| CLI 收敛 | 保留 2 条命令 —— `run` 与 `config`；其他操作改由 TUI 输入行驱动 |

---

## 快速开始

### 1. 安装

```bash
# 推荐：从源码安装（当前包为私有 workspace）
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server
pnpm install
pnpm -r build
```

### 2. 启动 ZooKeeper

```bash
docker-compose up -d
```

### 3. 一键启动

```bash
node bin/claude-orchestrator run --worker 5
```

一条命令完成所有初始化：
- 执行 6 步 `InitChecker`（Safe / Caution / Danger 三级风险闸口 + `init_status` 历史决策）
- 为每个 Worker 创建独立的 git worktree（`.claude-orchestrator/worktree/{name}/`）
- 分配拟人化名称（Tom、Jerry、Lucy、Thomas、Jack...）和角色（planner、builder、verifier、reviewer、accepter）
- 将 agent 模板和 skills 复制到每个 worktree
- 启动 Leader TUI
- 通过 `ChildSupervisor` 派生 Worker 子进程（独立 worktree、崩溃后最多重启 3 次、父进程退出时自动终止）

### 4. 开始使用

在 TUI 输入行输入需求并按回车。Leader 将其转发给 Planner Worker（若 `worker-decompose.md` 模板可用则自行处理），拆解为 `ChainDef`。每个 Worker 处理自己的环节，通过 `--fork-session` 自评估后，Leader 根据 `EvalDecision` JSON 路由下一环节。

```bash
# 查看解析后的配置（含 protocol_version）
node bin/claude-orchestrator config

# 查看版本号 + 协议标签
node bin/claude-orchestrator --version
# → 0.5.0 (protocol 0.5.0)
```

---

## 架构

### 8 包 Workspace（v0.5）

`dependency-cruiser` 强制单向分层依赖：

| 层 | 包 | 职责 | 允许依赖 |
|----|----|------|----------|
| 0 | `@co/contracts` | Branded IDs、Zod schema、接口、错误类、`ROLE_WEIGHTS`、`zkPaths` / `cachePaths`、`PROTOCOL_VERSION` | `zod`（peer） |
| 1 | `@co/infra` | `IZkClient` 实现、`Logger`、exec 工具、`ConfigLoader` | contracts、`node-zookeeper-client` |
| 2 | `@co/runtime` | `ClaudeRunner`（支持 `--resume` / `--fork-session`）、`TemplateEngine`、`HookEngine`（闭合 `HookEvent` 联合） | contracts、infra |
| 3 | `@co/coordination` | `TaskQueue`（含 `watchPending` / `watchClaimed`）、`MessageRouter`、`InstanceRegistry` | contracts、infra |
| 4a | `@co/leader` | EventBus、State、ChainRouter、MergeValidator、Recovery、Monitor、TaskOrchestrator、Watcher、StreamTailer、TUI（renderer/input/controller） | contracts、runtime、coordination |
| 4b | `@co/worker` | WorkerWatcher（8 步流水线）、SelfEvaluator、CommitChecker | contracts、runtime、coordination |
| 5 | `@co/orchestrator` | `run.ts` 5 阶段启动、`InitChecker`、`WorktreeInitializer`、`ChildSupervisor` | contracts、infra、runtime、coordination、leader、worker |
| 6 | `@co/cli` | `commander` 入口、`run` + `config` 命令 | contracts、infra、coordination、orchestrator |

Leader（4a）与 Worker（4b）同层，**互不直接 import**；必须通过 `@co/coordination` 提供的接口经由 ZK 通信。

### Leader-Worker 模型

| 组件 | 功能 | ZK 魔法 |
|------|------|---------|
| **Leader** | 交互式 TUI（输入行、Tab/1–9 切换 Worker），机械消息/任务路由，合并验证，孤儿任务恢复。当 `worker-decompose.md` 模板可用时自行处理需求拆解，否则转发 Planner。 | `/leader` EPHEMERAL —— 同时只有一个 Leader，节点数据含 `protocol_version` |
| **Worker** | 独立 git worktree，ZK Watch 循环，通过 `claude -p` 自动处理消息，使用 `--fork-session` 自评估，使用 `--resume` 自动提交 | `/instances/{id}` EPHEMERAL → 断线自动清理 |
| **任务队列** | 推送 → 认领 → 完成（或阻塞/失败/重试）。基于 `ROLE_WEIGHTS` 的认领排序。 | 顺序节点保证 FIFO，临时节点实现原子锁。Claim 节点数据内嵌 `task_snapshot` 便于崩溃恢复。 |
| **消息路由** | 点对点消息传递（通过 ZK Watch） | 持久顺序节点 + 推送通知 |

### Worker 8 步流水线

```
1. 解析消息（link / task_id / chain_id）
2. 按 link 选择模板（worker-{plan|build|verify|review|accept}.md）
3. 触发 worker_message_start 钩子
4. 渲染模板 + 身份提示（通过 --append-system-prompt 注入）
5. 执行主任务 → ClaudeRunner.run() → sessionId
6. CommitChecker.check() 使用 --resume sessionId（自动提交）
7. SelfEvaluator.evaluate() 使用 --resume + --fork-session（解析失败最多重试 3 次）
8. 向 Leader 发送 completion_report（EvalDecision JSON + commit 信息）
```

### Worktree 隔离

每个 Worker 在 `.claude-orchestrator/worktree/{name}/` 下拥有独立的 `git worktree`，提供：
- **独立工作目录** —— 无文件冲突
- **专属 git 分支** —— `claude-orchestrator/{name}-workspace`
- **个人 CLAUDE.md** —— `.claude-orchestrator/docs/{name}/CLAUDE.md` 定义角色规则
- **每日目录记忆** —— `.claude-orchestrator/docs/{name}/YYYY-MM-DD/CLAUDE.md` 跨会话保持上下文

### 责任链闭环

```
Plan → Build → Verify → Review → Accept
```

每个环节由专属角色负责。一个人产出，下一个人验证 —— 形成 **责任链闭环**。每个产出物写入 `.claude-orchestrator/docs/{name}/YYYY-MM-DD/`，下一环节从该目录读取。每个环节内置自评估机制，通过 `EvalDecision` 决定后续路由：

| `EvalDecision.decision` | 效果 |
|-------------------------|------|
| `activate_next` | Leader 创建下一环节任务并派发 |
| `feedback` | Leader 将反馈文本转发给指定 Worker 进行返工 |
| `reject` | 链路以失败终结 |
| `close_chain` | 链路以成功终结（accept 环节常规走向） |

---

## CLI 命令（v0.5）

CLI 入口刻意精简 —— 编排在 TUI 内完成：

| 命令 | 功能 |
|------|------|
| `run --worker <n>` | 一键编排：6 步 InitChecker、worktree 创建、Leader TUI、派生 N 个 Worker |
| `config` | 输出解析后的配置（ZK、缓存目录、命令、协议版本） |

公共参数：
- `-z, --zookeeper <hosts>` —— ZooKeeper 连接串（环境变量 `ZK_HOSTS`）；默认 `127.0.0.1:2181`
- `-d, --debug` —— 启用调试日志
- `-y, --yes`（仅 `run`） —— 跳过 `InitChecker` 交互提示，按 `init_status` 历史自动决策

---

## 目录记忆（CLAUDE.md）

Claude Orchestrator 使用三层 **CLAUDE.md** 体系作为目录记忆：

| 层次 | 位置 | 内容 |
|------|------|------|
| **团队级** | Worktree 根目录 `CLAUDE.md` | 团队角色、目录结构、责任链流程、Git 规则 |
| **个人级** | `.claude-orchestrator/docs/{name}/CLAUDE.md` | 角色流程、产出标准、沟通规则、禁止行为 |
| **每日级** | `.claude-orchestrator/docs/{name}/YYYY-MM-DD/CLAUDE.md` | 会话上下文、任务进度、决策记录、阻塞项 |

第 1、2 层在 worktree 创建时由 `templates/claude-memory/` 生成。第 3 层由 Worker 在任务执行中自行创建和维护 —— prompt 模板指引 Claude 管理自己的每日记忆。

---

## 模板结构

```
templates/
├── agents/                          ← Worker prompt 模板
│   ├── worker-identity.md           #   --append-system-prompt 身份名片
│   ├── worker-decompose.md          #   需求 → ChainDef 拆解
│   ├── worker-plan.md               #   Planner：蓝图设计
│   ├── worker-build.md              #   Builder：可追溯实施
│   ├── worker-verify.md             #   Verifier：交叉验证 Plan vs Build
│   ├── worker-review.md             #   Reviewer：链路级质量把关
│   ├── worker-accept.md             #   Accepter：最终 Go/No-Go 决策
│   ├── worker-evaluate.md           #   自评估 → EvalDecision JSON
│   ├── worker-evaluate-format-hint.md  # 评估重试第 2 次起追加
│   ├── worker-commit-message.md     #   自动 commit message 生成
│   ├── worker-merge-decision.md     #   MergeDecision JSON（Leader 侧）
│   └── worker-task-doc.md           #   单任务 markdown 文档生成
└── claude-memory/
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
| `task-traceability` | 基础层 | Trace → Execute → Map → Evidence → Record —— 所有角色共用 |
| `claude-orchestrator` | 全员 | CLI 参考 |
| `claude-code-developer` | 全员 | Claude Code 开发者参考 |

---

## ZooKeeper 节点结构

```
/claude-orchestrator                      ← 若设置 project_id 则为 /co/{project_id}
├── leader                                [EPHEMERAL] LeaderNodeData（含 protocol_version）
├── instances/{id}                        [EPHEMERAL] 实例元数据（含 protocol_version）
├── tasks/
│   ├── pending/task-NNNNN                [PERSISTENT_SEQUENTIAL]
│   ├── claimed/{insId}-task-NNNNN        [EPHEMERAL] ← 原子锁 + ClaimRecord（含 task_snapshot）
│   └── completed/task-NNNNN              [PERSISTENT]
└── messages/{instanceId}/msg-NNNNN       [PERSISTENT_SEQUENTIAL]
```

`PROTOCOL_VERSION`（当前 `0.5.0`）同时写入 `/leader` 和每个 `/instances/{id}` 节点 —— 跨版本握手会显式失败而非默默损坏数据。

---

## 为什么选择 ZooKeeper？

| 关注点 | ZooKeeper 的答案 |
|--------|-----------------|
| 实例生命周期 | 临时节点 → 崩溃自动清理 |
| 任务排序 | 顺序节点 → 保证 FIFO |
| 认领原子性 | `create(path, ephemeral=true)` 在 ZK 层面是原子的 —— 只有一个赢家 |
| Leader 选举 | `/leader` EPHEMERAL → 保证只有一个 Leader |
| 变更通知 | 内置 Watch → 推送，而非轮询（`@co/coordination` 在每次触发后重新挂载以实现持久语义） |
| 依赖项 | 一个依赖（ZK）。无需数据库，无需 HTTP 服务器 |

---

## 角色与 ROLE_WEIGHTS

`ITaskQueue.claim()` 按以下键排序待认领任务：
1. 硬指派 `assigned_to === claimer` 优先
2. `ROLE_WEIGHTS[claimer.role][task.link]` DESC（本职环节 = 100，其他 10-20；非 leader 永不为 0）
3. `task.priority` ASC（HIGH = 0）
4. 任务 ID FIFO

| 角色 | 值 | 本职 link 权重 | 典型职责 |
|------|-----|------|---------|
| Leader | `leader` | 全部为 0 | 运行 TUI、机械路由、合并验证、孤儿任务恢复 —— **不参与普通任务认领** |
| Planner | `planner` | `plan` = 100 | 拆解需求，定义蓝图 |
| Builder | `builder` | `build` = 100 | 按蓝图实施，产出可追溯证据 |
| Verifier | `verifier` | `verify` = 100 | 对照 Plan 交叉检查 Builder 输出 |
| Reviewer | `reviewer` | `review` = 100 | 全链路设计一致性质检 |
| Accepter | `accepter` | `accept` = 100 | 对照业务标准的最终 Go/No-Go 决策 |

角色是 **认领偏好，不是身份** —— 任何非 leader Worker 都可在权重次优时兜底认领其他环节。

---

## 安装与开发

### 环境要求

- Node.js 18+
- pnpm 10+
- Docker（用于 ZooKeeper）
- Claude Code CLI（用于真实 Worker 消息处理）

### 源码安装

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server

pnpm install
docker-compose up -d
pnpm -r build

# 启动 3 个 Worker
node bin/claude-orchestrator run --worker 3
```

### 构建与校验

```bash
pnpm -r build         # 全部 8 个包按拓扑顺序 tsc -b（project references）
pnpm typecheck        # pnpm -r exec tsc --noEmit
pnpm depcheck         # dependency-cruiser 分层隔离规则
pnpm pkgcheck         # 每个 package.json 的依赖白名单
```

### 运行测试

测试遵循 `tests/CLAUDE.md` 规范 —— 每个包持有自己的 `tests/CLAUDE.md`（根文件原文复制）加上 `tests/core/{unit,integration,e2e,manual}/` 与临时的 `tests/scratch/YYYY-MM-DD/<feature>/` 目录。`tests/core/` 下每个文件都带 `CORE-RETENTION` 头注释；任何 mock 都带 `TRUST-JUSTIFICATION`。

```bash
pnpm test                                                # 跨所有包跑 vitest run
pnpm --filter @co/contracts test                         # 单包测试
pnpm --filter @co/leader test:watch                      # watch 模式
node packages/runtime/tests/core/manual/claude-cli-smoke.mjs   # 手动烟雾测试（需真实 claude-cli）
```

---

## 项目结构

```
├── packages/                            # pnpm workspace 包（v0.5）
│   ├── contracts/                       #   Layer 0 —— Branded IDs、schemas、接口、错误、路径函数
│   ├── infra/                           #   Layer 1 —— ZkClient、Logger、ConfigLoader、exec 工具
│   ├── runtime/                         #   Layer 2 —— TemplateEngine、ClaudeRunner、HookEngine
│   ├── coordination/                    #   Layer 3 —— TaskQueue（含 watch*）、MessageRouter、InstanceRegistry
│   ├── leader/                          #   Layer 4a —— EventBus、State、ChainRouter、MergeValidator、
│   │                                    #              Recovery、Monitor、TaskOrchestrator、Watcher、
│   │                                    #              StreamTailer、TUI（renderer / input / controller）
│   ├── worker/                          #   Layer 4b —— WorkerWatcher（8 步流水线）、SelfEvaluator、
│   │                                    #              CommitChecker
│   ├── orchestrator/                    #   Layer 5 —— run.ts 5 阶段、InitChecker、WorktreeInitializer、
│   │                                    #              ChildSupervisor
│   └── cli/                             #   Layer 6 —— commander 入口，run + config 命令
│
├── templates/                           # Prompt 与目录记忆模板
│   ├── agents/                          #   12 个 Worker prompt 模板
│   └── claude-memory/                   #   6 个 CLAUDE.md 目录记忆模板
│
├── skills/                              # Claude Code 技能（8 个）
│   ├── task-traceability/               #   基础层
│   ├── task-planning/                   #   Planner 技能
│   ├── task-execution/                  #   Builder 技能
│   ├── task-verification/               #   Verifier 技能
│   ├── task-review/                     #   Reviewer 技能
│   ├── task-acceptance/                 #   Accepter 技能
│   ├── claude-orchestrator/             #   CLI 参考
│   └── claude-code-developer/           #   Claude Code 开发者参考
│
├── docs/
│   └── v0.7/                            #   v0.7 文档基线
│       ├── prd/                         #     8 篇产品需求（01-overview ~ 07-glossary + README）
│       └── dd/                          #     11 篇详细设计（00-README + 01-architecture ~ 10-magic-loop）
│

├── tests/
│   └── CLAUDE.md                        #   测试权威规范（被各包原文复制）
│
├── scripts/
│   └── check-pkg-deps.mjs               # 每个包依赖白名单校验
│
├── .dependency-cruiser.cjs              # 分层隔离规则（7 条禁止 pattern）
├── pnpm-workspace.yaml                  # workspace 包通配
├── tsconfig.base.json                   # 公共编译选项
├── tsconfig.json                        # 根 references → 8 个包
├── docker-compose.yml                   # ZooKeeper
├── bin/claude-orchestrator              # CLI 入口 → packages/cli/dist/index.js
└── package.json                         # 根脚本：build / typecheck / depcheck / pkgcheck / test
```

---

## 配置参考

`@co/infra/ConfigLoader` 按以下 5 层合并（高优先级覆盖低优先级）：

1. CLI 参数（`-z`、`-d`）
2. 环境变量（`ZK_HOSTS`、`CO_CACHE_DIR`…）
3. 当前 worktree 的 `.claude-orchestrator/config.json`（位于 worktree 内时）
4. 项目根 `.claude-orchestrator/config.json`
5. 全局 `~/.claude-orchestrator/config.json`

| 配置项 | 位置 | 默认值 |
|--------|------|--------|
| ZK 地址 | `-z, --zookeeper` 参数或 `ZK_HOSTS` 环境变量 | `127.0.0.1:2181` |
| 多项目命名空间 | 配置中 `zookeeper.project_id` | 未设置 → `/claude-orchestrator/...`；设置 → `/co/{project_id}/...` |
| 实例 ID | 每个 Worker 自动生成 | 保存在 `.claude-orchestrator/config.json` |
| Claude 命令 | `commands.claude_cli` | `claude --dangerously-skip-permissions --permission-mode dontAsk` |
| Git 命令 | `commands.git` | `git` |
| 缓存目录 | `cache_dir` | `.claude-orchestrator/sessions` |
| Hooks | `hooks[]` 数组 | 空 |

---

## License

MIT —— 随便用，随便改，随便发。

---

<p align="center">
  <sub>基于 TypeScript、pnpm workspaces 和 ZooKeeper 构建。请负责任地编排。</sub>
</p>
