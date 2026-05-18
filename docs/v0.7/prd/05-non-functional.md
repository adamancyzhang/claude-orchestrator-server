# 05 — 非功能性需求

> **文档定位**：可靠性、反馈韧性、性能、安全、可观测、可配置、协议版本 7 个维度的非功能性需求。每条给出关键指标与对应的实现机制（不复制 DD 细节，需要时链接到 `../dd/*`）。

## 1. 可靠性

| 指标 | 要求 |
|------|------|
| 单 Leader 保证 | ZK `/leader` EPHEMERAL 节点全局互斥；第二个 Leader 启动时检测节点已存在 → 抛 `ZK_NODE_EXISTS` 退出 |
| ZK 自动重连 | 指数退避最多 10 次；超出后进程退出 |
| Worker 子进程自动重启 | 父进程检测子进程 exit (non-zero) → 重启，最多 3 次；超过即放弃发 `worker_left` |
| 父进程死亡 → Worker 自杀 | Worker 每秒 `process.kill(process.ppid, 0)`；父进程不存在则自行 `process.exit(1)` |
| 孤儿任务回收 | Recovery 检测 EPHEMERAL `/tasks/claimed/*` owner 消失 → 重入 pending；`retry_count` ≤ `MAX_RETRY = 3`；超限归档 `failed` |
| Leader 崩溃 | Leader 是单点；崩溃后所有 Worker 进入 idle，操作员需重新执行 `run --worker N`；InitChecker / WorktreeInitializer 幂等（已有 worktree 跳过创建） |

`MAX_RETRY = 3` 是协议常量，不开放配置。

## 2. 反馈韧性

| 指标 | 要求 |
|------|------|
| 单链反馈硬上限 | `max_total_retries` 默认 9；`CO_CHAIN_MAX_RETRIES` 环境变量覆写；超限链强制 `aborted`、不再 push、emit `debug_info` + `chain_closed` |
| 不可解析 feedback | `resolveFeedbackTarget` 返回 null 时静默丢弃、记 audit `feedback_unresolved` + emit `debug_info`，不修改 chain status |
| chain_id 冲突 | 重写已终态 chain 的 manifest 被拒绝（抛 `ChainConflictError`）；原 manifest 不被覆盖；audit 记 `chain_id_conflict` |
| commit 失败 | 强制 feedback 回同 Worker；retry 计入 `total_retry_count` |
| evaluator 三连失败 | 强制 `reject`（不论 link），链转 `aborted`；不允许 "无声 close_chain" 绕过质量门 |
| 合并冲突 **[v0.7 rc1 修订]** | rc1 单次合并 accept-link：成功则 1 个 `--no-ff` commit；失败按 git 错误五分类分流（详见 FR-36） |
| **[v0.7 NEW]** `MergeConflictError` / `RebaseConflictError` | **触发 retry**：merge 冲突 → 派 retry 给 accept-link Worker；rebase 冲突 → 强制 feedback 给同 Worker；都计入 `total_retry_count` |
| **[v0.7 NEW]** `WorktreeLockedError` / `GitPermissionError` / `GitNetworkError` | **不触发 retry**：audit `merge_failure { category }` 后终止本次操作；提示操作员排查 `.git/index.lock` / 目录权限 / 网络 |
| **[v0.7 NEW]** Docs commit 失败 | best-effort 语义：`DocsCommitter.commitIfChanged` 返回 `null` 而非抛错；写入 `LinkCommitRecord.docs=null`；不阻塞 worktree commit 与 completion_report；不计入 retry |
| **[v0.7 NEW]** `--magic` 循环深度上限 | `--magic-max-chains M`（默认 `unlimited`），`CO_MAGIC_MAX_CHAINS` 环境变量覆写；达上限时 `spawn_chain` 决策被 Leader 降级为 `close_chain`、不再创建下一条 chain；audit 记 `magic_depth_exhausted` |
| **[v0.7 NEW]** Explorer 自我熔断 | Explorer 自评估失败 3 次仍触发 reject-only fallback（FR-22）；这种情况下不会跨链传播，magic 循环自动终止 |

详见 `../dd/06-tasks-and-workers.md`（Recovery、子进程重启、自杀机制）、`../dd/07-merge-validator-and-closure.md`（merge_failed 终态、accept-link retry）与 `04-functional-requirements.md` 第 6 / 7 域。

## 3. 性能

| 指标 | 要求 |
|------|------|
| Prompt cache 命中 | 身份卡（`--append-system-prompt`）与任务正文（`-p`）分离；身份卡每次调用稳定不变 → system prompt cache 命中；长期运行后计费 token 主要来自 user prompt |
| ZK 单节点容量 | ZK 原生限制 1 MiB；result 超过 64 KiB 落盘并以 `file://` 引用 |
| TUI 渲染节流 | TUI 在每个事件后重绘（ANSI escape-code），EVENT LOG 滚动保留最近 100 条 |
| `--fork-session` 干净分支 | SelfEvaluator 每次重试 `--fork-session` 消除格式错误输出的锚定效应 |
| 并发上限 | Worker 数默认 6，最小 6（默认模式：5 个 role + 1 个 executor 兜底；**[v0.7 NEW]** `--magic` 模式：6 个 role 精确匹配）；上限不硬约束（仅受机器资源限制） |

## 4. 安全

| 维度 | 措施 |
|------|------|
| 写隔离 | Worker 子进程独立 cwd + 独立分支 + 独立 worktree；commit 只在自己分支上 |
| 合并冲突保护 | MergeValidator 走 `git merge --abort` + `git checkout -` 回滚，main 不被破坏 |
| 子进程退出隔离 | Worker 崩溃只影响自己；父进程崩溃不留孤儿子进程（FR-25 自杀机制） |
| ZK ACL | 沿用 ZK 自身 ACL；本地开发默认无认证；生产部署可在 global config `zookeeper.auth` 启用 |
| Hook 隔离 | Hook 错误不破坏主流程，每个 hook 独立 try-catch + 5s 超时 |
| `--dangerously-skip-permissions` | 默认 claude-cli 命令含 `--dangerously-skip-permissions --permission-mode dontAsk`，假设运行环境（worktree）已受信任；操作员可在 global config `commands.claude-cli` 改写 |

## 5. 可观测

| 维度 | 实现 |
|------|------|
| TUI 6 面板 | TEAM / PENDING / IN PROGRESS / WORKER MESSAGES / EVENT LOG / INPUT；实时刷新 |
| ChainAudit | `~/.../chains/<chain_id>/{manifest.json, audit.jsonl, requirement.md}`；manifest 含 status / link_tasks / link_workers / total_retry_count / max_total_retries |
| Lifecycle hooks | 4 类事件：`worker_message_start` / `worker_message_end` / `task_claimed` / `task_completed`（外加内置 `task_recovered` / `task_failed`）；hook 接收 `CO_EVENT` / `CO_WORKER_NAME` / `CO_WORKER_ROLE` / `CO_TASK_ID` / `CO_MESSAGE_ID` / `CO_LINK` 环境变量 |
| 执行日志 | `~/.../tasks/<task_id>/exec-<ts>.log`（claude-cli stream-json 完整流） |
| 评估日志 | `~/.../tasks/<task_id>/eval-<N>.log`（最多 3 次） |
| Merge 日志 | `~/.../merges/merge-<ts>.log` |
| Worker 自留备份 | `~/.../docs/<worker>/<date>/<prefix>-<chain_id>.md` |
| 调试事件 | `debug_info` 事件类型在 EVENT LOG 显示（merge decision、feedback drop、chain abort 等关键决策） |

注：`stream_chunk` 事件类型已定义但 TUI 渲染层吸收为空字符串（当前不实时显示 streaming 输出），可通过 `tail -f exec-*.log` 观察。该限制列入 `06-boundaries.md` §5.1。

## 6. 可配置

### 6.1 四级配置合并

```
CLI 参数 / 环境变量          ← 最高
    ↑
Worktree 配置（<worktree>/.claude-orchestrator/config.json）
    ↑
项目根配置（<project>/.claude-orchestrator/config.json）
    ↑
全局配置（~/.claude-orchestrator/config.json）
    ↑
默认值                       ← 最低
```

### 6.2 关键配置项

| 配置 | 位置 | 默认值 / 覆写方式 |
|------|------|-------------------|
| ZK 连接地址 | 全局 `zookeeper.url` | `127.0.0.1:2181`；`-z` flag / `ZK_HOSTS` env 覆写 |
| ZK 根路径 | 全局 `zookeeper.root_path` | `/claude-orchestrator` |
| ZK 认证 | 全局 `zookeeper.auth` | `null` |
| cache_dir | 全局 `cache_dir` | `.claude-orchestrator/sessions` |
| claude CLI 命令 | 全局 `commands.claude-cli` | `claude --dangerously-skip-permissions --permission-mode dontAsk` |
| 4 类 hook | 全局 `hooks.*` | `null` |
| Worker 数 | CLI `--worker N` | 默认 6，最小 6 |
| chain 反馈硬上限 | env `CO_CHAIN_MAX_RETRIES` | 默认 9 |
| worktree 段落 | 项目根 | 启动时由 WorktreeInitializer 写入 |
| 单 Worker 身份 | worktree 内 | name / role / instance_id |
| **[v0.7 NEW]** merge 目标分支 | 全局 / 项目 `git.merge_target_branch` | `null`（fallback 到 Leader 启动时的 HEAD）；显式设 `"main"` 适用于 feature 分支启动但合并回 main |
| **[v0.7 NEW]** git 远端 | 全局 / 项目 `git.remote` | `"origin"`；设 `null` 关闭 MergeValidator `git fetch` 与 Worker pre-task `git fetch <sha>` |
| **[v0.7 NEW]** init 文件自动 commit | 全局 / 项目 `git.auto_commit_init_files` | `true`；orchestrator 启动时自动 commit 项目根 / CO root 的 init files |
| **[v0.7 NEW]** init commit 专用分支 | 全局 / 项目 `git.auto_commit_init_files_branch` | `null`（用当前分支）；非空时 `git checkout -B <branch>` 后 commit |
| **[v0.7 NEW]** worktree 复用清理 | orchestrator 内部参数 `reset_on_reuse` | `true`（worktree 复用时 `git reset --hard <leader_head>`，**有损**：丢弃未 commit 工作）；非用户配置层，详见 `../dd/06-tasks-and-workers.md` §1 |
| **[v0.7 NEW]** 自主循环开关 | CLI `--magic` flag | 默认关闭；启用后启用 explore 链节 + spawn_chain 决策 |
| **[v0.7 NEW]** 自主循环深度上限 | CLI `--magic-max-chains M` / env `CO_MAGIC_MAX_CHAINS` | 默认 `unlimited`；与 `--magic` 配合，控制 `spawn_chain` 派生新 chain 的最大层数 |

### 6.3 CLI 命令面

仅 `run` 与 `config` 两个 CLI 子命令开放给操作员；任务/消息/实例的 push/poll/claim 等不再以 CLI 形式开放（v0.5 曾有 13 命令）。脚本化操作通过 `@co/coordination` 包封装。该简化列入 `06-boundaries.md` §5.3。

`run` 子命令在 v0.7 接受的关键 flag：

| flag | 默认 | 说明 |
|------|------|------|
| `--worker N` | 6 | Worker 数；最小 6 |
| `-z <hosts>` | 全局配置 / 127.0.0.1:2181 | ZK 连接地址 |
| `--debug` | false | 启用 prompt 与执行 trace 打印 |
| **[v0.7 NEW]** `--magic` | false | 启用自主循环（追加 explore 链节 + spawn_chain 决策） |
| **[v0.7 NEW]** `--magic-max-chains M` | unlimited | `--magic` 模式下 chain 派生层数上限 |

详见 `../dd/01-architecture.md`（启动 5 阶段、Cache 目录、CLI 配置层）。

## 7. 协议版本

| 字段 | 值 |
|------|----|
| `PROTOCOL_VERSION` | **[v0.7 升级]** `"0.7.0"` |
| 升版本原因 | `TaskLinkSchema` 把 `"build"` 改名 `"execute"`（enum 重命名）、新增 `"explore"`；`EvalDecisionSchema` 新增 `"spawn_chain"`；`InstanceRoleSchema` 把 `"builder"` 改 `"executor"`、新增 `"explorer"`；`ChainManifest` 新增 `parent_chain_id` / `child_chain_ids` / `chain_depth` / `magic_mode` 4 字段。`build` → `execute` 与 `builder` → `executor` 是破坏性重命名 |
| 版本校验时机 | Worker 启动时读取 `/leader` 节点的协议版本字段；不匹配即退出 |
| 与 v0.6 兼容性 | **不兼容**。v0.7 Worker / Leader 禁止与 v0.6 混跑；升级时需停机重启全栈 |
| v0.7 后续不可破坏性变更 | 新增 optional 字段、新增 enum 值（后端兼容）、新增接口方法（带默认实现）—— 在 v0.7 维护期允许直接做 |

效果：多版本 Worker 与 Leader 混跑被禁止，强制全栈版本一致。
