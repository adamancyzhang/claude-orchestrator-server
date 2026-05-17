# 07 — 术语表

> **文档定位**：PRD 中出现的核心术语统一释义；按概念域分组。详细 schema / 代码归属见 `../../rc0-v0.6/dd/contracts.md`。

## 1. 链路与责任链

| 术语 | 释义 |
|------|------|
| **Chain** | 一次需求拆解出的 plan → build → verify → review → accept 任务序列；由唯一 `chain_id` 标识；ChainAudit 持久化 manifest |
| **Link** | Chain 中的单个环节；五种之一：`plan` / `build` / `verify` / `review` / `accept`（schema: `TaskLinkSchema`） |
| **Responsibility Chain** | "Plan → Build → Verify → Review → Accept" 五环节序列模型；NEXT_LINKS / PREV_LINKS 定义在 Leader（`chain-router.ts`）与 Worker（`evaluator.ts`） |
| **Chain Manifest** | `~/.claude-orchestrator/projects/<leader_id>/chains/<chain_id>/manifest.json`；含 status / link_tasks / link_workers / total_retry_count / max_total_retries / requirement_path |
| **Chain Audit** | 单链审计三件套：`manifest.json` + `audit.jsonl` + `requirement.md` |
| **ChainStatus** | manifest 状态枚举：`running` / `completed` / `aborted` / `merge_failed` / `failed`（其中 `failed` 保留位） |
| **ChainDef** | decompose 输出的链定义 JSON，含 plan/build/verify/review/accept 5 个任务（plan 可为 null） |

## 2. 决策与协议

| 术语 | 释义 |
|------|------|
| **EvalDecision** | Worker 完成任务后自评估输出的 JSON，4 态：`activate_next` / `feedback` / `reject` / `close_chain` |
| **MergeDecision** | MergeValidator 由 `worker-merge-decision.md` 模板输出的 JSON，3 态：`merge` / `skip` / `review_first` |
| **PROTOCOL_VERSION** | 跨组件协议版本字段，当前 `"0.6.0"`；Worker 启动校验 `/leader` 节点协议版本不匹配即退出 |
| **`feedback_target`** | EvalDecision 中可选字段，显式指定 retry 派回的 Worker `InstanceId`；不提供则用 `manifest.link_workers[PREV_LINKS[link]]`；两者皆无则静默丢弃（FR-19） |

## 3. 身份与角色

| 术语 | 释义 |
|------|------|
| **Role** | Worker 注册时的偏好分数依据，5 个 worker role：`planner` / `builder` / `verifier` / `reviewer` / `accepter`，加 Leader 共 6 个 |
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

## 6. 失败与恢复（RC0 新增术语）

| 术语 | 释义 |
|------|------|
| **`max_total_retries`** | chain manifest 中持久化字段，单链总反馈次数硬上限；默认 9，`CO_CHAIN_MAX_RETRIES` 环境变量覆写 |
| **`total_retry_count`** | chain manifest 中持久化字段，原子递增的实际反馈次数 |
| **`retry_ceiling_exceeded`** | audit 事件类型 + manifest.extra.reason 取值；表示链因反馈累计超限被强制 `aborted` |
| **`merge_failed`** | ChainStatus 终态；表示 close_chain 时合并冲突，已对每个失败 link 派 retry task 给原 Builder |
| **`chain_merge_failed`** | EventBus 事件类型；TUI 红字渲染 `MERGE_FAILED chain <id>: N branch(es) ...` |
| **`chain_id_conflict`** | audit 事件类型；试图重写已终态 chain manifest 时记录，原 manifest 保留不被覆盖 |
| **`feedback_unresolved`** | audit 事件类型；feedback 无可解析 target 时记录，本次不派发新 task |
| **`CommitFailedError`** | 错误类，`git commit` 真实失败时抛出（与"无变更短路"区分）；触发强制 feedback 回同 Worker |
| **`ChainConflictError`** | 错误类，ChainAudit.openChain 检测到 chain_id 终态 manifest 已存在时抛出 |
| **`OrphanRetryExhaustedError`** | 错误类，孤儿任务 retry_count ≥ 3 时抛出 |

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
