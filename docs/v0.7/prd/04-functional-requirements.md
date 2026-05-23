# 04 — 功能需求

> **文档定位**：v0.7 功能需求清单（FR-01 ~ FR-37），按 12 个功能域分组。每条 FR 给出一句话描述、用户价值、完成判定（2-3 条关键勾选项）、追溯 A-/R- 编号（沿用 v0.6 RC0 feature-matrix 的编号体系,旧 feature-matrix 文档已随 v0.6 目录移除）。
>
> 完成判定只列关键 done 条件；v0.7 不再维护独立的 acceptance checklist 文档,以每条 FR 末尾的"done 判定"作为验收单。

## FR 索引

| 功能域 | FR 编号 |
|--------|---------|
| 1. 启动与 TUI | FR-01 ~ FR-04 |
| 2. 身份与角色 | FR-05 ~ FR-08 |
| 3. 责任链结构 | FR-09 ~ FR-11 |
| 4. 任务执行 | FR-12 ~ FR-14 |
| 5. 合并与关闭 | FR-15 ~ FR-17 |
| 6. 链推进与反馈保护 | FR-18 ~ FR-20 |
| 7. 失败保护 | FR-21 ~ FR-22 |
| 8. 恢复 | FR-23 ~ FR-25 |
| 9. 审计与缓存 | FR-26 ~ FR-27 |
| 10. Workspace memory | FR-28 ~ FR-30 |
| **11. ��自主循环调度**| **FR-31 ~ FR-35** |
| **12. ��rc1 worktree 工作流**| **FR-36 ~ FR-37** |

---

## 1. 启动与 TUI

### FR-01 — 一键启动 `run --worker N`

| 字段 | 内容 |
|------|------|
| 一句话 | `claude-orchestrator run --worker N`（N≥6，默认 6）一条命令完成环境自检、worktree 创建、Leader+Worker 子进程启动 |
| 用户价值 | 操作员零配置启动系统 |
| 完成判定 | (a) 不带 `--worker` 默认 6；(b) `--worker 5` 报错 `\`--worker\` must be an integer >= 6` 并退出；(c) 启动后 ZK `/leader` 与 6 个 `/instances/*` 节点（均 EPHEMERAL）存在 |
| 追溯 | A-01 |

### FR-02 — TUI 六面板

| 字段 | 内容 |
|------|------|
| 一句话 | TUI 渲染 6 个面板：TEAM / PENDING / IN PROGRESS / WORKER MESSAGES / EVENT LOG / INPUT |
| 用户价值 | 全态势可见，无需切窗口 |
| 完成判定 | (a) 启动即出现 6 面板；(b) PENDING/IN PROGRESS 随任务状态实时刷新；(c) EVENT LOG 滚动保留最近 100 条事件 |
| 追溯 | A-09 |

### FR-03 — TUI 键盘交互

| 字段 | 内容 |
|------|------|
| 一句话 | Tab/Shift+Tab 切换 WORKER MESSAGES 焦点；1-9 直跳；Enter 提交；Backspace 删字；Esc 清空；? 切帮助；Ctrl+C 关停 |
| 用户价值 | 全键盘操作，无鼠标 |
| 完成判定 | (a) 上述 7 类键位响应正确；(b) Ctrl+C 关停所有 Worker 子进程不留孤儿 |
| 追溯 | A-10 |

### FR-04 — 输入框路由

| 字段 | 内容 |
|------|------|
| 一句话 | INPUT 框 + Enter → 写入 `/messages/{leader_id}/msg-*`（type=`user_input`）→ LeaderWatcher 路由 → ChainRouter.handleRequirement |
| 用户价值 | 自然语言即可驱动责任链 |
| 完成判定 | (a) 输入"做一个登录功能"+Enter 后 `/messages/{leader_id}/msg-*` 多一条 `user_input`；(b) 后续 `chain_activated` + 5 个 `task_created` |
| 追溯 | A-11 |

---

## 2. 身份与角色

### FR-05 — 角色权重表

| 字段 | 内容 |
|------|------|
| 一句话 | `roleWeights.ts` 定义 6 role × 5 link 的权重矩阵；TaskQueue.claim() 按权重排序认领 |
| 用户价值 | 角色解耦：任何 Worker 可兜底任意 link，避免单角色瓶颈 |
| 完成判定 | (a) `roleWeights.ts` 与 `02-personas-and-roles.md` §4 权重表一致；(b) TEAM 面板显示每 Worker 的 name + role |
| 追溯 | A-05 |

### FR-06 — 名称池 + 角色优先级分配

| 字段 | 内容 |
|------|------|
| 一句话 | 20 个拟人化名称池；启动时按 `planner > executor > verifier > reviewer > accepter` 优先级填充；6 个 Worker 时第 6 个补 executor |
| 用户价值 | TUI 中能用易记的名字区分 Worker |
| 完成判定 | (a) 启动 6 Worker，TEAM 出现 6 个名字来自池；(b) role 分配满足优先级；(c) 启动 7 Worker，第 7 个为 executor |
| 追溯 | A-06 |

### FR-07 — Git Worktree 隔离

| 字段 | 内容 |
|------|------|
| 一句话 | 每个 Worker 独占 `<project>/.claude-orchestrator/worktree/<name>/` + 独立分支 `claude-orchestrator/<name>-workspace` |
| 用户价值 | 多 Worker 并发互不污染 |
| 完成判定 | (a) `git worktree list` 显示 6 个 worktree；(b) `cat .claude-orchestrator/config.json` 显示 worktree 段落含 6 条；(c) Worker 子进程 cwd 与主 worktree 不同 |
| 追溯 | A-07 |

### FR-08 — 身份注入（三段拼接 + cache 友好）

| 字段 | 内容 |
|------|------|
| 一句话 | `worker-identity.md` + `personal-claude-{role}.md` + `worker-{role}.md` 三段拼接，通过 `--append-system-prompt` 注入；任务正文通过 `-p` 注入 |
| 用户价值 | 身份/任务正交 → system prompt cache 命中，长期成本低 |
| 完成判定 | (a) 任务运行时 `ps aux | grep claude` 看到 `--append-system-prompt`；(b) 注入串含 "You are **<name>**, a **<role>**"；(c) `worker-identity.md` 中 5 个占位符全部被替换 |
| 追溯 | A-08 |

---

## 3. 责任链结构

### FR-09 — 五链责任链

| 字段 | 内容 |
|------|------|
| 一句话 | plan → execute → verify → review → accept 五环节固定顺序； `--magic` 模式下追加 explore 第 6 环；NEXT_LINKS / PREV_LINKS 与 CHAIN_LINKS 在 Leader 与 Worker 两处同步定义 |
| 用户价值 | 明确的"做什么 → 做完了什么 → 谁来验"流水线 |
| 完成判定 | (a) Leader `NEXT_LINKS`/`PREV_LINKS` 与 Worker `CHAIN_LINKS` 一致；(b) 输入 "hello world" 需求后 EVENT LOG 依次出现 5 次 `task_dispatch` 与最后的 `chain_closed` |
| 追溯 | A-02 |

### FR-10 — EvalDecision 五态 **[v0.7 五态]**

| 字段 | 内容 |
|------|------|
| 一句话 | Worker 自评估输出 `activate_next` / `feedback` / `reject` / `close_chain` / **`spawn_chain`** 五态 JSON；ChainRouter 按态机械路由 |
| 用户价值 | 链路推进规则封闭、可审计；新增 `spawn_chain` 让 Explorer 自主起新链 |
| 完成判定 | (a) `activate_next` 路径正常推进；(b) `feedback` 派 retry 给上一 link；(c) `reject` 转链 `aborted`；(d) `close_chain` 触发 MergeValidator 合并并关链；(e) `spawn_chain` 仅在 explore link 合法，触发 MergeValidator 关现链 + 用 Explorer 提供的新需求开下一 chain（新 chain_id）；非 explore link 发出 `spawn_chain` 视作 `ValidationError` 被 reject |
| 追溯 | A-03 |

### FR-11 — ChainDef 拆解（plan 可选）

| 字段 | 内容 |
|------|------|
| 一句话 | decompose 模板输出 ChainDef JSON 含 `plan` / `execute` / `verify` / `review` / `accept` 5 任务（`--magic` 模式追加 `explore` 第 6 任务）；`plan` 字段允许为 null |
| 用户价值 | 简单需求可跳过 plan 直接 execute |
| 完成判定 | (a) 默认 5 任务入 pending；(b) `"plan": null` 时只有 4 任务入 pending，首任务为 execute；(c) `--magic` 启用时 6 任务入 pending，末任务为 explore |
| 追溯 | A-04 |

---

## 4. 任务执行

### FR-12 — 自评估三连重试 + format-hint

| 字段 | 内容 |
|------|------|
| 一句话 | Worker 完成任务后 SelfEvaluator 最多 3 次重试解析 EvalDecision；第 2/3 次追加 `worker-evaluate-format-hint.md`；每次 `--fork-session` 消除锚定 |
| 用户价值 | 容忍 LLM 输出格式抖动 |
| 完成判定 | (a) `evaluator.test.ts` 通过；(b) 模拟 junk JSON 时 cache 下出现 3 个 `eval-N.log` |
| 追溯 | A-15 |

### FR-13 — 自动 commit（双轨）+ pre-task rebase + claude 生成 message **[v0.7 修订]**

| 字段 | 内容 |
|------|------|
| 一句话 | 任务开始：Worker 用 `msg.upstream_commits` 中的上游 SHA 执行 `git rebase` 到上游 link，把链内 plan ← execute ← verify ← review ← accept 线性串联；任务结束：**双轨 commit** —— 轨 A `CommitChecker.maybeCommit` 提交代码到项目仓 per-Worker 分支，轨 B `DocsCommitter.commitIfChanged` 提交 `docs/<worker_name>/` 到 CO root 仓（best-effort）；commit message 由 claude 按 `worker-commit-message.md` 生成（≤72 字符），失败 fallback `chore: auto-commit from {Name}` |
| 用户价值 | Worker 产出无需操作员手 commit；accept-link 分支聚合整条链代码 → close_chain 单次合并即可（FR-15 配套优化） |
| 完成判定 | (a) Execute 完成后 Worker worktree `git log -1` 有新 commit；(b) commit message 首行 ≤72 字符；(c) accept-link 完成后该 worker 分支 `git log --oneline` 含整条链所有 commits 线性排列；(d) CO root 仓 `docs/<worker_name>/` 出现 `result.md`，对应 commit 存在（best-effort，失败不阻断） |
| 追溯 | A-16 |

### FR-14 — Lifecycle hooks

| 字段 | 内容 |
|------|------|
| 一句话 | 支持 4 类 hook：`worker_message_start` / `worker_message_end` / `task_claimed` / `task_completed`（外加内置 `task_recovered` / `task_failed`）；通过 global config `hooks.*` 配置；hook 接收 `CO_EVENT` / `CO_WORKER_NAME` / `CO_TASK_ID` 等环境变量 |
| 用户价值 | 操作员可挂接通知 / 监控 / 日志归档 |
| 完成判定 | (a) `hooks.worker_message_start` 配 `echo $CO_TASK_ID >> /tmp/hook.log` 后跑一链至少 5 行写入；(b) hook 失败不影响主流程（5s 超时 + try-catch） |
| 追溯 | A-24 |

---

## 5. 合并与关闭

### FR-15 — MergeValidator（merge / skip / review_first）**[v0.7 修订]**

| 字段 | 内容 |
|------|------|
| 一句话 | MergeValidator 用 `git merge-base --is-ancestor` 在 TS 层做 ancestry 检查（避免 v0.6 shared `.git` 误判），再通过 `worker-merge-decision.md` 模板让 claude-cli 给出 3 态 MergeDecision；真正的 `git checkout / merge / abort` 由 MergeValidator 用 `execFileSync('git', args[])` 数组形式执行；git 失败按错误五分类（FR-36） |
| 用户价值 | 合并决策由 LLM 上下文感知，ancestry 判断与 git 执行由 TS 精确控制；shell 注入防护到位 |
| 完成判定 | (a) 链 close 时 cache 下 `merges/merge-*.log` 出现且含 MergeDecision JSON；(b) claude-cli 解析失败 / 超时 → ValidationError 转 `review_first`（保守）；(c) merge 失败 → 按错误类型抛 `MergeConflictError / WorktreeLockedError / GitPermissionError / GitNetworkError`（FR-36） |
| 追溯 | A-17 |

### FR-16 — close_chain 触发 runCloseChainMerge（单次合并 accept-link）**[v0.7 修订]**

| 字段 | 内容 |
|------|------|
| 一句话 | accept link 输出 `close_chain` → ChainRouter `runCloseChainMerge` 读 `manifest.link_commits.accept`，只合并 accept-link 分支到 main（**单次**而非逐 link）；成功 → `closeChain(chainId, "completed")`；缺失 link_commits 时退回 v0.6 逐 link 迭代（legacy fallback） |
| 用户价值 | close_chain 决策与 git 操作从 O(N) 降到 O(1)；main 上只多一个 `--no-ff` merge commit（含整条链） |
| 完成判定 | (a) 跑通一条链后 main 分支多 **1 个** `--no-ff` merge commit；(b) `~/.../chains/<chain_id>/manifest.json` `status: "completed"` 且 `completed_at` 已写；(c) `manifest.link_commits.accept.{worktree, branch}` 都非空 |
| 追溯 | A-18 |

### FR-17 — `merge_failed` 终态 + accept-link Worker retry **[v0.7 修订]**

| 字段 | 内容 |
|------|------|
| 一句话 | 合并失败 → `closeChain(chainId, "merge_failed", { failures })` → 发射 `chain_merge_failed` 事件 → 仅当失败类别是 `conflict` 时派 retry task 给 **accept-link Worker**（rc1：他汇聚整条链代码，是合并目标的唯一所有者）；锁/权限/网络类（FR-36 中 worktree_locked / permission / network）不派 retry、仅 audit；TUI 红字渲染 `MERGE_FAILED chain <id>: <category> ...` |
| 用户价值 | 主分支永远只接受成功 merge；conflict 显式回到 accept-link Worker 解决；基础设施类失败不浪费 retry，提示操作员介入 |
| 完成判定 | (a) 构造冲突场景后 EVENT LOG 出现红色 `MERGE_FAILED chain <id>`；(b) accept-link Worker 收件箱出现新 task_dispatch，描述含 "Merge conflict on branch ..."；(c) `manifest.json` status = `merge_failed`；(d) 锁/权限/网络场景下**无** retry task，仅 audit `merge_failure { category }` |
| 追溯 | R-02（含 R-07） |

---

## 6. 链推进与反馈保护

### FR-18 — 反馈硬上限（`max_total_retries`）

| 字段 | 内容 |
|------|------|
| 一句话 | chain manifest 持久化 `total_retry_count` 与 `max_total_retries`（默认 9，`CO_CHAIN_MAX_RETRIES` 环境变量覆写）；超限链强制 `aborted` 不再 push |
| 用户价值 | 防止"verify ↔ execute 死循环"耗尽资源；`--magic` 下也限制 chain → chain 循环不能无限通过反复 feedback 内部链路 |
| 完成判定 | (a) 设 `CO_CHAIN_MAX_RETRIES=2` 后第 3 次反馈被阻止；(b) 该链 manifest.status = `aborted`，extra.reason = `retry_ceiling_exceeded`；(c) audit.jsonl 含 `retry_ceiling_exceeded`；(d) 不设环境变量时默认 9 |
| 追溯 | R-04 |

### FR-19 — feedback target 不可解析 → 静默丢弃 + audit

| 字段 | 内容 |
|------|------|
| 一句话 | `resolveFeedbackTarget` 返回 `InstanceId \| null`：优先用 explicit `feedback_target`，否则 manifest.link_workers[PREV_LINKS[link]]，都没有则 null；null 时不派发新 task、记 audit `feedback_unresolved`、emit `debug_info` |
| 用户价值 | 避免 v0.6 早期 fallback 到报告者自己造成的死循环 |
| 完成判定 | (a) plan link 输出无目标的 feedback 后 EVENT LOG 出现 `feedback for chain <id>/plan dropped: no resolvable target`；(b) 无任何新 task_dispatch；(c) audit.jsonl 含 `feedback_unresolved` |
| 追溯 | R-05 |

### FR-20 — chain_id 冲突拒绝

| 字段 | 内容 |
|------|------|
| 一句话 | ChainAudit.openChain 检测同 chain_id 终态 manifest 存在 → 抛 `ChainConflictError`；ChainRouter 捕获后 emit `debug_info` + audit `chain_id_conflict`，丢弃本次需求，原 manifest 不被覆盖 |
| 用户价值 | 审计文件不会出现 `completed → running → completed` 的混乱轨迹 |
| 完成判定 | (a) 跑通一条链至 `completed` 后再次注入同 chain_id 的需求 → EVENT LOG 出现 `chain <id> already completed; new requirement dropped`；(b) audit.jsonl 含 `chain_id_conflict`，原 manifest 未被覆盖 |
| 追溯 | R-06 |

---

## 7. 失败保护

### FR-21 — commit 失败 → 强制 feedback 回同 Worker

| 字段 | 内容 |
|------|------|
| 一句话 | CommitChecker 区分"无变更短路（返回 null）"与"`git commit` 真实失败（抛 CommitFailedError）"；后者由 WorkerWatcher 捕获后跳过 SelfEvaluator、构造强制 `feedback` 决策（feedback_target = 自己）→ 走 Leader feedback 分支 → push retry task 给同一 Worker；retry 计入 `total_retry_count` |
| 用户价值 | 避免 commit 失败被静默吞噬，让 MergeValidator 漏 commit |
| 完成判定 | (a) 装 fail 的 `pre-commit` hook 后 EVENT LOG 出现 retry task_dispatch 回同 Worker（不是 close_chain 也不是 activate_next）；(b) audit.jsonl 含 `feedback_sent`，原因为 "commit failed"；(c) 移除 hook 后下次 retry 正常完成 |
| 追溯 | R-01 |

### FR-22 — SelfEvaluator 三连失败一律 `reject`

| 字段 | 内容 |
|------|------|
| 一句话 | SelfEvaluator 3 次解析仍失败时强制输出 `{ "decision": "reject", "reason": "self-evaluation failed after 3 attempts (link=<link>) — see eval logs" }`，不论当前 link 是否 accept |
| 用户价值 | 破损评估器一定停链，禁止 accept link "无声 close_chain"绕过质量门 |
| 完成判定 | (a) `evaluator.test.ts` "falls back to reject" / "NOT close_chain when accept fails" 通过；(b) accept link 评估器三连 junk 输出后 completion_report.content `decision === "reject"`；(c) ChainAudit manifest.status 转 `aborted` 而非 `completed` |
| 追溯 | R-03 |

---

## 8. 恢复

### FR-23 — 孤儿任务回收

| 字段 | 内容 |
|------|------|
| 一句话 | Recovery 在 Leader 启动时 `scanOrphans()` + 运行时监听 `/tasks/claimed` 变化 → 检测到 owner instance 消失则重入 pending 且 `retry_count++`；`retry_count >= 3` 归档为 `failed` |
| 用户价值 | Worker 异常退出后任务自动重排，不悬挂 |
| 完成判定 | (a) `kill -9` 某 Worker 后 EVENT LOG 出现 `worker_left` → `task_recovered (retry 1)`；(b) 重复 kill 4 次后任务归档 `failed`，不无限重试 |
| 追溯 | A-19 |

### FR-24 — Worker 子进程自动重启（≤3 次）

| 字段 | 内容 |
|------|------|
| 一句话 | 父进程检测子进程 exit (non-zero) → `restart_count[name]++`；≤3 次内 fork 重启；超过则放弃发 `worker_left` |
| 用户价值 | 偶发崩溃自愈，持续故障不无限重启 |
| 完成判定 | (a) kill 一个 Worker 子进程 → EVENT LOG 出现 `restart 1/3` 后重启；(b) 第 4 次崩溃后 EVENT LOG 出现 `worker_left` |
| 追溯 | A-20 |

### FR-25 — 父进程死亡 → Worker 1 Hz 自杀

| 字段 | 内容 |
|------|------|
| 一句话 | Worker 子进程每秒 `process.kill(process.ppid, 0)` 探活父进程；父进程不存在则 `process.exit(1)` |
| 用户价值 | 防止 Worker 成为孤儿进程占用资源 |
| 完成判定 | kill 主进程后所有 Worker 子进程在 1 秒内退出 |
| 追溯 | A-21 |

---

## 9. 审计与缓存

### FR-26 — ChainAudit

| 字段 | 内容 |
|------|------|
| 一句话 | 每条 chain 持久化 `~/.../chains/<chain_id>/{manifest.json, audit.jsonl, requirement.md}`；manifest 含 status / link_tasks / link_workers / total_retry_count / max_total_retries / requirement_path |
| 用户价值 | 全链审计可追溯；status 终态枚举（running / completed / aborted / merge_failed / failed） |
| 完成判定 | (a) 跑完一链后 manifest.json 字段齐全；(b) audit.jsonl 至少含 `chain_opened` / `requirement_received` / `task_dispatch ×5` / `completion_report ×5` / `chain_closed`；(c) requirement.md 内容与用户原始输入一致 |
| 追溯 | A-22 |

### FR-27 — Chain-shared cache 布局

| 字段 | 内容 |
|------|------|
| 一句话 | 任务结果走 `~/.../tasks/<task_id>/result.md`（chain 共享）；Worker 自留备份 `~/.../docs/<worker>/<date>/<prefix>-<chain_id>.md`；执行日志 `~/.../tasks/<task_id>/exec-<ts>.log`；评估日志 `~/.../tasks/<task_id>/eval-<N>.log` |
| 用户价值 | 链内跨 Worker 共享结果；Worker 个人备份与团队主线分离 |
| 完成判定 | (a) 跑通一链后 result.md 5 份；(b) 每个 Worker 自留副本齐全 |
| 追溯 | A-23 |

---

## 10. Workspace memory

### FR-28 — `/init` slash 触发 bootstrap

| 字段 | 内容 |
|------|------|
| 一句话 | TUI 输入 `/init` → MemoryBootstrap 枚举 `packages/**/*.ts` → 为每个文件生成 memory 卡片到 `~/.claude-orchestrator/projects/<leader_id>/memory/<path>.md`（front-matter 含 `source_hash`）+ 顶层 `CLAUDE.md` 索引 |
| 用户价值 | 一键为 Worker 准备项目结构/源码 memory |
| 完成判定 | (a) `/init` 后 EVENT LOG 出现 `[debug] /init: bootstrap done`；(b) `~/.../memory/CLAUDE.md` 存在；(c) `~/.../memory/packages/leader/src/chain-router.md` 存在且 front-matter 含 `source_hash`；(d) 重复 `/init` 跳过已生成项 |
| 追溯 | A-12 |

### FR-29 — `memory_refresh` 增量

| 字段 | 内容 |
|------|------|
| 一句话 | Worker commit 后发 `memory_refresh` 消息给 Leader → ChainRouter 接收 → MemoryBootstrap 重新生成被改文件的卡片 |
| 用户价值 | memory 卡片永远与最新源码对齐 |
| 完成判定 | Executor 修改并 commit `packages/leader/src/chain-router.ts` 后，等数秒该文件 memory 卡片的 `source_hash` 更新 |
| 追溯 | A-13 |

### FR-30 — 陈旧扫描（`refreshStale`）

| 字段 | 内容 |
|------|------|
| 一句话 | `/init` 时 MemoryBootstrap.refreshStale 比较 memory 卡片的 `source_hash` 与磁盘最新 hash，漂移则重写 |
| 用户价值 | 手工 commit 或外部脚本写入也能被发现 |
| 完成判定 | 手工修改源文件并 commit（未触发 worker） → 下次 `/init` 时 EVENT LOG 出现 "stale entries refreshed" |
| 追溯 | A-14 |

---

## 11. ��自主循环调度

本节是 v0.7 相对 v0.6 RC0 的增量需求。三条 FR 互相耦合：FR-31（Explorer 角色）+ FR-32（`--magic` 启动开关）+ FR-33（`spawn_chain` 决策）共同构成"链 → 链"循环。

### FR-31 — Explorer 角色与 Explore 链节

| 字段 | 内容 |
|------|------|
| 一句话 | 新增 `explorer` role 与 `explore` link，作为 `--magic` 模式下责任链的第 6 环；Explorer 接到任务后查阅当前 chain 全部产出（plan / execute / verify / review / accept 的 result.md + commit 历史 + chain manifest），输出"下一轮需求草案"以及 `spawn_chain` 或 `close_chain` 自评估决策 |
| 用户价值 | 把"下一步做什么"决策从人工 → 自主；适用于长跑式探索、研究型项目、持续重构等开放问题 |
| 完成判定 | (a) `TaskLinkSchema` 新增 `explore` 枚举值；`InstanceRoleSchema` 新增 `explorer`；(b) `templates/agents/worker-explorer.md` + `worker-explorer-task.md` + `templates/claude-memory/personal-claude-explorer.md` 三个模板存在；(c) `roleWeights.ts` explorer × explore = 100、其它 link = 10-20，其它 role × explore = 10-20；(d) skill `task-exploration` 存在；(e) `--magic` 启动时 6 Worker 中 1 个 explorer 被分配 |
| 追溯 | |

### FR-32 — `--magic` 启动开关

| 字段 | 内容 |
|------|------|
| 一句话 | `claude-orchestrator run --worker N --magic` 启用自主循环模式：role 分配按 `planner > executor > verifier > reviewer > accepter > explorer` 顺序填充；ChainRouter.handleRequirement 调用 decompose 时附加 `magic=true` 上下文，ChainDef 必含 explore 第 6 任务；TUI 标题栏显示 `[MAGIC]` 徽标 |
| 用户价值 | 操作员一键打开循环调度；不影响默认模式的简洁性 |
| 完成判定 | (a) `--magic` 启动后 TUI 标题栏出现 `[MAGIC]`；(b) 不带 `--magic` 启动时 ChainDef 输出 5 任务（无 explore）；(c) `--magic` 启动且 `--worker 6` 时 TEAM 面板出现 1 个 explorer；(d) `--magic` + `--worker 7+` 时第 7 个 Worker 为 executor（探索者只配 1 个） |
| 追溯 | |

### FR-33 — `spawn_chain` 决策与链 → 链派生

| 字段 | 内容 |
|------|------|
| 一句话 | EvalDecision 新增 `spawn_chain` 状态；仅在 explore link 合法；Explorer 输出 `spawn_chain` + `next_requirement: <string>` 时 ChainRouter 执行：(1) MergeValidator 关闭当前 chain（成功则 status=`completed`，失败则 `merge_failed` + executor retry，与默认 `close_chain` 一致）；(2) 用 `next_requirement` 内容作为新需求 push 到 `/messages/{leader_id}/msg-*`（type=`user_input`，附 `spawned_from: <parent_chain_id>` 元字段）；(3) 新 chain_id 由 ChainRouter 生成，新 manifest 记录 `parent_chain_id` 与 `chain_depth`（链深度），audit.jsonl 在两条 chain 中分别记 `chain_spawned (child=<id>)` 与 `chain_spawned_from (parent=<id>)` |
| 用户价值 | 自主循环；链与链显式相连（parent / depth），便于审计与可视化 |
| 完成判定 | (a) explore link Worker 输出 `spawn_chain` + `next_requirement` 后 EVENT LOG 出现 `chain_spawned chain-N → chain-N+1`；(b) 新 chain manifest 含 `parent_chain_id` 与 `chain_depth = N`；(c) Explorer 输出 `close_chain` 时链正常关闭，无新 chain 创建；(d) 非 explore link 发出 `spawn_chain` 时 ChainRouter 视作 ValidationError，记 audit `invalid_decision` 并把链 reject 转 `aborted` |
| 追溯 | |

### FR-34 — `--magic` 模式下的循环硬上限

| 字段 | 内容 |
|------|------|
| 一句话 | `--magic` 循环的链深度受全局 `--magic-max-chains M`（默认 `unlimited`，可由 env `CO_MAGIC_MAX_CHAINS` 覆写）约束；达到上限时 Leader 阻塞 `spawn_chain` 派发，将其降级为 `close_chain` 行为并记 audit `magic_depth_exhausted` |
| 用户价值 | 防止 Explorer 决策错误导致无限循环；操作员保留兜底闸阀 |
| 完成判定 | (a) `--magic --magic-max-chains 3` 启动后跑到第 3 条 chain 的 explore link 时 EVENT LOG 出现 `[debug] magic loop depth 3 reached: spawn_chain demoted to close_chain`；(b) 不指定时无上限，仅 Ctrl+C / 单链 `max_total_retries` 控制；(c) audit.jsonl 含 `magic_depth_exhausted` |
| 追溯 | |

### FR-35 — `--magic` 模式下 ChainAudit manifest 扩展

| 字段 | 内容 |
|------|------|
| 一句话 | chain manifest 新增 `parent_chain_id: ChainId \| null`、`child_chain_ids: ChainId[]`、`chain_depth: number`、`magic_mode: boolean` 四字段；status 终态枚举不变；audit.jsonl 新增 `chain_spawned` / `chain_spawned_from` / `magic_depth_exhausted` 三种事件 |
| 用户价值 | 一次 `--magic` 跑形成的链森林可被审计、可视化、人工审阅 |
| 完成判定 | (a) `--magic` 跑完 ≥2 条 chain 后 `~/.../chains/<chain_id>/manifest.json` 含上述字段；(b) 顶层非 `--magic` 模式下 `magic_mode=false`、`parent_chain_id=null`、`chain_depth=0`；(c) 子 chain 的 `parent_chain_id` 指向父 chain，父 chain 的 `child_chain_ids` 含子 chain_id |
| 追溯 | |

---

## 12. worktree 工作流

### FR-36 — git 错误五分类与差异化重试

| 字段 | 内容 |
|------|------|
| 一句话 | Worker pre-task rebase / commit 与 Leader merge 期 git 失败按 5 类分流：`MergeConflictError` / `RebaseConflictError` / `WorktreeLockedError` / `GitPermissionError` / `GitNetworkError` + 兜底 `Error`；conflict 类与 commit failed 触发 retry（同 Worker / accept-link Worker），lock/permission/network 类**不**触发 retry —— 仅 audit 后等待操作员 |
| 用户价值 | 基础设施级失败（磁盘锁、目录权限、网络断开）不再无限刷 retry 浪费 token；冲突类失败精确路由到合适的 Worker 一次修通 |
| 完成判定 | (a) 制造 `cannot lock ref` 场景后 audit.jsonl 出现 `merge_failure { category: 'worktree_locked' }` 且**无** retry task；(b) 制造冲突场景后 audit.jsonl 出现 `merge_failure { category: 'conflict' }` 且 accept-link Worker 收到 retry；(c) 错误类源头 `packages/leader/src/merge-validator.ts:204` `classifyGitError` 已实现 |
| 追溯 | |

### FR-37 — LinkCommitRecord 与 upstream_commits 双写

| 字段 | 内容 |
|------|------|
| 一句话 | 每个 link 完成时 Worker 通过 completion_report 回传 `{ worktree, docs, branch }` LinkCommitRecord；ChainRouter 调 `ChainAudit.recordLinkCommit` 写到 `manifest.link_commits[link]`；下游 link dispatch 前调 `collectUpstreamCommits` 取出 worktree SHA，**双写**到 `Task.upstream_commits` 与 `Message.upstream_commits`；feedback 时调 `clearLinkCommitsFrom` 擦除 fromLink 及下游记录 |
| 用户价值 | pre-task rebase（FR-13）可正确定位上游基线；feedback 重试不被陈旧 SHA 误导 |
| 完成判定 | (a) 跑完一条链后 manifest.link_commits 5 个 link 的 record 都存在；(b) Worker B 收到的 task_dispatch.upstream_commits 含 Worker A 的 worktree SHA；(c) 制造 feedback 后 manifest.link_commits 中 fromLink 及下游被清空 |
| 追溯 | |

---

## 追溯表（FR ↔ A/R）

| FR | A/R | FR | A/R |
|----|-----|----|----|
| FR-01 | A-01 | FR-16 | A-18 |
| FR-02 | A-09 | FR-17 | R-02 + R-07 |
| FR-03 | A-10 | FR-18 | R-04 |
| FR-04 | A-11 | FR-19 | R-05 |
| FR-05 | A-05 | FR-20 | R-06 |
| FR-06 | A-06 | FR-21 | R-01 |
| FR-07 | A-07 | FR-22 | R-03 |
| FR-08 | A-08 | FR-23 | A-19 |
| FR-09 | A-02 | FR-24 | A-20 |
| FR-10 | A-03 + ��spawn_chain） | FR-25 | A-21 |
| FR-11 | A-04 + ��explore optional） | FR-26 | A-22 |
| FR-12 | A-15 | FR-27 | A-23 |
| FR-13 | A-16 | FR-28 | A-12 |
| FR-14 | A-24 | FR-29 | A-13 |
| FR-15 | A-17 | FR-30 | A-14 |
| **FR-31**| （explorer 角色） | **FR-34** | --magic-max-chains |
| **FR-32**| --magic flag | **FR-35** | （chain manifest 扩展） |
| **FR-33**| spawn_chain| **FR-36** | git 错误五分类 |
|  |  | **FR-37** | LinkCommitRecord 双写 |

合计：37 条 FR = 24 项 A 功能继承（含 FR-10/FR-11/FR-13/FR-15/FR-16/FR-17 在 v0.7 内修订）+ 6 项 R 修复（R-07 并入 FR-17 ChainStatus 表述）+ 7 项 ��FR-31 ~ FR-37）。
