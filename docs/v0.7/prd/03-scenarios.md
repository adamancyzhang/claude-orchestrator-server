# 03 — 核心用户场景

> **文档定位**：9 个端到端用户场景，每个给出触发条件、用户体验（TUI 输出/事件）、系统行为、最终状态。前 4 个是 happy 路径，后 5 个（S-05 ~ S-09）是 RC0 修复触发的边界场景。

## 索引

| # | 场景 | 类别 |
|---|------|------|
| S-01 | 首次启动 | happy |
| S-02 | 输入需求 → 完整责任链 → close_chain → merge to main | happy |
| S-03 | 跨角色协助 | happy |
| S-04 | Worker 子进程崩溃 → 孤儿回收 + 自动重启 | happy（恢复路径） |
| S-05 | Build 后 commit 失败 → 强制 feedback 回同 Worker | RC0（R-01） |
| S-06 | close_chain 合并冲突 → `merge_failed` + Builder retry | RC0（R-02） |
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
2. TEAM 面板出现 6 行：Tom (planner) / Jerry (builder) / Lucy (verifier) / Thomas (reviewer) / Jack (accepter) / Lisa (builder)
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
task_dispatch  plan    task-0000000001 → Tom
worker_message_received Tom  (plan started)
task_completed task-0000000001 (Tom, plan)
task_dispatch  build   task-0000000002 → Jerry
... (build 完成)
task_dispatch  verify  task-0000000003 → Lucy
... (verify 完成)
task_dispatch  review  task-0000000004 → Thomas
... (review 完成)
task_dispatch  accept  task-0000000005 → Jack
... (accept 完成)
debug_info     Merge: merge — Merged claude-orchestrator/Tom-workspace ...
debug_info     Merge: merge — Merged claude-orchestrator/Jerry-workspace ...
... (5 次)
chain_closed   chain-001  (completed)
```

**系统行为**

1. TUI 把输入写入 `/messages/{leader_id}/msg-NNNNN`（type=`user_input`）
2. LeaderWatcher 捕获 → ChainRouter.handleRequirement
3. ChainRouter 调用 decompose 模板（若已加载则 Leader 自处理；否则转发 Planner Worker）→ ChainDef JSON `{ plan, build, verify, review, accept }`
4. ChainAudit `openChain(chain-001)` → 写入 `manifest.json`（status=`active`）+ `requirement.md`
5. push 5 个 task 到 `/tasks/pending/`
6. Tom 的 ZK Watch 触发 → 认领 plan task → 渲染 `worker-plan.md` → `claude -p` 执行 → 自动 commit → 自评估 → completion_report(activate_next)
7. Leader 收到完成报告 → activate_next → 派发 build task 给 Jerry
8. 重复至 Jack(accepter) 输出 `close_chain`
9. ChainRouter 触发 MergeValidator.runMergeValidation：遍历链内 5 个 commit，逐个调用 `worker-merge-decision.md`（claude-cli 执行 `git merge-base / git merge --no-ff`）
10. 全部成功 → ChainAudit `closeChain(chain-001, "completed")` → 发射 `chain_closed`

**最终状态**

- `~/.../chains/chain-001/manifest.json` `status: "completed"`
- main 分支多出 5 个 `--no-ff` merge commit
- 5 个 `tasks/<task_id>/result.md` 文件
- audit.jsonl 含 `chain_opened` / `requirement_received` / `task_dispatch ×5` / `completion_report ×5` / `chain_closed`

---

## S-03 — 跨角色协助

**触发**

用户连续输入 2 个需求，build link 任务积压 2-3 个；Jerry/Lisa 已忙；Lucy(verifier) idle。

**用户体验**

TEAM 面板中 Lucy 行的 Current Role 显示 `Builder ◀←`（箭头表示跨角色协助）。EVENT LOG 中 `task_claimed task-XXXX → Lucy` 与 `task_dispatch build → Lucy` 出现。

**系统行为**

`TaskQueue.claim()` 按 role × link 权重表（verifier→build=20）兜底匹配。Lucy 按 `worker-build.md` 模板执行，无需额外配置。

**最终状态**

跨角色任务正常完成；后续若有 verify 任务到达，Lucy 立即按 verifier (100) 权重抢占。

---

## S-04 — Worker 子进程崩溃 → 孤儿回收 + 自动重启

**触发**

Jerry 正在执行 build 任务时，操作员 `kill -9 <Jerry_pid>`。

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
6. Jerry 重新注册 → 任意 Builder（含 Jerry 自己）认领该 task 续跑

**边界**

- 同一 task 重试达 3 次 → `failed` 归档（不再 pending）
- 同一 Worker 子进程崩溃达 3 次 → 放弃重启，发 `worker_left` 永久下线

---

## S-05 — Build 后 commit 失败 → 强制 feedback 回同 Worker（R-01）

**触发**

Jerry 的 worktree 装有不通过的 `pre-commit` hook（如 `echo "no" >&2 && exit 1`）。Jerry 完成 build 任务后尝试 `git commit` 失败。

**用户体验**（EVENT LOG）

```
worker_message_end Jerry build
task_dispatch     build (retry...) → Jerry
```

audit.jsonl 含 `feedback_sent` 事件，reason 字段含 "commit failed"。

**系统行为**

1. CommitChecker 内部 `git add -A && git commit` 失败 → 抛 `CommitFailedError(stderr)`
2. WorkerWatcher 捕获 → 跳过 SelfEvaluator、跳过 memory_refresh
3. 构造强制 feedback EvalDecision：
   ```json
   {
     "decision": "feedback",
     "feedback_to_worker": "git commit failed for build task <id>...",
     "feedback_target": "<Jerry's instance_id>"
   }
   ```
4. completion_report 走 Leader 标准 feedback 分支 → push retry task 给 Jerry（同 Worker）
5. retry 计入 `total_retry_count`（受 `max_total_retries` 约束）

**最终状态**

不会发生"build 任务标 completed 但实际无 commit"的情况；MergeValidator 看到的 chainCommits 严格只包含真实成功的 commit。

**修复前的旧行为**（已修复）

CommitChecker 静默 `return null` → watcher 走 self-evaluator → 通常输出 `activate_next` → 链推进到 verify → close_chain 时该 link 在 chainCommits 缺位 → 主线缺该 link 代码。

---

## S-06 — close_chain 合并冲突 → `merge_failed` + Builder retry（R-02）

**触发**

Builder worktree 与 main 同时修改了同一文件不可自动合并的区域；链推进到 accept → close_chain。

**用户体验**

EVENT LOG 红色提示：

```
MERGE_FAILED chain chain-001: 1 branch(es) [claude-orchestrator/Jerry-workspace] — retry tasks pushed
chain_closed  chain-001  (merge_failed)
```

Jerry 收件箱出现新 task_dispatch，description 含 `Merge conflict on branch <branch> at <sha>: <message>. Pull main, resolve conflicts in your worktree, re-commit, and re-run this link.`

**系统行为**

1. ChainRouter.runMergeValidation 遍历 chainCommits 时收集失败 `{link, sha, branch, message, error}` 入 failures 列表（不再吞噬）
2. 链路 close_chain 分支检测 failures 非空 →
   a. 每个失败 audit `merge_failure` 事件
   b. ChainAudit `closeChain(chainId, "merge_failed", { failures })`
   c. 发射 `chain_merge_failed` 事件（TUI 红字渲染）
   d. 对每个失败 link 从 manifest.link_workers 查到对应 Worker，push 一条 priority=0、assigned_to=该 Worker、link=失败 link 的 retry task
3. emit `chain_closed`，链状态为 `merge_failed`

**后续**

Builder 在自己 worktree 中 `git pull main && git merge`，解决冲突、重新 commit → 接到的 retry task 走标准链路推进。最终 main 含完整链 commit，manifest.status 变为 `completed`（注：每次 retry 起的是子流程，不复用旧的 close_chain）。

**修复前的旧行为**（已修复）

`runMergeValidation` 用 `logger.warn` 吞掉失败、循环继续；`close_chain` 不论 failures 都写 `status="completed"` → 主线半合并、链标完成、用户无感。

---

## S-07 — 反馈循环超过 max_total_retries → 链 aborted（R-04）

**触发**

链中出现"verify 总是 feedback 回 build，build 改完 verify 又 feedback"的循环；累计反馈次数达到 `max_total_retries`（默认 9，可通过 `CO_CHAIN_MAX_RETRIES` 环境变量覆写）。

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

不再有新 task_dispatch 发出。chain 状态保持 `active` 不变。

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

后续 Builder commit 修改源文件后，发送 `memory_refresh` 消息触发增量刷新（FR-26）；下次 `/init` 时通过 `source_hash` 漂移检测刷新陈旧条目（FR-27）。

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
