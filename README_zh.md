# Claude Orchestrator

<p align="center">
  <strong>将多个 Claude Code 实例编排成一支协作的 AI 团队 —— 基于内存消息传递协议。</strong>
  <br/>
  <em><a href="README.md">English Documentation</a></em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@adamancyzhang/claude-orchestrator"><img src="https://img.shields.io/npm/v/@adamancyzhang/claude-orchestrator?color=blue" alt="npm"></a>
  <a href="https://github.com/adamancyzhang/claude-orchestrator-server"><img src="https://img.shields.io/github/license/adamancyzhang/claude-orchestrator-server" alt="license"></a>
  <img src="https://img.shields.io/badge/node-18%2B-green" alt="node">
  <img src="https://img.shields.io/badge/typescript-5.6%2B-blue" alt="typescript">
  <img src="https://img.shields.io/badge/pnpm-workspaces-orange" alt="pnpm">
  <img src="https://img.shields.io/badge/protocol-v0.7.0-purple" alt="protocol">
</p>

---

## 这是什么？

**Claude Orchestrator** 将多个 Claude Code 实例作为一支 AI 团队运行。每个 Worker 在独立的 git worktree 中以拟人化名称（Tom、Jerry、Lucy 等）运行，通过 `claude -p` 自动处理分配的任务，使用 `--fork-session` 自评估输出，并向 Leader 回报一份 5 态判别联合的 `EvalDecision`。Leader 运行交互式 TUI（React/Ink v7，Tab/1–9 切换 Worker），按 **Plan -> Execute -> Verify -> Review -> Accept** 责任链机械路由任务。

可选的 **magic 模式**（`--magic`）会添加一个 Explorer Worker 和 `explore` 链环节。Explorer 自主分析代码库，为发现的工作产生子链（spawn_chain），Leader 管理一个链森林而非单条线性流水线。

所有协调机制 —— Leader 选举、任务队列、消息路由、实例注册 —— 均通过内存消息传递协议运行。无需任何外部数据库或服务。

```
┌──────────────────────────────────────────────────────────┐
│               内存消息传递协议                              │
│     TaskQueue  /  MessageRouter  /  InstanceRegistry      │
└────────┬────────────────┬────────────────┬────────────────┘
         │                │                │
    ┌────┴────┐      ┌────┴────┐      ┌────┴────┐
    │ Leader  │      │ Worker  │      │ Worker  │
    │  (TUI)  │      │(worktree)│     │(worktree)│
    │  Tom    │      │  Jerry   │      │  Lucy   │
    │planner  │      │ executor │      │verifier │
    └─────────┘      └─────────┘      └─────────┘
```

---

## 快速开始

### 1. 安装

```bash
npm install -g @adamancyzhang/claude-orchestrator
```

需要 Node.js 18+ 和 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`claude`）。

### 2. 一键启动

```bash
claude-orchestrator run --worker 6
```

一条命令完成所有初始化：
- 执行 `InitChecker`（配置、skills、CLAUDE.md 校验）
- 为每个 Worker 创建独立的 git worktree（`.claude-orchestrator/worktree/{name}/`）
- 分配拟人化名称（Tom、Jerry、Lucy、Thomas、Jack...）和角色（planner、executor、verifier、reviewer、accepter、explorer）
- 将 agent 模板和 skills 复制到每个 worktree
- 启动 Leader TUI
- 通过 `ChildSupervisor` 派生 Worker 子进程（独立 worktree、崩溃后最多重启 3 次、父进程退出时自动终止）

### 3. 开始使用

在 TUI 输入行输入需求并按回车。Leader 将其转发给 Planner Worker（若 `worker-decompose.md` 模板可用则自行处理），拆解为 `ChainDef`。每个 Worker 处理自己的环节，通过 `--fork-session` 自评估后，Leader 根据 `EvalDecision` JSON 路由下一环节。

```bash
# 查看解析后的配置（含 protocol_version）
claude-orchestrator config

# 查看版本号 + 协议标签
claude-orchestrator --version
# -> 0.7.0 (protocol 0.7.0)
```

---

## 架构

### 8 包 Workspace

`dependency-cruiser` 强制单向分层依赖：

| 层 | 包 | 职责 | 允许依赖 |
|----|----|------|----------|
| 0 | `@co/contracts` | Branded IDs、Zod schema、接口、错误类、`ROLE_WEIGHTS`、`PROTOCOL_VERSION` | `zod` |
| 1 | `@co/infra` | `Logger`、`ConfigLoader`（5 层合并）、exec 工具、内存消息原语 | contracts |
| 2 | `@co/runtime` | `ClaudeRunner`（支持 `--resume` / `--fork-session`）、`TemplateEngine`、`HookEngine` | contracts、infra |
| 3 | `@co/coordination` | `TaskQueue`、`MessageRouter`、`InstanceRegistry` —— 内存消息传递抽象层 | contracts、infra |
| 4a | `@co/leader` | EventBus、State、ChainRouter、MergeValidator、Recovery、TaskOrchestrator、TUI（React/Ink v7，7 面板） | contracts、runtime、coordination |
| 4b | `@co/worker` | WorkerWatcher（8 步流水线）、SelfEvaluator、CommitChecker | contracts、runtime、coordination |
| 5 | `@co/orchestrator` | `runOrchestrator()` 5 阶段启动、`InitChecker`、`WorktreeInitializer`、`ChildSupervisor` | contracts、infra、runtime、coordination、leader、worker |
| 6 | `@co/cli` | `commander` 入口、`run` + `config` 命令 | contracts、infra、coordination、orchestrator |

Leader（4a）与 Worker（4b）同层，**互不直接 import**；必须通过 `@co/coordination` 提供的接口通信。

### Leader-Worker 模型

| 组件 | 功能 | 机制 |
|------|------|------|
| **Leader** | 交互式 TUI（React/Ink v7，Tab/1–9 切换 Worker），机械消息/任务路由，合并验证，孤儿任务恢复，链森林管理 | 独占 Leader 选举 —— 每个会话只有一个 Leader |
| **Worker** | 独立 git worktree，消息监听循环，通过 `claude -p` 自动处理消息，使用 `--fork-session` 自评估，使用 `--resume` 自动提交 | 实例注册 —— 断线自动清理 |
| **任务队列** | 推送 -> 认领 -> 完成（或失败）。基于 `ROLE_WEIGHTS` 的认领排序。 | FIFO 排序，原子认领锁 |
| **消息路由** | 点对点消息传递 + 推送通知 | 每个实例独立的持久消息队列 |

### Worker 8 步流水线

```
1. 解析消息（link / task_id / chain_id）
2. 按 link 选择模板（worker-{plan|execute|verify|review|accept|explore}.md）
3. 触发 worker_message_start 钩子
4. 渲染模板 + 身份提示（通过 --append-system-prompt 注入）
5. 执行主任务 -> ClaudeRunner.run() -> sessionId
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
Plan -> Execute -> Verify -> Review -> Accept
```

启用 magic 模式（`--magic`）后，链路扩展为：

```
Plan -> Execute -> Verify -> Review -> Explore -> Accept
                                          |
                                          v
                                    spawn_chain -> Plan -> Execute -> ...
```

每个环节由专属角色负责。一个人产出，下一个人验证 —— 形成 **责任链闭环**。每个产出物写入 `.claude-orchestrator/docs/{name}/YYYY-MM-DD/`，下一环节从该目录读取。每个环节内置自评估机制，通过 `EvalDecision` 决定后续路由：

| `EvalDecision.decision` | 效果 |
|-------------------------|------|
| `activate_next` | Leader 创建下一环节任务并派发 |
| `feedback` | Leader 将反馈文本转发给指定 Worker 进行返工 |
| `reject` | 链路以失败终结 |
| `close_chain` | 链路以成功终结 |
| `spawn_chain` | Explorer 请求 Leader 衍生新的子链（magic 模式） |

---

## Magic 模式

添加 `--magic` 参数启用自主探索。第 6 个 Worker 被分配 `explorer` 角色，责任链增加 `explore` 环节。Explorer Worker 自主分析代码库中的改进机会并返回 `spawn_chain` 决策，Leader 创建新链，形成 **链森林** 而非单一流水线。

```bash
# 启用 magic 模式，最大链深度为 10
claude-orchestrator run --worker 6 --magic --magic-max-chains 10
```

| 参数 | 说明 |
|------|------|
| `--magic` | 启用 Explorer 角色和 `spawn_chain` 决策路径 |
| `--magic-max-chains <m>` | 链森林深度硬上限。不设置则无限制。 |

---

## CLI 命令

| 命令 | 功能 |
|------|------|
| `run --worker <n>` | 一键编排：InitChecker、worktree 创建、Leader TUI、派生 N 个 Worker |
| `config` | 输出解析后的配置（命令、hooks、协议版本） |

公共参数：
- `-d, --debug` —— 启用调试日志
- `-y, --yes`（仅 `run`） —— 跳过 `InitChecker` 交互提示

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
├── agents/                              <- Worker prompt 模板
│   ├── worker-identity.md               #   --append-system-prompt 身份名片
│   ├── worker-decompose.md              #   需求 -> ChainDef 拆解
│   ├── worker-planner.md                #   Planner：角色描述（system prompt）
│   ├── worker-planner-task.md           #   Planner：单任务 user-message 包装
│   ├── worker-executor.md               #   Executor：角色描述
│   ├── worker-executor-task.md          #   Executor：单任务 user-message 包装
│   ├── worker-verifier.md               #   Verifier：角色描述
│   ├── worker-verifier-task.md          #   Verifier：单任务 user-message 包装
│   ├── worker-reviewer.md               #   Reviewer：角色描述
│   ├── worker-reviewer-task.md          #   Reviewer：单任务 user-message 包装
│   ├── worker-accepter.md               #   Accepter：角色描述
│   ├── worker-accepter-task.md          #   Accepter：单任务 user-message 包装
│   ├── worker-explorer.md               #   Explorer：角色描述（magic 模式）
│   ├── worker-explorer-task.md          #   Explorer：单任务 user-message 包装
│   ├── worker-evaluate.md               #   自评估 -> EvalDecision JSON
│   ├── worker-evaluate-format-hint.md   #   评估重试第 2 次起追加
│   ├── worker-commit-message.md         #   自动 commit message 生成
│   ├── worker-merge-decision.md         #   MergeDecision JSON（Leader 侧）
│   ├── worker-memorize-dir.md           #   目录级记忆生成
│   └── worker-memorize-file.md          #   文件级记忆生成
├── claude-memory/
│   ├── team-claude.md                   #   工作区级 CLAUDE.md
│   ├── personal-claude-planner.md       #   Planner 角色规范
│   ├── personal-claude-executor.md      #   Executor 角色规范
│   ├── personal-claude-verifier.md      #   Verifier 角色规范
│   ├── personal-claude-reviewer.md      #   Reviewer 角色规范
│   ├── personal-claude-accepter.md      #   Accepter 角色规范
│   └── personal-claude-explorer.md      #   Explorer 角色规范
└── user-global-claude.md                #   Worker 行为准则
```

---

## 内置 Skills

| Skill | 角色 | 功能 |
|-------|------|------|
| `task-planning` | Planner | 分析需求、定义蓝图、拆解任务 |
| `task-execution` | Executor | 认领任务、按蓝图实施、可追溯提交 |
| `task-verification` | Verifier | 独立验证 Executor 输出是否符合 Plan 标准 |
| `task-review` | Reviewer | 审核完整链路（Plan->Execute->Verify）的设计一致性 |
| `task-acceptance` | Accepter | 按业务标准验证最终交付物，签署 Go/No-Go |
| `task-exploration` | Explorer | 自主代码库分析，为发现的工作衍生子链 |
| `task-traceability` | 基础层 | Trace -> Execute -> Map -> Evidence -> Record —— 所有角色共用 |
| `test-driven-development` | 基础层 | TDD 工作流：红-绿-重构循环 |
| `claude-orchestrator` | 全员 | CLI 参考 |
| `claude-code-developer` | 全员 | Claude Code 开发者参考 |

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
| Executor | `executor` | `execute` = 100 | 按蓝图实施，产出可追溯证据 |
| Verifier | `verifier` | `verify` = 100 | 对照 Plan 交叉检查 Executor 输出 |
| Reviewer | `reviewer` | `review` = 100 | 全链路设计一致性质检 |
| Accepter | `accepter` | `accept` = 100 | 对照业务标准的最终 Go/No-Go 决策 |
| Explorer | `explorer` | `explore` = 100 | 自主代码库分析，衍生子链（magic 模式） |

角色是 **认领偏好，不是身份** —— 任何非 leader Worker 都可在权重次优时兜底认领其他环节。

---

## 开发

### 环境要求

- Node.js 18+
- pnpm 10+
- Claude Code CLI（`claude`）

### 源码安装

```bash
git clone https://github.com/adamancyzhang/claude-orchestrator-server.git
cd claude-orchestrator-server

pnpm install
pnpm -r build

# 启动 6 个 Worker（最低要求）
node bin/claude-orchestrator run --worker 6
```

### 构建与校验

```bash
pnpm -r build         # 全部 8 个包按拓扑顺序 tsc -b（project references）
pnpm typecheck        # tsc --noEmit 跨所有包
pnpm depcheck         # dependency-cruiser 分层隔离规则
pnpm pkgcheck         # 每个 package.json 的依赖白名单
```

---

## 项目结构

```
├── packages/                            # pnpm workspace 包
│   ├── contracts/                       #   Layer 0 —— Branded IDs、schemas、接口、错误、路径函数
│   ├── infra/                           #   Layer 1 —— Logger、ConfigLoader、exec 工具
│   ├── runtime/                         #   Layer 2 —— TemplateEngine、ClaudeRunner、HookEngine
│   ├── coordination/                    #   Layer 3 —— TaskQueue、MessageRouter、InstanceRegistry
│   ├── leader/                          #   Layer 4a —— EventBus、State、ChainRouter、MergeValidator、
│   │                                    #              Recovery、TaskOrchestrator、TUI（React/Ink v7）
│   ├── worker/                          #   Layer 4b —— WorkerWatcher、SelfEvaluator、CommitChecker
│   ├── orchestrator/                    #   Layer 5 —— runOrchestrator、InitChecker、WorktreeInitializer、
│   │                                    #              ChildSupervisor
│   └── cli/                             #   Layer 6 —— commander 入口，run + config 命令
│
├── templates/                           # Prompt 与目录记忆模板
│   ├── agents/                          #   20 个 Worker prompt 模板
│   ├── claude-memory/                   #   7 个 CLAUDE.md 目录记忆模板
│   └── user-global-claude.md            #   行为准则
│
├── skills/                              # Claude Code 技能（10 个）
│   ├── task-traceability/               #   基础层
│   ├── test-driven-development/         #   TDD 工作流
│   ├── task-planning/                   #   Planner 技能
│   ├── task-execution/                  #   Executor 技能
│   ├── task-verification/               #   Verifier 技能
│   ├── task-review/                     #   Reviewer 技能
│   ├── task-acceptance/                 #   Accepter 技能
│   ├── task-exploration/                #   Explorer 技能（magic 模式）
│   ├── claude-orchestrator/             #   CLI 参考
│   └── claude-code-developer/           #   Claude Code 开发者参考
│
├── scripts/
│   ├── check-pkg-deps.mjs               #   每个包依赖白名单校验
│   ├── publish.sh                       #   包发布
│   ├── start-leader.sh                  #   启动 leader 进程
│   ├── start-server.sh                  #   启动 server
│   ├── start-worker.sh                  #   启动 worker 进程
│   └── stop-all.sh                      #   停止所有进程
│
├── .dependency-cruiser.cjs              # 分层隔离规则（7 条禁止 pattern）
├── pnpm-workspace.yaml                  # workspace 包通配
├── tsconfig.base.json                   # 公共编译选项
├── tsconfig.json                        # 根 references -> 8 个包
├── bin/claude-orchestrator              # CLI 入口 -> packages/cli/dist/index.js
└── package.json                         # 根脚本：build / typecheck / depcheck / pkgcheck / test
```

---

## 配置参考

`@co/infra/ConfigLoader` 按以下 5 层合并（高优先级覆盖低优先级）：

1. CLI 参数（`-d`）
2. 环境变量
3. 当前 worktree 的 `.claude-orchestrator/config.json`（位于 worktree 内时）
4. 项目根 `.claude-orchestrator/config.json`
5. 全局 `~/.claude-orchestrator/config.json`

| 配置项 | 位置 | 默认值 |
|--------|------|--------|
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
  <sub>基于 TypeScript 和 pnpm workspaces 构建。请负责任地编排。</sub>
</p>
