# v0.5 设计文档索引

## 版本目标

Claude Orchestrator v0.5 是一个 CLI 原生、ZooKeeper 直连的多 Agent 编排系统。Leader 主进程托管 TUI + 5 个 ZK Watcher 子系统；Worker 子进程在独立的 git worktree 中并行运行，通过 ZK 消息接收任务，按 P→B→V→R→A 责任链推进闭环。一条 `run --worker N` 命令即可启动全部环境。

## 文档索引

| 文档 | 主题 |
|------|------|
| [`README.md`](README.md) | 总体概述、架构图、身份体系、目录结构、数据流速览 |
| [`architecture.md`](architecture.md) | Leader / Worker / Orchestrator 内部组件、事件总线、状态机、错误恢复 |
| [`orchestration.md`](orchestration.md) | `run` 命令五阶段流程、InitChecker、子进程编排、关停 |
| [`leader-design.md`](leader-design.md) | Leader 子系统:TUI / Watcher / ChainRouter / MergeValidator / Recovery |
| [`worker-design.md`](worker-design.md) | Worker 子系统:子进程模型、Watcher、Evaluator、CommitChecker、五 link 模板 |
| [`worktree-and-identity.md`](worktree-and-identity.md) | git worktree 隔离、拟人化命名、`--append-system-prompt` 身份注入、三层 Directory Memory |
| [`role-design.md`](role-design.md) | 责任链 P→B→V→R→A、角色即权重、名称-角色解耦、认领规则 |
| [`commands.md`](commands.md) | 13 个 CLI 命令、配置分层、任务状态流转 |
| [`zookeeper-schema.md`](zookeeper-schema.md) | ZK 节点树、数据模型、Watch 策略、节点生命周期 |
| [`execution-runtime.md`](execution-runtime.md) | ClaudeRunner / execWithStreaming / TemplateEngine / Hooks / `--resume` 会话续接 |
| [`package-layout.md`](package-layout.md) | 多包工程分层（pnpm workspaces）、包依赖矩阵、dependency-cruiser 规则、关键切分理由 |
| [`contracts.md`](contracts.md) | `@co/contracts` 完整规范:Branded IDs、Zod Schema、判别联合、跨层接口、角色权重表、错误层级、日志契约、路径函数 |
| [`protocol.md`](protocol.md) | ZK Wire-Format 协议参考:每个节点的 JSON 形状、Watch 语义、Message envelope 判别规则、多项目命名空间 |
| [`error-and-recovery.md`](error-and-recovery.md) | 错误模型 + 恢复状态机:错误类层级、稳定错误码、任务/进程/ZK 会话恢复、孤儿回收策略 |

## 阅读路径

**新人入门**

1. [`README.md`](README.md) — 整体架构与术语
2. [`orchestration.md`](orchestration.md) — 启动流程
3. [`role-design.md`](role-design.md) — 责任链与角色权重
4. [`leader-design.md`](leader-design.md) + [`worker-design.md`](worker-design.md) — 两侧主要工作流
5. [`worktree-and-identity.md`](worktree-and-identity.md) + [`execution-runtime.md`](execution-runtime.md) — 隔离与执行细节
6. [`commands.md`](commands.md) + [`zookeeper-schema.md`](zookeeper-schema.md) — CLI 与协议参考
7. [`architecture.md`](architecture.md) — 深入参考

**参考契约**（实现 / 评审 v0.5 代码时的权威）

1. [`contracts.md`](contracts.md) — 类型、Schema、跨层接口的"协议字典"
2. [`protocol.md`](protocol.md) — ZK Wire-Format 形式化规范
3. [`package-layout.md`](package-layout.md) — 包归属与分层规则
4. [`error-and-recovery.md`](error-and-recovery.md) — 错误模型与恢复状态机

**问题排查**

- TUI / 键盘交互 → [`leader-design.md`](leader-design.md) §3
- Worker 任务失败 / 自评估异常 → [`worker-design.md`](worker-design.md) §5
- 合并冲突 → [`leader-design.md`](leader-design.md) §6
- 启动配置异常 → [`orchestration.md`](orchestration.md) §3
- ZK 节点状态 → [`zookeeper-schema.md`](zookeeper-schema.md)
- 错误恢复矩阵 → [`error-and-recovery.md`](error-and-recovery.md)（权威）、[`architecture.md`](architecture.md) §5、[`orchestration.md`](orchestration.md) §10
- ZK Wire-Format → [`protocol.md`](protocol.md)（权威）、[`zookeeper-schema.md`](zookeeper-schema.md)（散文背景）
- 类型 / 接口定义 → [`contracts.md`](contracts.md)（权威）
- 代码归属（新代码该放哪个包） → [`package-layout.md`](package-layout.md)

## 实现完成度

| 维度 | 内容 |
|------|------|
| CLI 命令 | 13 个（`run` / `unregister` / `config` / 3 个消息 / 7 个任务） |
| Leader 模块 | 11 个文件:`index` / `event-bus` / `state` / `tui` / `stream-tailer` / `watcher` / `chain-router` / `merge-validator` / `orchestrator` / `recovery` / `monitor` |
| Worker 模块 | 6 个文件:`child` / `child-runner` / `watcher` / `evaluator` / `commit-checker` / `worktree-initializer` |
| Orchestrator | 2 个文件:`run` / `init-checker` |
| Executor | 2 个文件:`runner` / `template` |
| Hooks | 1 个文件:`engine` |
| ZK 层 | 3 个文件:`client` / `paths` / `watcher` |
| Modules | 3 个文件:`registry` / `task-queue` / `message-router` |
| Models | `schemas.ts`（Zod schema:Instance / Task / Message / ChainDef / EvalDecision） |
| Utils | `exec` / `json` / `logger` / `output` / `console-capture` |
| Worker 模板 | `templates/agents/` 12 个（5 link + decompose / evaluate / evaluate-hint / commit-message / merge-decision / task-doc / identity） |
| Claude Memory 模板 | `templates/claude-memory/` 6 个（team + 5 个 personal-claude-{role}） |
| 全局模板 | `templates/user-global-claude.md` |
| Skill | `skills/` 8 个（task-planning / task-execution / task-verification / task-review / task-acceptance / task-traceability / claude-orchestrator / claude-code-developer） |

## 设计要点速查

| 主题 | 一句话 | 详见 |
|------|--------|------|
| 一键启动 | `claude-orchestrator run --worker N` 五阶段完成环境配置 + TUI + 子进程 fork | [`orchestration.md`](orchestration.md) |
| Worker 隔离 | 每个 Worker 独立 git worktree + 独立分支 `claude-orchestrator/{name}-workspace` | [`worktree-and-identity.md`](worktree-and-identity.md) §1 |
| 拟人化命名 | 内置 20 个名称池 + 不足时 claude-cli 生成 | [`worktree-and-identity.md`](worktree-and-identity.md) §2 |
| 角色即权重 | `role` 是认领偏好，不是身份；任何 Worker 可认领任意 link 任务 | [`role-design.md`](role-design.md) §3 |
| 身份注入 | `--append-system-prompt` 注入身份；`-p` 仅传任务内容 | [`worktree-and-identity.md`](worktree-and-identity.md) §3 |
| 会话续接 | 主任务 → commit → 评估 通过 `--resume` 共享 session；评估重试加 `--fork-session` 消除锚定 | [`execution-runtime.md`](execution-runtime.md) §3 |
| 自评估 | Worker 自身调用 `worker-evaluate.md` 输出 EvalDecision JSON；Leader 机械执行 | [`worker-design.md`](worker-design.md) §5 |
| 自动提交 | `CommitChecker` 由 git diff 生成 commit message 并 `git commit` | [`worker-design.md`](worker-design.md) §6 |
| Leader 合并 | `MergeValidator` 调用 claude-cli 决策 merge / skip / review_first；冲突自动 abort | [`leader-design.md`](leader-design.md) §6 |
| TUI 多 Worker | TEAM 面板 + 可切换 WORKER MESSAGES 面板（Tab / Shift+Tab / 1-9） | [`leader-design.md`](leader-design.md) §3 |
| Directory Memory | 三层 CLAUDE.md:团队级 / 个人级 / 每日级 | [`worktree-and-identity.md`](worktree-and-identity.md) §5 |
| InitChecker | 6 步初始化 + Safe/Caution/Danger 分级 + `init_status` 历史决策 + `-y` 自动模式 | [`orchestration.md`](orchestration.md) §3 |
| 孤儿回收 | EPHEMERAL 节点 + Watch 触发 retry_count++，max 3 次后归档 failed | [`architecture.md`](architecture.md) §5 |
| ChainRouter | 三类路由:EvalDecision / ChainDef / 用户输入；用户输入可自处理或转发 Planner | [`leader-design.md`](leader-design.md) §5 |
| 任务文档 | `cache_dir/{leader_id}/tasks/task-{seq}.md`，消息中以相对路径引用 | [`execution-runtime.md`](execution-runtime.md) §6 |

## 关键文件路径

源码：

- 入口:[src/index.ts](../../src/index.ts)
- 配置:[src/config.ts](../../src/config.ts)
- 编排:[src/orchestrator/run.ts](../../src/orchestrator/run.ts) + [init-checker.ts](../../src/orchestrator/init-checker.ts)
- Leader:[src/leader/](../../src/leader/) 11 个文件
- Worker:[src/worker/](../../src/worker/) 6 个文件
- Executor:[src/executor/runner.ts](../../src/executor/runner.ts) + [template.ts](../../src/executor/template.ts)
- Hooks:[src/hooks/engine.ts](../../src/hooks/engine.ts)
- ZK:[src/zk/](../../src/zk/) 3 个文件
- Modules:[src/modules/](../../src/modules/) 3 个文件
- Schemas:[src/models/schemas.ts](../../src/models/schemas.ts)

模板与 Skill：

- Worker 模板:[templates/agents/](../../templates/agents/) 12 个
- Memory 模板:[templates/claude-memory/](../../templates/claude-memory/) 6 个
- 全局模板:[templates/user-global-claude.md](../../templates/user-global-claude.md)
- Skill:[skills/](../../skills/) 8 个

测试：

- 单元测试:[tests/unit/](../../tests/unit/)（vitest run）
- 集成测试:[tests/integration/leader-worker.test.ts](../../tests/integration/leader-worker.test.ts)
