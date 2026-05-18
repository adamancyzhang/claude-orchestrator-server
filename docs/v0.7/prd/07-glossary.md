# 07 — 术语表

> **文档定位**：PRD 中出现的核心术语统一释义；按概念域分组。详细 schema / 代码归属见 `../../rc0-v0.6/dd/contracts.md`。

## 1. 链路与责任链

| 术语 | 释义 |
|------|------|
| **Chain** | 一次需求拆解出的 plan → execute → verify → review → accept（→ explore）任务序列；由唯一 `chain_id` 标识；ChainAudit 持久化 manifest |
| **Link** | Chain 中的单个环节；**[v0.7]** 六种之一：`plan` / `execute` / `verify` / `review` / `accept` / `explore`（schema: `TaskLinkSchema`）；`execute` 为旧 `build` 的 v0.7 重命名；`explore` 为 v0.7 新增、仅在 `--magic` 模式出现 |
| **Responsibility Chain** | "Plan → Execute → Verify → Review → Accept（→ Explore）" 五至六环节序列模型；NEXT_LINKS / PREV_LINKS 定义在 Leader（`chain-router.ts`）与 Worker（`evaluator.ts`） |
| **Chain Manifest** | `~/.claude-orchestrator/projects/<leader_id>/chains/<chain_id>/manifest.json`；含 status / link_tasks / link_workers / total_retry_count / max_total_retries / requirement_path；**[v0.7 NEW]** 新增 `parent_chain_id` / `child_chain_ids` / `chain_depth` / `magic_mode` 四字段 |
| **Chain Audit** | 单链审计三件套：`manifest.json` + `audit.jsonl` + `requirement.md` |
| **ChainStatus** | manifest 状态枚举：`running` / `completed` / `aborted` / `merge_failed` / `failed`（其中 `failed` 保留位） |
| **ChainDef** | decompose 输出的链定义 JSON，含 plan/execute/verify/review/accept 5 个任务（plan 可为 null）；**[v0.7 NEW]** `--magic` 模式下追加 `explore` 第 6 任务 |
| **[v0.7 NEW] Chain Forest** | `--magic` 跑出的 parent ↔ child chain 集合；通过 manifest 的 `parent_chain_id` / `child_chain_ids` / `chain_depth` 字段连接 |

## 2. 决策与协议

| 术语 | 释义 |
|------|------|
| **EvalDecision** | Worker 完成任务后自评估输出的 JSON，**[v0.7]** 5 态：`activate_next` / `feedback` / `reject` / `close_chain` / **[v0.7 NEW] `spawn_chain`**（仅在 explore link 合法） |
| **[v0.7 NEW] `spawn_chain`** | EvalDecision 第 5 态；Explorer 输出 `spawn_chain` + `next_requirement: <string>` 时，ChainRouter 关闭当前 chain 并基于 next_requirement 开启下一条 chain，新 chain 的 manifest 记录 `parent_chain_id` |
| **MergeDecision** | MergeValidator 由 `worker-merge-decision.md` 模板输出的 JSON，3 态：`merge` / `skip` / `review_first` |
| **PROTOCOL_VERSION** | 跨组件协议版本字段，**[v0.7]** 升至 `"0.7.0"`（因 `build → execute` / `builder → executor` 重命名 + `explore` 新增 + `spawn_chain` 新增构成破坏性变更）；Worker 启动校验 `/leader` 节点协议版本不匹配即退出 |
| **`feedback_target`** | EvalDecision 中可选字段，显式指定 retry 派回的 Worker `InstanceId`；不提供则用 `manifest.link_workers[PREV_LINKS[link]]`；两者皆无则静默丢弃（FR-19） |

## 3. 身份与角色

| 术语 | 释义 |
|------|------|
| **Role** | Worker 注册时的偏好分数依据；**[v0.7]** 6 个 worker role：`planner` / `executor`（旧 `builder`）/ `verifier` / `reviewer` / `accepter` / **[v0.7 NEW] `explorer`**，加 Leader 共 7 个 |
| **[v0.7 NEW] Executor** | 旧 `builder` role 的 v0.7 重命名；职责未变（按 plan 蓝图实现代码 + 自动 commit） |
| **[v0.7 NEW] Explorer** | 新增 role；`--magic` 模式下的链尾；在 Accepter 签收后审视产出，输出"下一轮需求草案"以及 `spawn_chain` / `close_chain` 决策 |
| **Role Weight** | `roleWeights.ts` 中 role × link 的偏好分数（100 = 首选，10-20 = 兜底）；TaskQueue.claim 排序依据 |
| **Worker Identity Card** | 注入 `claude --append-system-prompt` 的身份字符串，三段拼接：`worker-identity.md` + `personal-claude-{role}.md` + `worker-{role}.md` |
| **Worktree** | 单 Worker 独占目录：`<project>/.claude-orchestrator/worktree/<name>/`，对应分支 `claude-orchestrator/<name>-workspace` |
| **Name Pool** | 20 个拟人化 Worker 名称池（Tom / Jerry / Lucy / Thomas / Jack / Lisa / ...） |
| **InstanceId** | branded `string`，Worker 全局唯一标识；ZK `/instances/<id>` EPHEMERAL 节点 key |
| **`leader_id`** | Leader 的 InstanceId；cache 路径前缀（`~/.claude-orchestrator/projects/<leader_id>/...`） |

## 4. 任务与消息

| 术语 | 释义 |
|------|------|
| **Task** | 责任链中的单个工作项；schema 含 id / title / description / priority / status / link / chain_id / retry_count 等 |
| **TaskStatus** | `pending` / `claimed` / `completed` / `blocked` / `failed` |
| **Pending / Claimed / Completed** | ZK 中任务的 3 个目录：`/tasks/pending/`（待认领）/ `/tasks/claimed/`（EPHEMERAL 由 Worker 持有作为认领锁）/ `/tasks/completed/`（历史） |
| **Message** | Worker 收件箱中的消息；`/messages/{instance_id}/msg-*` SEQUENTIAL；6 种 type：`direct` / `broadcast` / `task_dispatch` / `completion_report` / `user_input` / `help` |
| **`task_dispatch`** | Leader 派发任务给 Worker 的消息类型 |
| **`completion_report`** | Worker 完成任务后回报 Leader 的消息类型，内容为 EvalDecision JSON（含 commit 信息） |
| **`user_input`** | TUI 输入框写入的用户需求消息类型 |
| **`memory_refresh`** | Worker commit 后通知 Leader 增量刷新 workspace memory 的消息类型 |
| **[v0.7 NEW] `upstream_commits`** | Task / Message 字段；`Partial<{plan?, build?, verify?, review?: string}>` 形式的上游 link worktree SHA 映射；下游 link dispatch 前由 `ChainAudit.collectUpstreamCommits` 注入；Worker 用它做 pre-task rebase |
| **[v0.7 NEW] `LinkCommitRecord`** | manifest.link_commits[link] 的记录类型；`{ worktree: string\|null, docs: string\|null, branch: string }`；Worker 完成 link 任务时通过 completion_report 回传，ChainRouter 调 `ChainAudit.recordLinkCommit` 落盘 |
| **[v0.7 NEW] `link_commits`** | chain manifest 字段；`Partial<Record<TaskLink, LinkCommitRecord>>`；feedback 决策时调 `clearLinkCommitsFrom` 擦除 fromLink 及其下游 |
| **[v0.7 NEW] Pre-task rebase** | Worker 在收到 task_dispatch 后、调起 claude-cli 前执行 `git rebase <upstream_sha>` 把自己分支线性接到上游 link 上；冲突时抛 `RebaseConflictError` 触发强制 feedback；plan link 或 `upstream_commits={}` 时跳过 |
| **[v0.7 NEW] Dual-track commit** | 任务完成时的双写：**轨 A**（CommitChecker）项目仓 per-Worker 分支代码 commit；**轨 B**（DocsCommitter）CO root 仓 `docs/<worker_name>/` 文档 commit；轨 B best-effort，失败不阻塞 |

## 5. 进程与基础设施

| 术语 | 释义 |
|------|------|
| **Leader** | 主进程：抢占 ZK `/leader` EPHEMERAL；运行 TUI；包含 WorkerMonitor / TaskOrchestrator / LeaderWatcher / Recovery / ChainRouter / MergeValidator 等子系统 |
| **Worker** | 由 Leader fork 的子进程：注册 `/instances/<id>` EPHEMERAL；监听自己的消息收件箱；执行 `claude -p` |
| **EPHEMERAL** | ZK 会话级节点，会话断开自动删除；`/leader` / `/instances/*` / `/tasks/claimed/*` 使用 |
| **SEQUENTIAL** | ZK 顺序节点，名字自带递增序号；`/messages/*/msg-*` / `/tasks/pending/task-*` 使用 |
| **ZK Watch** | ZooKeeper 节点变化通知机制，事件触发模型的核心驱动 |
| **MergeValidator** | Leader 子系统：在 close_chain 时通过 `worker-merge-decision.md` 模板让 claude-cli 完成 ancestry 检查 + 决策 + merge 执行 |
| **ChainRouter** | Leader 子系统：完成报告路由（按 EvalDecision 派发或终结）+ 需求拆解 + ChainDef 推送 + feedback 派发 |
| **Recovery** | Leader 子系统：扫描孤儿 `/tasks/claimed/*`，owner 不存在则重入 pending（`retry_count` 受 `MAX_RETRY = 3` 约束） |
| **SelfEvaluator** | Worker 子系统：完成任务后渲染 `worker-evaluate.md` 调用 claude-cli，3 次重试解析 EvalDecision JSON |
| **CommitChecker** | Worker 子系统：自动 `git add -A && git commit`；commit message 由 claude 按 `worker-commit-message.md` 生成 |
| **HookEngine** | 4 类 lifecycle hook 触发器：`worker_message_start` / `worker_message_end` / `task_claimed` / `task_completed`；hook 接收 `CO_*` 环境变量 |
| **TemplateEngine** | 加载 `templates/agents/*.md`，渲染时替换 `{{name}}` / `{{role}}` 等占位符 |
| **ClaudeRunner** | claude-cli 执行包装层；`execWithStreaming`、`execWithTee`、`execAndCapture`；负责拼接 `--append-system-prompt` 与 `-p` |
| **[v0.7 NEW] DocsCommitter** | Worker 子系统：将 `<co_root>/docs/<worker_name>/` 下产出（result.md 等）commit 到 CO root 仓；使用 `git status --porcelain -- <scope>` + `git commit --only` 保证并发安全；失败 best-effort 返回 `null` |
| **[v0.7 NEW] CO Root** | claude-orchestrator-server 项目根仓（与 Worker 操作的"项目仓"区分）；所有 Worker 共享，docs commit 在此发生 |

## 6. 失败与恢复（RC0 新增术语）

| 术语 | 释义 |
|------|------|
| **`max_total_retries`** | chain manifest 中持久化字段，单链总反馈次数硬上限；默认 9，`CO_CHAIN_MAX_RETRIES` 环境变量覆写 |
| **`total_retry_count`** | chain manifest 中持久化字段，原子递增的实际反馈次数 |
| **`retry_ceiling_exceeded`** | audit 事件类型 + manifest.extra.reason 取值；表示链因反馈累计超限被强制 `aborted` |
| **`merge_failed`** | ChainStatus 终态；表示 close_chain 时合并冲突，已对每个失败 link 派 retry task 给原 Executor |
| **`chain_merge_failed`** | EventBus 事件类型；TUI 红字渲染 `MERGE_FAILED chain <id>: N branch(es) ...` |
| **`chain_id_conflict`** | audit 事件类型；试图重写已终态 chain manifest 时记录，原 manifest 保留不被覆盖 |
| **`feedback_unresolved`** | audit 事件类型；feedback 无可解析 target 时记录，本次不派发新 task |
| **`CommitFailedError`** | 错误类，`git commit` 真实失败时抛出（与"无变更短路"区分）；触发强制 feedback 回同 Worker |
| **`ChainConflictError`** | 错误类，ChainAudit.openChain 检测到 chain_id 终态 manifest 已存在时抛出 |
| **`OrphanRetryExhaustedError`** | 错误类，孤儿任务 retry_count ≥ 3 时抛出 |
| **[v0.7 NEW] `MergeConflictError`** | 错误类，MergeValidator `git merge` 失败且 unmerged paths 非空时抛出；触发对 accept-link Worker 派 retry |
| **[v0.7 NEW] `RebaseConflictError`** | 错误类，Worker pre-task rebase 失败且冲突非空时抛出；触发同 Worker 强制 feedback |
| **[v0.7 NEW] `WorktreeLockedError`** | 错误类，git 操作命中 `cannot lock ref` / `index.lock` 时抛出；**不**触发 retry，仅 audit |
| **[v0.7 NEW] `GitPermissionError`** | 错误类，git 操作命中 `permission denied` / `read-only file system` 时抛出；**不**触发 retry |
| **[v0.7 NEW] `GitNetworkError`** | 错误类，git fetch 命中 `connection refused / timed out` / `network is unreachable` 时抛出；**不**触发 retry |
| **[v0.7 NEW] git 错误五分类** | 把 git 失败映射到 `MergeConflictError`/`RebaseConflictError`/`WorktreeLockedError`/`GitPermissionError`/`GitNetworkError` + 兜底 `Error`；前两类触发 retry，后三类不触发；详见 FR-36 |
| **[v0.7 NEW] `--magic`** | CLI 启动 flag；启用自主循环模式：ChainDef 追加 explore 链节、Explorer role 介入、`spawn_chain` 决策可派生新 chain |
| **[v0.7 NEW] `--magic-max-chains M`** | CLI flag / env `CO_MAGIC_MAX_CHAINS`；`--magic` 模式下 chain 派生层数上限；默认 `unlimited`；达上限时 `spawn_chain` 被降级为 `close_chain` |
| **[v0.7 NEW] Autonomous Loop / Magic Loop** | `--magic` 启动后形成的"chain N → Explorer 决策 → chain N+1"自动循环；终止条件：Explorer `close_chain` / Ctrl+C / 达 `--magic-max-chains` 上限 / 单链 aborted |
| **[v0.7 NEW] `chain_depth`** | chain manifest 字段；首条 chain depth=0；通过 `spawn_chain` 派生的子 chain depth = parent + 1 |
| **[v0.7 NEW] `parent_chain_id` / `child_chain_ids`** | chain manifest 字段；前者指向派生本链的父 chain（顶层链为 null）；后者列出所有由本链派生的子 chain |
| **[v0.7 NEW] `magic_mode`** | chain manifest boolean 字段；标记本链是否在 `--magic` 启动下创建 |
| **[v0.7 NEW] `chain_spawned`** | audit 事件类型；在父 chain 中记录派生事件，payload 含子 chain_id |
| **[v0.7 NEW] `chain_spawned_from`** | audit 事件类型；在子 chain 中记录起源事件，payload 含父 chain_id |
| **[v0.7 NEW] `magic_depth_exhausted`** | audit 事件类型；`--magic-max-chains` 达上限、`spawn_chain` 被降级时记录 |
| **[v0.7 NEW] `invalid_decision`** | audit 事件类型；非 explore link 发出 `spawn_chain` 时记录，链转 `aborted` |

## 7. Slash 命令与 Workspace memory

| 术语 | 释义 |
|------|------|
| **`/init`** | TUI 输入触发 workspace memory bootstrap 的 slash 命令 |
| **MemoryBootstrap** | Leader 子系统：枚举 `packages/**/*.ts`，为每个文件生成 memory 卡片到 `~/.claude-orchestrator/projects/<leader_id>/memory/<path>.md`（front-matter 含 `source_hash`） |
| **Workspace memory** | `~/.claude-orchestrator/projects/<leader_id>/memory/` 下的源码卡片集合 + 顶层 `CLAUDE.md` 索引 |
| **`source_hash`** | memory 卡片 front-matter 字段，对应源文件内容的 hash；refreshStale 比对漂移则重写 |

## 8. 缓存与产出

| 术语 | 释义 |
|------|------|
| **`cache_dir`** | 全局配置项，默认 `.claude-orchestrator/sessions`；Worker 共享日志/结果根目录 |
| **Result.md** | 任务结果文件 `~/.../tasks/<task_id>/result.md`；chain 内跨 Worker 共享 |
| **Exec log** | claude-cli stream-json 完整流 `~/.../tasks/<task_id>/exec-<ts>.log` |
| **Eval log** | 自评估日志 `~/.../tasks/<task_id>/eval-<N>.log`（最多 3 次） |
| **Merge log** | 合并决策日志 `~/.../merges/merge-<ts>.log` |
| **Worker 自留副本** | `~/.../docs/<worker>/<date>/<prefix>-<chain_id>.md`，单 Worker 视角的任务备份 |
