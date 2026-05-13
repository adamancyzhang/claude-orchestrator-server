# Claude Orchestrator — Leader-Worker CLI-native 协同编排

## 1. 概述

Claude Orchestrator 是一个 CLI 原生的多 Agent 编排系统，由 ZooKeeper 直连提供分布式状态，依照 **Plan → Build → Verify → Review → Accept** 责任链推进任务闭环。

核心特征：

- **一键启动** — `claude-orchestrator run --worker N` 统一完成环境自检、worktree 初始化、Leader TUI 启动、Worker 子进程 fork 五个阶段
- **Worker 工作区隔离** — 每个 Worker 在独立的 git worktree 中运行，分支命名 `claude-orchestrator/{name}-workspace`，互不干扰
- **拟人化命名 + 角色解耦** — Worker 名称来自内置 20 个拟人化名称池（Tom / Jerry / Lucy / Thomas / Jack ...），名称是身份，角色是权重，二者独立分配
- **身份注入分离** — Worker 身份信息通过 `--append-system-prompt` 注入 system prompt，任务内容通过 `-p` 注入 user prompt，二者分离便于缓存复用
- **会话续接** — Worker 主任务、自评估、生成 commit message 三步通过 `--resume <session_id>` 共享对话上下文；Evaluator 重试时叠加 `--fork-session` 创建干净分支
- **自动提交 + Leader 合并验证** — Worker 任务完成后由 `CommitChecker` 调用 claude-cli 生成 commit message 并 `git commit`，Leader 通过 `MergeValidator` 决策 merge / skip / review_first
- **三层 Directory Memory** — 团队级 `CLAUDE.md` / 个人级 `.claude-orchestrator/docs/{Name}/CLAUDE.md` / 每日级 `.claude-orchestrator/docs/{Name}/{date}/CLAUDE.md`，沉淀团队规范、角色规范、会话记忆
- **CLI-native** — 所有交互通过 CLI + ZooKeeper Watch 完成，不依赖 MCP、HTTP、SSE

## 2. 架构总览

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              ZooKeeper                                       │
│                                                                              │
│  /leader [EPH]     /instances/* [EPH]    /tasks/*     /messages/*          │
└──────┬──────────────────┬─────────────────────┬─────────────────────────────┘
       │                  │                     │
       ▼                  ▼                     ▼
┌──────────────┐   ┌──────────────────────────────────────────────┐
│   Leader     │   │           Worker Pool (子进程)                 │
│  主进程       │   │                                              │
│              │   │  ┌─────────────┐  ┌─────────────┐  ...        │
│ ┌──────────┐ │   │  │ Tom         │  │ Jerry        │            │
│ │ TUI      │ │   │  │ planner     │  │ builder      │            │
│ │ (键盘+   │ │   │  │ worktree/   │  │ worktree/    │            │
│ │ 渲染)    │ │   │  │   Tom       │  │   Jerry      │            │
│ └──────────┘ │   │  │ branch:Tom- │  │ branch:Jerry │            │
│              │   │  │  workspace  │  │  -workspace  │            │
│ Watcher /    │   │  └──────┬──────┘  └──────┬───────┘            │
│ ChainRouter /│   │         │ ZK + claude    │ ZK + claude        │
│ MergeValidator│   │         ▼                ▼                    │
│              │   │   processMessage()  processMessage()           │
│ Orchestrator │   │   → TemplateEngine.render()                   │
│ / Recovery / │   │   → ClaudeRunner.run(prompt, {systemPrompt})  │
│ Monitor      │   │   → CommitChecker.check()                     │
│              │   │   → SelfEvaluator.evaluate()                  │
└──────┬───────┘   │   → 完成报告 → Leader                          │
       │           └──────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ git 主仓库 + worktree         │
│                              │
│ ./                           │
│ .claude-orchestrator/        │
│   worktree/                  │
│     Tom/    (branch: ...)    │
│     Jerry/  (branch: ...)    │
│     ...                      │
│   docs/{name}/CLAUDE.md      │
│   docs/{name}/{date}/...     │
│   sessions/{leader_id}/*.log │
└──────────────────────────────┘
```

### 身份体系

| 身份 | Preset Role | 启动方式 | 能力 |
|------|------------|---------|------|
| **Leader** | `leader` (启动时自动) | `claude-orchestrator run --worker N` 主进程 | TUI 渲染 + 键盘输入、Worker 消息监听、ChainRouter 路由、MergeValidator 合并决策、孤儿任务回收 |
| **Worker** | `planner` / `builder` / `verifier` / `reviewer` / `accepter` | fork 子进程，每个在自己的 worktree 中 | ZK 消息监听、模板渲染、claude-cli 执行、自评估、自动提交、完成报告 |
| **CLI** | — | 一次性命令（`push-task`、`send-message` 等） | 直接操作 ZK，是 ad-hoc 任务/消息发送的入口 |

### 核心模块

| 模块 | 路径 | 职责 |
|------|------|------|
| Instance Registry | [src/modules/registry.ts](../../src/modules/registry.ts) | 实例注册、心跳、`/instances/{id}` 临时节点维护 |
| Task Queue | [src/modules/task-queue.ts](../../src/modules/task-queue.ts) | push / claim / complete / block / fail / retry + role-link 排序认领 |
| Message Router | [src/modules/message-router.ts](../../src/modules/message-router.ts) | 点对点 / 广播消息发送、轮询、删除 |
| Template Engine | [src/executor/template.ts](../../src/executor/template.ts) | 加载 `templates/agents/` 模板、`{{var}}` 替换 |
| Claude Runner | [src/executor/runner.ts](../../src/executor/runner.ts) | `claude -p` 执行、`--append-system-prompt` 身份注入、session 续接 |
| Hook Engine | [src/hooks/engine.ts](../../src/hooks/engine.ts) | 生命周期 hook（`leader_message_start`/`worker_message_end` 等） |
| Worktree Initializer | [src/worker/worktree-initializer.ts](../../src/worker/worktree-initializer.ts) | 名称分配、git worktree 创建、配置持久化、幂等检查 |
| InitChecker | [src/orchestrator/init-checker.ts](../../src/orchestrator/init-checker.ts) | 6 步交互式初始化、`-y` 模式 + `init_status` 历史决策记忆 |

## 3. 启动流程

`run` 命令执行 5 个阶段（详见 [`orchestration.md`](orchestration.md)）：

```
claude-orchestrator run --worker 5 [-y] [-z <hosts>] [-d]
  ├─ Phase 1: 环境自检（InitChecker 6 步骤）
  │     ├─ global_config        ~/.claude-orchestrator/config.json
  │     ├─ user_claude_md       ~/.claude/CLAUDE.md
  │     ├─ team_claude_md       ./CLAUDE.md
  │     ├─ skills               ./.claude/skills/{name}/SKILL.md  (×8)
  │     ├─ worktrees            ./.claude-orchestrator/worktree/{name}
  │     └─ npm_install          各 worktree 内执行
  │
  ├─ Phase 2: Worker 名称 + 角色分配 + worktree 创建
  │     生成 5 个: Tom(planner), Jerry(builder), Lucy(verifier),
  │              Thomas(reviewer), Jack(accepter)
  │
  ├─ Phase 3: 启动 Leader（主进程）
  │     ZK 连接 → /leader EPHEMERAL → Instance 注册 → 5 个子系统启动 → TUI 渲染
  │
  ├─ Phase 4: fork N 个 Worker 子进程
  │     每个子进程 chdir 到对应 worktree → ZK 连接 → Instance 注册 → watch 循环
  │
  └─ Phase 5: 阻塞等待 SIGINT
        SIGINT → kill 所有子进程 → 注销 → 断开 ZK
```

## 4. 责任链与模板

Plan → Build → Verify → Review → Accept 五个环节，每个环节有：

- **一个 Worker 模板**（`templates/agents/worker-{link}.md`），由 `TemplateEngine` 渲染后作为 user prompt 传给 claude-cli
- **一个 Skill 引用**（`skills/task-{planning|execution|verification|review|acceptance}/SKILL.md`），承载该环节的标准执行流程

### 模板清单

`templates/agents/` 下共 12 个模板：

| 模板 | 用途 | 渲染方 |
|------|------|--------|
| `worker-plan.md` / `worker-build.md` / `worker-verify.md` / `worker-review.md` / `worker-accept.md` | 五个责任链环节的执行模板 | Worker |
| `worker-decompose.md` | 需求拆解为任务链 | Worker (planner 优先认领) 或 Leader 自处理 |
| `worker-evaluate.md` + `worker-evaluate-format-hint.md` | 任务后自评估，输出 EvalDecision JSON | Worker |
| `worker-commit-message.md` | 由 git diff 生成 commit message | Worker (CommitChecker) |
| `worker-merge-decision.md` | Leader 决策 merge/skip/review_first | Leader (MergeValidator) |
| `worker-task-doc.md` | 任务文档骨架 | Worker (decompose 时) |
| `worker-identity.md` | 身份卡片片段（由 `ClaudeRunner.buildIdentityPrompt()` 装配） | — |

`templates/claude-memory/` 下共 6 个 Memory 模板：

| 模板 | 复制目标 | 用途 |
|------|---------|------|
| `team-claude.md` | `./CLAUDE.md` | 团队级规范（角色表、产出目录、Git 规则） |
| `personal-claude-{planner,builder,verifier,reviewer,accepter}.md` | `./.claude-orchestrator/docs/{Name}/CLAUDE.md` | 角色级规范 |

外加 `templates/user-global-claude.md`，复制目标 `~/.claude/CLAUDE.md`，作为全局行为准则。

### Skill 清单

`skills/` 下 8 个 Skill：

| Skill | 关联 Worker |
|-------|------------|
| `task-planning` | Plan |
| `task-execution` | Build |
| `task-verification` | Verify |
| `task-review` | Review |
| `task-acceptance` | Plan + Accept |
| `task-traceability` | 所有 Worker 的基础流程层 |
| `claude-orchestrator` | 系统级 CLI/编排参考 |
| `claude-code-developer` | claude-cli 开发者参考 |

## 5. 文件结构

```
claude-orchestrator-server/                 ← npm 包根目录
├── package.json
├── bin/claude-orchestrator                 # CLI 启动脚本
├── src/
│   ├── index.ts                            # CLI 入口（commander，13 命令）
│   ├── config.ts                           # 配置加载与合并
│   ├── cli/commands.ts                     # 短期命令实现（push-task/send-message 等）
│   ├── orchestrator/
│   │   ├── run.ts                          # `run` 命令五阶段编排
│   │   └── init-checker.ts                 # 交互式初始化 + -y 模式 + init_status
│   ├── leader/
│   │   ├── index.ts                        # Leader 启动入口
│   │   ├── event-bus.ts                    # 类型化事件总线（17 种事件）
│   │   ├── state.ts                        # LeaderState (workers/tasks/events/selectedWorkerIndex)
│   │   ├── tui.ts                          # ANSI 渲染 + 键盘输入 + Worker 切换
│   │   ├── stream-tailer.ts                # 实时尾随 Worker 日志
│   │   ├── watcher.ts                      # Leader 自身消息队列监听
│   │   ├── chain-router.ts                 # 机械路由（自处理 decompose + 转发）
│   │   ├── merge-validator.ts              # 合并决策 + git merge 执行
│   │   ├── orchestrator.ts                 # 任务 Watch + 孤儿检测触发
│   │   ├── recovery.ts                     # 启动时孤儿扫描 + retry_count++
│   │   └── monitor.ts                      # /instances Watch + worker_joined/left
│   ├── worker/
│   │   ├── child.ts                        # 子进程入口
│   │   ├── child-runner.ts                 # 子进程核心（chdir → ZK → watcher）
│   │   ├── watcher.ts                      # 消息处理管线
│   │   ├── evaluator.ts                    # 自评估（--resume + --fork-session）
│   │   ├── commit-checker.ts               # 自动提交（--resume 同主任务 session）
│   │   └── worktree-initializer.ts         # 名称/角色分配 + git worktree + 配置
│   ├── executor/
│   │   ├── runner.ts                       # ClaudeRunner（身份注入 + 日志路径）
│   │   └── template.ts                     # TemplateEngine（{{var}} 替换 + loadFile）
│   ├── hooks/
│   │   └── engine.ts                       # HookEngine（事件 → shell + CO_* 环境变量）
│   ├── zk/
│   │   ├── client.ts                       # ZK 客户端 + Watch 包装 + 自动重连
│   │   ├── paths.ts                        # ZK 路径常量
│   │   └── watcher.ts                      # 一次性 Watch 重建工具
│   ├── modules/
│   │   ├── registry.ts                     # /instances 注册与查询
│   │   ├── task-queue.ts                   # /tasks/* 操作 + 角色权重排序
│   │   └── message-router.ts               # /messages/* 操作
│   ├── models/
│   │   └── schemas.ts                      # Zod schemas（Instance/Task/Message/ChainDef/EvalDecision）
│   └── utils/
│       ├── exec.ts                         # execWithStreaming（唯一执行入口）
│       ├── json.ts                         # extractJson（解析 fenced JSON）
│       ├── logger.ts                       # Logger（--debug 跟踪）
│       ├── output.ts                       # JSON CLI 输出
│       └── console-capture.ts              # stdout/stderr 重定向到文件
├── templates/
│   ├── agents/                             # 12 个 Worker 模板
│   ├── claude-memory/                      # 6 个 directory memory 模板
│   └── user-global-claude.md
└── skills/                                 # 8 个 Skill

项目运行时目录：
<project>/
├── CLAUDE.md                               ← 团队级 directory memory
├── .claude-orchestrator/
│   ├── config.json                         # 含 worktree[] / init_status / instance_id
│   ├── docs/{Name}/
│   │   ├── CLAUDE.md                       # 个人级 directory memory
│   │   └── YYYY-MM-DD/CLAUDE.md            # 每日 session memory
│   ├── worktree/{Name}/                    # git worktree（branch: claude-orchestrator/{Name}-workspace）
│   └── sessions/{leader_instance_id}/      # Leader/Worker 共享日志目录
│       ├── tasks/task-NNNNN.md
│       ├── task-NNNNN-{ts}.log
│       └── task-NNNNN-result.md
└── .claude/skills/                         # 8 个 Skill 副本

全局配置：
~/.claude-orchestrator/config.json          # commands / hooks / cache_dir / zookeeper / init_status
~/.claude/CLAUDE.md                         # 用户全局规范（来自 templates/user-global-claude.md）
```

## 6. 数据流

```
1. 用户在 TUI 输入需求
   │
   ▼
2. LeaderTui.onInput() → 写入 /messages/{leader_id}/msg-NNNNN
   │
   ▼
3. LeaderWatcher 捕获 → ChainRouter.route()
   │
   ├─ a. 模板已加载 → 自处理 decompose：claude-cli 拆解为 ChainDef JSON
   │
   └─ b. 模板未加载 → 转发 decompose 消息给 Planner Worker
                       └─ Worker processMessage() 运行 worker-decompose.md
                          → 完成报告 ChainDef → Leader
   │
   ▼
4. ChainRouter 解析 ChainDef → push 5 个任务（plan? + build + verify + review + accept）
   每个任务带 chain_id / link / depends_on
   │
   ▼
5. Task Queue claim 排序（角色匹配 → priority → FIFO）
   Worker 通过 ZK Watch 收到任务消息
   │
   ▼
6. Worker processMessage():
   ├─ TemplateEngine.render(worker-{link}.md, {task_*, ...})
   ├─ ClaudeRunner.run(prompt, {systemPrompt: buildIdentityPrompt()})
   │   ↳ 返回 {code, sessionId}
   ├─ CommitChecker.check(taskContext, sessionId)
   │   ↳ runner.run("生成 commit message", {resumeSessionId: sessionId})
   │   ↳ git add -A && git commit
   ├─ SelfEvaluator.evaluate(link, vars, resultPath, key, sessionId)
   │   ↳ runner.run(worker-evaluate.md, {resumeSessionId, forkSession: true})
   │   ↳ 输出 EvalDecision JSON
   └─ sendCompletionReport(link, EvalDecision + commitInfo) → Leader
   │
   ▼
7. Leader ChainRouter.handleCompletionReport():
   ├─ MergeValidator.validate(commitInfo) → merge / skip / review_first
   │   ↳ runner.run(worker-merge-decision.md) → 决策 JSON
   │   ↳ 若 merge: git checkout main && git merge --no-ff
   └─ 解析 EvalDecision → 执行 activate_next / feedback / close_chain
   │
   ▼
8. 下一环节激活 → 回到 Step 5
```

## 7. 安全与可靠性

| 维度 | 措施 |
|------|------|
| 单 Leader 保证 | ZK `/leader` EPHEMERAL 节点 — 后续 `run` 命令在同一 ZK 集群上启动时会冲突退出 |
| Worker 隔离 | git worktree + 独立分支 + 独立 `process.cwd()` + 子进程独立内存 |
| 孤儿任务恢复 | EPHEMERAL `/tasks/claimed/{ins}-{task}` 自动删除 → Leader Watch 触发 → retry_count++ → 重入 pending（max 3 次） |
| 子进程崩溃 | 主进程 `child.on("exit")` 自动重启（最多 3 次） |
| 父进程崩溃 | 子进程每秒 `process.kill(ppid, 0)` 检测，父进程消失时主动退出 |
| 危险初始化操作 | InitChecker 对 Danger 步骤强制确认；`-y` 模式遵循 `init_status` 历史决策 |
| 合并冲突 | MergeValidator `git merge --abort` + 返回 `review_first`，不破坏 main |
| ZK 临时断开 | `ZkClient` 自动重连（指数退避，最多 10 次，2s spin） |
| ZK 节点 ACL | 默认 `OPEN_ACL_UNSAFE`，生产建议 Digest 认证 |

## 8. 配置文件

### 全局配置 `~/.claude-orchestrator/config.json`

```json
{
  "zookeeper": {
    "url": "127.0.0.1:2181",
    "root_path": "/claude-orchestrator",
    "auth": null
  },
  "cache_dir": ".claude-orchestrator/sessions",
  "commands": {
    "claude-cli": "claude --dangerously-skip-permissions --permission-mode dontAsk"
  },
  "hooks": {
    "leader_message_start": null,
    "leader_message_end": null,
    "worker_message_start": null,
    "worker_message_end": null
  },
  "init_status": {
    "global_config": { "action": "created", "timestamp": "..." },
    "user_claude_md": { "action": "replaced", "timestamp": "..." },
    "team_claude_md": { "action": "skipped", "timestamp": "..." },
    "skills": { "task-planning": { "action": "replaced", "..." }, ... },
    "worktrees": { "Tom": { "action": "created", "..." }, ... },
    "npm_install": { "Tom": { "action": "completed", "..." }, ... }
  }
}
```

### 项目配置 `<cwd>/.claude-orchestrator/config.json`

```json
{
  "instance_id": "a1b2c3d4...",
  "name": "Tom",
  "role": "planner",
  "worktree": {
    "Tom":    { "name": "Tom",    "role": "planner",  "path": ".claude-orchestrator/worktree/Tom",    "branch": "claude-orchestrator/Tom-workspace",    "instance_id": "..." },
    "Jerry":  { "name": "Jerry",  "role": "builder",  "path": ".claude-orchestrator/worktree/Jerry",  "branch": "claude-orchestrator/Jerry-workspace",  "instance_id": "..." },
    "Lucy":   { "name": "Lucy",   "role": "verifier", "path": "...", "branch": "...", "instance_id": "..." },
    "Thomas": { "name": "Thomas", "role": "reviewer", "path": "...", "branch": "...", "instance_id": "..." },
    "Jack":   { "name": "Jack",   "role": "accepter", "path": "...", "branch": "...", "instance_id": "..." }
  }
}
```

每个 worktree 内部还有自己的精简 `.claude-orchestrator/config.json`：

```json
{
  "name": "Tom",
  "role": "planner",
  "instance_id": "a1b2c3d4..."
}
```

合并规则：项目配置覆盖全局配置；命令级 `-z` flag / `ZK_HOSTS` 环境变量优先于配置文件。详见 [`commands.md`](commands.md)。

## 9. 相关文档

| 文档 | 主题 |
|------|------|
| [`CLAUDE.md`](CLAUDE.md) | 版本入口、文档索引、实现状态 |
| [`architecture.md`](architecture.md) | Leader/Worker/Orchestrator 内部组件、事件总线、状态机、错误恢复 |
| [`orchestration.md`](orchestration.md) | `run` 五阶段编排、InitChecker、子进程管理、关停 |
| [`leader-design.md`](leader-design.md) | Leader 子系统：TUI / ChainRouter / MergeValidator / Watcher 等 |
| [`worker-design.md`](worker-design.md) | Worker 子系统：子进程模型 / 五 link 模板 / 自评估 / 自动提交 |
| [`worktree-and-identity.md`](worktree-and-identity.md) | git worktree 隔离、拟人化命名、身份注入、Directory Memory |
| [`role-design.md`](role-design.md) | 责任链、角色即权重、名称-角色解耦、认领规则 |
| [`commands.md`](commands.md) | 13 个 CLI 命令、配置系统、状态流转 |
| [`zookeeper-schema.md`](zookeeper-schema.md) | ZK 节点树、数据模型、Watch 策略、生命周期 |
| [`execution-runtime.md`](execution-runtime.md) | ClaudeRunner / execWithStreaming / TemplateEngine / Hooks / 会话续接 |
