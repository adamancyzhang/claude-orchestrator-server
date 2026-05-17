# 04 — 功能需求

> **文档定位**：v0.7 功能需求清单（FR-01 ~ FR-30），按 10 个功能域分组。每条 FR 给出一句话描述、用户价值、完成判定（2-3 条关键勾选项）、追溯到 `feature-matrix.md` 中的 A-/R- 编号。
>
> 完成判定只列关键 done 条件；完整逐项勾选步骤见 `../../rc0-v0.6/acceptance-checklist.md`。

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
| 一句话 | 20 个拟人化名称池；启动时按 `planner > builder > verifier > reviewer > accepter` 优先级填充；6 个 Worker 时第 6 个补 builder |
| 用户价值 | TUI 中能用易记的名字区分 Worker |
| 完成判定 | (a) 启动 6 Worker，TEAM 出现 6 个名字来自池；(b) role 分配满足优先级；(c) 启动 7 Worker，第 7 个为 builder |
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
| 一句话 | plan → build → verify → review → accept 五环节固定顺序；NEXT_LINKS / PREV_LINKS 与 CHAIN_LINKS 在 Leader 与 Worker 两处同步定义 |
| 用户价值 | 明确的"做什么 → 做完了什么 → 谁来验"流水线 |
| 完成判定 | (a) Leader `NEXT_LINKS`/`PREV_LINKS` 与 Worker `CHAIN_LINKS` 一致；(b) 输入 "hello world" 需求后 EVENT LOG 依次出现 5 次 `task_dispatch` 与最后的 `chain_closed` |
| 追溯 | A-02 |

### FR-10 — EvalDecision 四态

| 字段 | 内容 |
|------|------|
| 一句话 | Worker 自评估输出 `activate_next` / `feedback` / `reject` / `close_chain` 四态 JSON；ChainRouter 按态机械路由 |
| 用户价值 | 链路推进规则封闭、可审计 |
| 完成判定 | (a) `activate_next` 路径正常推进；(b) `feedback` 派 retry 给上一 link；(c) `reject` 转链 `aborted`；(d) `close_chain` 触发 MergeValidator |
| 追溯 | A-03 |

### FR-11 — ChainDef 拆解（plan 可选）

| 字段 | 内容 |
|------|------|
| 一句话 | decompose 模板输出 ChainDef JSON 含 `plan` / `build` / `verify` / `review` / `accept` 5 任务；`plan` 字段允许为 null |
| 用户价值 | 简单需求可跳过 plan 直接 build |
| 完成判定 | (a) 默认 5 任务入 pending；(b) `"plan": null` 时只有 4 任务入 pending，首任务为 build |
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

### FR-13 — 自动 commit + claude 生成 message

| 字段 | 内容 |
|------|------|
| 一句话 | chain-link 任务执行完毕后 CommitChecker 自动 `git add -A && git commit`；commit message 由 claude 按 `worker-commit-message.md` 生成（≤72 字符），失败 fallback `chore: auto-commit from {Name}` |
| 用户价值 | Worker 产出无需操作员手 commit |
| 完成判定 | (a) Build 完成后 Worker worktree `git log -1` 有新 commit；(b) commit message 首行 ≤72 字符 |
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

### FR-15 — MergeValidator（merge / skip / review_first）

| 字段 | 内容 |
|------|------|
| 一句话 | MergeValidator 通过 `worker-merge-decision.md` 模板让 claude-cli 完成 ancestry 检查、决策、merge 执行；输出 3 态 MergeDecision；Leader 不直接执行 git |
| 用户价值 | 合并策略可由 LLM 上下文感知（隔离/冲突/已合并），不需要硬编码 |
| 完成判定 | (a) 链 close 时 cache 下 `merges/merge-*.log` 出现且含 MergeDecision JSON；(b) claude-cli 失败时返回 `review_first`（保守） |
| 追溯 | A-17 |

### FR-16 — close_chain 触发 runMergeValidation + ChainAudit.closeChain

| 字段 | 内容 |
|------|------|
| 一句话 | accept link 输出 `close_chain` → ChainRouter.runMergeValidation 遍历链内所有 commit；全部成功则 `closeChain(chainId, "completed")` |
| 用户价值 | 一次完整链路推进结束时主分支含全部 link 的 merge commit |
| 完成判定 | (a) 跑通一条链后 main 分支多 5 个 `--no-ff` merge commit（每 link 一个）；(b) `~/.../chains/<chain_id>/manifest.json` `status: "completed"` 且 `completed_at` 已写 |
| 追溯 | A-18 |

### FR-17 — `merge_failed` 终态 + Builder retry

| 字段 | 内容 |
|------|------|
| 一句话 | runMergeValidation 遇任一冲突 → 收集失败列表（不再吞噬）→ `closeChain(chainId, "merge_failed", { failures })` → 发射 `chain_merge_failed` 事件 → 对每个失败 link 从 `manifest.link_workers` 查 Worker，push 一条 priority=0、assigned_to=该 Worker、link=失败 link 的 retry task；TUI 红字渲染 `MERGE_FAILED chain <id>: N branch(es) ...` |
| 用户价值 | 主分支永远只接受成功 merge；冲突显式回到原 Builder 解决，用户实时可见 |
| 完成判定 | (a) 构造冲突场景后 EVENT LOG 出现红色 `MERGE_FAILED chain <id>`；(b) 对应 Builder 收件箱出现新 task_dispatch，描述含 "Merge conflict on branch ..."；(c) `manifest.json` status = `merge_failed` 而非 `completed`；(d) `ChainStatus` 枚举显式包含 `merge_failed` |
| 追溯 | R-02（含 R-07） |

---

## 6. 链推进与反馈保护

### FR-18 — 反馈硬上限（`max_total_retries`）

| 字段 | 内容 |
|------|------|
| 一句话 | chain manifest 持久化 `total_retry_count` 与 `max_total_retries`（默认 9，`CO_CHAIN_MAX_RETRIES` 环境变量覆写）；超限链强制 `aborted` 不再 push |
| 用户价值 | 防止"verify ↔ build 死循环"耗尽资源 |
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
| 用户价值 | 全链审计可追溯；status 终态枚举（active / completed / aborted / merge_failed / failed） |
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
| 完成判定 | Builder 修改并 commit `packages/leader/src/chain-router.ts` 后，等数秒该文件 memory 卡片的 `source_hash` 更新 |
| 追溯 | A-13 |

### FR-30 — 陈旧扫描（`refreshStale`）

| 字段 | 内容 |
|------|------|
| 一句话 | `/init` 时 MemoryBootstrap.refreshStale 比较 memory 卡片的 `source_hash` 与磁盘最新 hash，漂移则重写 |
| 用户价值 | 手工 commit 或外部脚本写入也能被发现 |
| 完成判定 | 手工修改源文件并 commit（未触发 worker） → 下次 `/init` 时 EVENT LOG 出现 "stale entries refreshed" |
| 追溯 | A-14 |

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
| FR-10 | A-03 | FR-25 | A-21 |
| FR-11 | A-04 | FR-26 | A-22 |
| FR-12 | A-15 | FR-27 | A-23 |
| FR-13 | A-16 | FR-28 | A-12 |
| FR-14 | A-24 | FR-29 | A-13 |
| FR-15 | A-17 | FR-30 | A-14 |

合计：30 条 FR ↔ 24 项 A 功能 + 6 项 R 修复（R-07 并入 FR-17 内 ChainStatus 表述）。所有 31 项原 A/R 编号均有 FR 对应位置。
