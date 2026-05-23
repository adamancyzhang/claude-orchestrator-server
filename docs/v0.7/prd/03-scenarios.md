# 03 — 核心用户场景

> **文档定位**：9 个端到端用户场景，每个给出触发条件、用户体验（TUI 输出/事件）、系统行为、最终状态。前 4 个是 happy 路径，后 5 个（S-05 ~ S-09）是 RC0 修复触发的边界场景。

## 索引

| # | 场景 | 类别 |
|---|------|------|
| S-01 | 首次启动 | happy |
| S-02 | 输入需求 → 完整责任链 → close_chain → merge to main | happy |
| S-03 | 跨角色协助 | happy |
| S-04 | Worker 子进程崩溃 → 孤儿回收 + 自动重启 | happy（恢复路径） |
| S-05 | Execute 后 commit 失败 → 强制 feedback 回同 Worker | RC0（R-01） |
| S-06 | close_chain 合并冲突 → `merge_failed` + Executor retry | RC0（R-02） |
| **S-10**| **`--magic` 自主循环：Explorer `spawn_chain` 起下一条 chain** | 自主循环 |
| S-07 | 反馈循环超过 max_total_retries → 链 aborted | RC0（R-04） |
| S-08 | 不可解析 feedback → 静默丢弃 + audit | RC0（R-05） |
| S-09 | 已 completed 的 chain_id 被重新输入 → 拒绝 | RC0（R-06） |

附加 mini 场景：
- M-A：`/init` slash 触发 workspace memory bootstrap（FR-25）
- M-B：自评估三连失败 → 一律 `reject`（FR-19 + FR-22）

---

## S-01 — 首次启动

**触发**

```bash
claude-orchestrator run --worker 6
```

**用户体验**

1. 终端进入 TUI，6 个面板（TEAM / PENDING / IN PROGRESS / WORKER MESSAGES / EVENT LOG / INPUT）就位
2. TEAM 面板出现 6 行：Tom (planner) / Jerry (executor) / Lucy (verifier) / Thomas (reviewer) / Jack (accepter) / Lisa (executor)。 若加 `--magic` 启动，Lisa 的 role 变为 `explorer`，TUI 标题栏显示 `[MAGIC]`
3. EVENT LOG 滚动出现 `worker_joined ×6` 后稳定
4. INPUT 框出现光标

**系统行为**

| 阶段 | 动作 |
|------|------|
| 1. 环境自检 | InitChecker 校验：ZK 可达、claude CLI 可执行、global config 存在、worktree 父目录可写 |
| 2. 分配 6 Worker | 按优先级填充 role；写入项目根 `.claude-orchestrator/config.json` worktree 段落 |
| 3. 创建 worktree | `git worktree add` 6 次，分支命名 `claude-orchestrator/<name>-workspace` |
| 4. 启动 Leader | 抢占 ZK `/leader` EPHEMERAL；启动 WorkerMonitor / TaskOrchestrator / LeaderWatcher / Recovery 子系统；启动 TUI |
| 5. fork 6 Worker | 每个子进程 `chdir` 到自己的 worktree，注册 `/instances/<id>` EPHEMERAL，进入 ZK 消息监听循环 |

**最终状态**

- ZK `/claude-orchestrator/leader` 存在
- ZK `/claude-orchestrator/instances/*` 6 个 EPHEMERAL 节点
- `git worktree list` 显示 6 个 worktree
- TUI 等待用户输入

**错误旁支**

- `--worker 5` 直接报错 `\`--worker\` must be an integer >= 6` 并退出（最小并行度保证 5 个 role 都有兜底）

---

## S-02 — 输入需求 → 完整责任链 → close_chain → merge to main

**触发**

用户在 INPUT 框输入"实现用户认证模块"+ Enter。

**用户体验**（在 EVENT LOG 中按序出现）

```
user_input received
chain_activated chain-001
task_dispatch  plan    task-0000000001 → Tom        (upstream_commits={})
worker_message_received Tom  (plan started; no rebase — plan 是链起点)
task_completed task-0000000001 (Tom, plan; link_commit_record recorded)
task_dispatch  execute task-0000000002 → Jerry      (upstream_commits={plan: <SHA>})
worker_message_received Jerry  (pre-task rebase onto Tom's plan SHA, ok)
... (execute 完成；双轨 commit：项目仓代码 + CO root docs)
task_dispatch  verify  task-0000000003 → Lucy       (upstream_commits={plan, execute})
... (verify 完成)
task_dispatch  review  task-0000000004 → Thomas     (upstream_commits={plan, execute, verify})
... (review 完成)
task_dispatch  accept  task-0000000005 → Jack       (upstream_commits={plan, execute, verify, review})
worker_message_received Jack  (pre-task rebase onto Thomas's review SHA → accept 分支线性聚合整条链)
... (accept 完成)
debug_info     Merge: merge — Merged Jack's accept branch into main (single --no-ff commit)
chain_closed   chain-001  (completed)
```

**系统行为**

1. TUI 把输入写入 `/messages/{leader_id}/msg-NNNNN`（type=`user_input`）
2. LeaderWatcher 捕获 → ChainRouter.handleRequirement
3. ChainRouter 调用 decompose 模板（若已加载则 Leader 自处理；否则转发 Planner Worker）→ ChainDef JSON `{ plan, execute, verify, review, accept }`（`--magic` 启用时追加 `explore`）
4. ChainAudit `openChain(chain-001)` → 写入 `manifest.json`（status=`running`）+ `requirement.md`；`link_commits={}`、`upstream_commits={}`
5. push 5 个 task 到 `/tasks/pending/`；plan task 的 `upstream_commits={}`，下游 link 由 dispatch 时 `collectUpstreamCommits` 注入
6. Tom 的 ZK Watch 触发 → 认领 plan task → **pre-task rebase 跳过**（无上游）→ 渲染 `worker-plan.md` → `claude -p` 执行 → CommitChecker 双轨 commit（worktree + docs）→ 自评估 → completion_report(decision=activate_next, commits={worktree, docs, branch})
7. Leader 收到完成报告 → ChainRouter 调 `ChainAudit.recordLinkCommit(chain-001, plan, {…})` → activate_next → 调 `collectUpstreamCommits(chain-001)` 得 `{plan: <Tom 的 worktree SHA>}` → 派发 execute task 给 Jerry，注入 task.upstream_commits + message.upstream_commits
8. Jerry 收到 execute task → **pre-task rebase**：`git merge-base --is-ancestor <plan SHA> HEAD` → 不在 → `git rebase <plan SHA>` 把自己分支线性接到 plan 上 → 渲染 `worker-executor-task.md` → 执行 → 双轨 commit → completion_report
9. 重复至 Jack(accepter) 输出 `close_chain`；Jack 的 accept 分支已通过 pre-task rebase 串联 plan ← execute ← verify ← review ← accept
10. ChainRouter 触发 `runCloseChainMerge`：读 `manifest.link_commits.accept.{worktree, branch}` → **单次** `MergeValidator.validate(accept-link)` → `isCommitMerged` 判断 → claude-cli 给出 `decision='merge'` → `git checkout main && git merge --no-ff <accept.branch>` → 成功
11. ChainAudit `closeChain(chain-001, "completed")` → 发射 `chain_closed`

**最终状态**

- `~/.../chains/chain-001/manifest.json` `status: "completed"`、`link_commits` 5 个 link 的 record 都存在、`completed_at` 已写
- main 分支多出 **1 个** `--no-ff` merge commit（含整条链所有代码）
- 项目仓 5 个 per-Worker 分支保留；accept 分支为线性 tip
- CO root 仓 `docs/<worker_name>/` 下出现 5 个 `result.md` 并已 commit（轨 B，best-effort）
- audit.jsonl 含 `chain_opened` / `requirement_received` / `task_dispatch ×5`（带 upstream_commits）/ `completion_report ×5`（带 LinkCommitRecord）/ `merge_validation_completed` / `chain_closed`

---

## S-03 — 跨角色协助

**触发**

用户连续输入 2 个需求，execute link 任务积压 2-3 个；Jerry/Lisa 已忙；Lucy(verifier) idle。

**用户体验**

TEAM 面板中 Lucy 行的 Current Role 显示 `Executor ◀←`（箭头表示跨角色协助）。EVENT LOG 中 `task_claimed task-XXXX → Lucy` 与 `task_dispatch execute → Lucy` 出现。

**系统行为**

`TaskQueue.claim()` 按 role × link 权重表（verifier→execute=20）兜底匹配。Lucy 按 `worker-execute.md` 模板执行，无需额外配置。

**最终状态**

跨角色任务正常完成；后续若有 verify 任务到达，Lucy 立即按 verifier (100) 权重抢占。

---

## S-04 — Worker 子进程崩溃 → 孤儿回收 + 自动重启

**触发**

Jerry 正在执行 execute 任务时，操作员 `kill -9 <Jerry_pid>`。

**用户体验**（EVENT LOG）

```
worker_left      Jerry
task_recovered   task-XXXX (retry 1)
restart 1/3      Jerry
worker_joined    Jerry
task_claimed     task-XXXX → Jerry
```

**系统行为**

1. ZK 检测 Jerry 的 EPHEMERAL session 超时 → `/instances/Jerry` 节点消失
2. WorkerMonitor 发射 `worker_left` 事件
3. TaskOrchestrator 检测 `/tasks/claimed/<jerry_id>-task-XXXX` 仍存在但 owner 已消失 → Recovery.reclaim
4. `retry_count = 0 < MAX_RETRY (3)` → task 重入 `/tasks/pending/` 且 `retry_count = 1`
5. 父进程检测子进程 exit → `restart_count[Jerry]++` → 重启 Jerry 子进程
6. Jerry 重新注册 → 任意 Executor（含 Jerry 自己）认领该 task 续跑

**边界**

- 同一 task 重试达 3 次 → `failed` 归档（不再 pending）
- 同一 Worker 子进程崩溃达 3 次 → 放弃重启，发 `worker_left` 永久下线

---

## S-05 — Execute 后 commit 失败 → 强制 feedback 回同 Worker（R-01）

**触发**

Jerry 的 worktree 装有不通过的 `pre-commit` hook（如 `echo "no" >&2 && exit 1`）。Jerry 完成 execute 任务后尝试 `git commit` 失败。

**用户体验**（EVENT LOG）

```
worker_message_end Jerry execute
task_dispatch     execute (retry...) → Jerry
```

audit.jsonl 含 `feedback_sent` 事件，reason 字段含 "commit failed"。

**系统行为**

1. CommitChecker 内部 `git add -A && git commit` 失败 → 抛 `CommitFailedError(stderr)`
2. WorkerWatcher 捕获 → 跳过 SelfEvaluator、跳过 memory_refresh
3. 构造强制 feedback EvalDecision：
   ```json
   {
     "decision": "feedback",
     "feedback_to_worker": "git commit failed for execute task <id>...",
     "feedback_target": "<Jerry's instance_id>"
   }
   ```
4. completion_report 走 Leader 标准 feedback 分支 → push retry task 给 Jerry（同 Worker）
5. retry 计入 `total_retry_count`（受 `max_total_retries` 约束）

**最终状态**

不会发生"execute 任务标 completed 但实际无 commit"的情况；MergeValidator 看到的 chainCommits 严格只包含真实成功的 commit。

**修复前的旧行为**（已修复）

CommitChecker 静默 `return null` → watcher 走 self-evaluator → 通常输出 `activate_next` → 链推进到 verify → close_chain 时该 link 在 chainCommits 缺位 → 主线缺该 link 代码。

---

## S-06 — close_chain 合并冲突 → `merge_failed` + accept-link Worker retry（R-02）**[v0.7 修订]**

**触发**

链的 accept 分支（汇聚整条链代码）与 main 同时修改了同一文件不可自动合并的区域；链推进到 accept → close_chain（或 `--magic` 模式下 explore → close_chain / spawn_chain）。

**用户体验**

EVENT LOG 红色提示：

```
MERGE_FAILED chain chain-001: conflict on branch claude-orchestrator/Jack-workspace — retry pushed to Jack (accept-link)
chain_closed  chain-001  (merge_failed)
```

Jack（accept-link Worker）收件箱出现新 task_dispatch，description 含 `Merge conflict on branch <branch> at <sha>: <conflict_files>. Pull main, resolve conflicts in your worktree, re-commit, and self-evaluate.`

**系统行为**

1. ChainRouter.runCloseChainMerge 读 `manifest.link_commits.accept.{worktree, branch}` → `MergeValidator.validate({sha, branch, link:'accept', ...})`
2. MergeValidator 执行 `git merge --no-ff <accept.branch>` → 失败 → `merge --abort` + `checkout <prev>` → `classifyGitError` → 抛 `MergeConflictError(branch, conflict_files)`
3. ChainRouter 在 catch 中：
   a. audit `merge_failure { category: 'conflict', branch, error, conflict_files }`
   b. ChainAudit `closeChain(chainId, "merge_failed", { failures })`
   c. 发射 `chain_merge_failed` 事件（TUI 红字渲染）
   d. push 一条 priority=HIGH、assigned_to=**accept-link Worker**、link=`accept` 的 retry task（不按失败 link 派给中间 link 的 Worker）
4. emit `chain_closed`，链状态为 `merge_failed`

**与 worktree_locked / permission / network 的差异**

若失败是 `WorktreeLockedError` / `GitPermissionError` / `GitNetworkError`：

- audit 中 `category` 字段标识类别
- **不**派 retry task —— 这些是基础设施级失败，反复 retry 无意义
- 操作员排查后手动触发 close 重试

**后续（conflict 路径）**

Jack 在自己 worktree 中 `git fetch origin main && git rebase origin/main`，解决冲突、重新 commit → SelfEvaluator → 输出 `activate_next` → ChainRouter 在 `[merge retry]` 特例分支识别 → 重新触发 `runCloseChainMerge`。最终 main 含 1 个 `--no-ff` merge commit（单次合并），manifest.status 变为 `completed`。

**修复前的旧行为**（已修复）

- v0.6 `runMergeValidation` 用 `logger.warn` 吞掉失败、循环继续；`close_chain` 不论 failures 都写 `status="completed"` → 主线半合并、链标完成、用户无感（FR-17 修复）。
- v0.6 ancestry 检查依赖 `git branch --contains` —— shared `.git` 下永远返回 true，所有 merge 被静默跳过（改用 `git merge-base --is-ancestor` 修复，详见 `../dd/07-merge-validator-and-closure.md` §6.4）。

---

## S-07 — 反馈循环超过 max_total_retries → 链 aborted（R-04）

**触发**

链中出现"verify 总是 feedback 回 execute，execute 改完 verify 又 feedback"的循环；累计反馈次数达到 `max_total_retries`（默认 9，可通过 `CO_CHAIN_MAX_RETRIES` 环境变量覆写）。

**用户体验**（EVENT LOG）

```
[debug] chain chain-001 aborted: retry ceiling 9 exceeded
chain_closed  chain-001  (aborted)
```

**系统行为**

1. ChainRouter.dispatchFeedbackAsRetry 入口：
   a. `chain_audit.incrementRetry(chainId)` 返回 `{total_retry_count, max_total_retries}`
   b. 若 `total_retry_count > max_total_retries`：
      - 记 audit `retry_ceiling_exceeded`
      - `closeChain(chainId, "aborted", { reason: "retry_ceiling_exceeded", ... })`
      - 发射 `debug_info` + `chain_closed`
      - **不**派发新 task
   c. 否则正常 push retry

**最终状态**

- manifest.status = `aborted`
- manifest.extra.reason = `retry_ceiling_exceeded`
- 不再有新 task 被派发
- audit.jsonl 含 `retry_ceiling_exceeded` 事件

**覆写**

```bash
export CO_CHAIN_MAX_RETRIES=3
claude-orchestrator run --worker 6
```

设置为更小值便于测试；不开放 disable 选项（避免资源耗尽）。

---

## S-08 — 不可解析 feedback → 静默丢弃 + audit（R-05）

**触发**

plan link Worker 输出 EvalDecision `decision=feedback` 但未提供 `feedback_target`；manifest 中无 plan 的前置 link（plan 是链首）。

**用户体验**（EVENT LOG）

```
[debug] feedback for chain chain-001/plan dropped: no resolvable target
```

不再有新 task_dispatch 发出。chain 状态保持 `running` 不变。

**系统行为**

1. `resolveFeedbackTarget` 返回 `InstanceId | null`：
   - 优先用显式 `feedback_target`
   - 否则用 manifest.link_workers[PREV_LINKS[link]]
   - plan 无 PREV_LINKS → 返回 null
2. ChainRouter feedback case 处理 null：
   a. 不派发任何 task
   b. 记 audit `feedback_unresolved`
   c. 发射 `debug_info`
   d. 不修改 chain status

**修复前的旧行为**（已修复）

旧版 fallback 是"派回报告者自己" → 死循环风险。

---

## S-09 — 已 completed 的 chain_id 被重新输入 → 拒绝（R-06）

**触发**

跑通一条链 `chain-001` 至 `completed`；又有需求带相同 `chain_id` 进入 ChainRouter.handleTaskDefinitions（脚本注入或异常上游）。

**用户体验**（EVENT LOG）

```
[debug] chain chain-001 already completed; new requirement dropped
```

**系统行为**

1. ChainAudit.openChain 写盘前 readManifest(chain-001) → 存在且 `status !== "running"` → 抛 `ChainConflictError(chainId, existing_status, existing_completed_at)`
2. ChainRouter.handleTaskDefinitions catch 该错：
   a. 记日志 + emit `debug_info`
   b. 记 audit `chain_id_conflict`，payload 含 existing_status / completed_at / 本次需求 path
   c. 跳过本次需求（保留原 manifest 不变）

**最终状态**

原 manifest 不被覆盖；audit.jsonl 多一条 `chain_id_conflict`；新需求被丢弃，不会污染审计轨迹。

---

## M-A — `/init` slash 触发 workspace memory bootstrap（FR-25）

用户在 TUI 输入 `/init` + Enter。EVENT LOG 出现 `[debug] /init: bootstrap done`。

系统行为：

- MemoryBootstrap 枚举 `packages/**/*.ts` 源码，为每个文件生成对应 memory 卡片 `~/.claude-orchestrator/projects/<leader_id>/memory/<path>.md`（front-matter 含 `source_hash`）
- 同时生成顶层 `CLAUDE.md` 索引
- 重复 `/init` 跳过已生成且 `source_hash` 未变的项

后续 Executor commit 修改源文件后，发送 `memory_refresh` 消息触发增量刷新（FR-26）；下次 `/init` 时通过 `source_hash` 漂移检测刷新陈旧条目（FR-27）。

---

## M-B — 自评估三连失败 → 一律 `reject`（FR-19 + FR-22 / R-03）

Worker 完成任务后 SelfEvaluator 重试 3 次输出 JSON 都不符合 EvalDecision schema（如 LLM 返回 junk）。

- 第 1 次失败 → 追加 `worker-evaluate-format-hint.md` 再试
- 第 2、3 次仍失败 → 最终输出 fallback：
  ```json
  {
    "decision": "reject",
    "reason": "self-evaluation failed after 3 attempts (link=<link>) — see eval logs"
  }
  ```
- ChainRouter 收到 reject → 链直接转 `aborted`

**关键不变量**：fallback 一律 `reject`，不再像 v0.6 早期那样在 accept link "无声 close_chain"。破损评估器一定停链而非"无声签字"绕过质量门。

3 个 `eval-N.log` 文件保留在 cache 下供事后分析。

---

## S-10 — `--magic` 自主循环：Explorer `spawn_chain` 起下一条 chain

**触发**

操作员启动 `claude-orchestrator run --worker 6 --magic`；输入第一条种子需求"为该项目补一份 README"+ Enter。

**用户体验**（EVENT LOG）

```
[MAGIC] mode enabled
chain_activated chain-001 (depth=0, magic=true)
task_dispatch  plan    task-...0001 → Tom
... (plan → execute → verify → review 完成)
task_dispatch  accept  task-...0005 → Jack
[Jack accepted: Go]
task_dispatch  explore task-...0006 → Lisa
[Lisa: spawn_chain — next_requirement="补一份 CONTRIBUTING.md，沿用 README 的风格"]
debug_info     Merge: merge — ...    (chain-001 关闭 merge 完毕)
chain_closed   chain-001  (completed)
chain_spawned  chain-001 → chain-002 (depth=1)
chain_activated chain-002 (depth=1, parent=chain-001)
task_dispatch  plan    task-...0007 → Tom
... 第二轮链继续推进 ...
```

**系统行为**

1. ChainRouter.handleRequirement 在 `--magic` 上下文调用 decompose → ChainDef 含 6 任务（plan / execute / verify / review / accept / explore），全部 push 到 pending
2. ChainAudit `openChain(chain-001, { magic_mode: true, parent_chain_id: null, chain_depth: 0 })`
3. Tom~Jack 依次完成前 5 链节；Jack 在 accept link 输出 `activate_next`（次 link=explore），不再是 `close_chain`
4. Lisa(explorer) 认领 explore task → 渲染 `worker-explorer.md`，prompt 含完整 chain manifest + 各 link result.md 路径
5. Lisa 自评估输出 EvalDecision：
   ```json
   {
     "decision": "spawn_chain",
     "reason": "README 已完整；项目缺 CONTRIBUTING 与 issue/PR 模板",
     "next_requirement": "补一份 CONTRIBUTING.md，沿用 README 的风格"
   }
   ```
6. ChainRouter 收到完成报告 → 路由 `spawn_chain` 分支：
   a. 触发 MergeValidator.runMergeValidation(chain-001) → 所有 commit 合并到 main
   b. ChainAudit `closeChain(chain-001, "completed")`，写入 `child_chain_ids: [chain-002]`
   c. 生成新 chain_id = `chain-002`
   d. 用 `next_requirement` 内容 push 一条 `user_input` 类型消息到 `/messages/{leader_id}/msg-*`，附 `spawned_from: chain-001`
   e. LeaderWatcher 捕获 → handleRequirement 走标准 decompose 流程，ChainAudit `openChain(chain-002, { magic_mode: true, parent_chain_id: chain-001, chain_depth: 1 })`
   f. 发射 `chain_spawned chain-001 → chain-002`、`chain_closed chain-001 (completed)`、`chain_activated chain-002` 三事件

**循环终止**

3 种终止方式：

| 触发 | 行为 |
|------|------|
| Explorer 输出 `close_chain` | MergeValidator 关闭当前 chain → 整个 magic 循环停止；EVENT LOG 显示 `chain_closed chain-N (completed) — magic loop ended by explorer` |
| 操作员 Ctrl+C | 关停整个进程；in-flight 任务通过 EPHEMERAL 节点回收，未起的 chain 不再创建 |
| `--magic-max-chains M` 达上限 | 第 M 条 chain 的 explore link 即便输出 `spawn_chain` 也被 Leader 降级为 `close_chain` 处理（FR-34），EVENT LOG 出现 `magic loop depth M reached: spawn_chain demoted to close_chain` |

单链内部仍受 `max_total_retries` 约束：链 N 内部 verify ↔ execute 反复 feedback 超 9 次会被熔断为 `aborted`，整个 magic 循环停止（aborted 链不触发 spawn_chain，下一条 chain 不会自动生成）。

**最终状态**（跑 3 条 chain 后操作员 Ctrl+C）

- `~/.../chains/chain-001/manifest.json`：`status: "completed"`、`magic_mode: true`、`parent_chain_id: null`、`chain_depth: 0`、`child_chain_ids: ["chain-002"]`
- `chain-002`：`parent_chain_id: "chain-001"`、`chain_depth: 1`、`child_chain_ids: ["chain-003"]`
- `chain-003`：`chain_depth: 2`、Ctrl+C 时如在 in-flight，状态由 Recovery 决定
- audit.jsonl 在 chain-001 中含 `chain_spawned (child=chain-002)`；在 chain-002 中含 `chain_spawned_from (parent=chain-001)`
