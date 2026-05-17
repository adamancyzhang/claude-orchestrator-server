# 05 — 非功能性需求

> **文档定位**：可靠性、反馈韧性、性能、安全、可观测、可配置、协议版本 7 个维度的非功能性需求。每条给出关键指标与对应的实现机制（不复制 DD 细节，需要时链接到 `../../rc0-v0.6/dd/*`）。

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
| 合并冲突 | `runMergeValidation` 收集失败列表（不再吞噬）；close_chain 命中失败时链转 `merge_failed`，对每个失败 link 派 retry 给原 Builder |

详见 `../../rc0-v0.6/dd/error-and-recovery.md` §10 ~ §12 与 `04-functional-requirements.md` 第 6 / 7 域。

## 3. 性能

| 指标 | 要求 |
|------|------|
| Prompt cache 命中 | 身份卡（`--append-system-prompt`）与任务正文（`-p`）分离；身份卡每次调用稳定不变 → system prompt cache 命中；长期运行后计费 token 主要来自 user prompt |
| ZK 单节点容量 | ZK 原生限制 1 MiB；result 超过 64 KiB 落盘并以 `file://` 引用 |
| TUI 渲染节流 | TUI 在每个事件后重绘（ANSI escape-code），EVENT LOG 滚动保留最近 100 条 |
| `--fork-session` 干净分支 | SelfEvaluator 每次重试 `--fork-session` 消除格式错误输出的锚定效应 |
| 并发上限 | Worker 数默认 6，最小 6（保证 5 个 role + 1 个 builder 兜底）；上限不硬约束（仅受机器资源限制） |

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

### 6.3 CLI 命令面

仅 `run` 与 `config` 两个 CLI 子命令开放给操作员；任务/消息/实例的 push/poll/claim 等不再以 CLI 形式开放（v0.5 曾有 13 命令）。脚本化操作通过 `@co/coordination` 包封装。该简化列入 `06-boundaries.md` §5.3。

详见 `../../rc0-v0.6/dd/config-and-cli.md`。

## 7. 协议版本

| 字段 | 值 |
|------|----|
| `PROTOCOL_VERSION` | `"0.6.0"` |
| 版本校验时机 | Worker 启动时读取 `/leader` 节点的协议版本字段；不匹配即退出 |
| v0.7 是否升版本 | 否。v0.7 PRD 阶段无破坏性 contract 变更，沿用 `0.6.0`。当 `@co/contracts` 出现破坏性变更（删字段、改字段名、收窄类型、改语义）时才升 `0.7.0` |
| 不可破坏性变更 | 新增 optional 字段、新增 enum 值（后端兼容）、新增接口方法（带默认实现）—— 这些在 v0.7 维护期允许直接做 |

效果：多版本 Worker 与 Leader 混跑被禁止，强制全栈版本一致。
