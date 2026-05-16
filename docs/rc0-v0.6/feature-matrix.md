# Feature Matrix — v0.6 RC0

> **文档定位**：v0.6 RC0 全部功能的"功能 × 代码位置 × 测试 × 验收 #"对照表，作为验收唯一索引。验收人按矩阵逐行核对，失败时按"代码位置"列追溯实现、按"测试"列追溯自动化验证、按"验收 #"列对照 `acceptance-checklist.md` 的具体步骤。
>
> 编号约定：A-01 ~ A-24 为常规功能；R-01 ~ R-07 为本次 RC 修复的 REVIEW.md 缺陷。每行末尾"验收 #"列指向 `acceptance-checklist.md` 中的对应小节。

## 第一区：核心功能

| # | 功能 | PRD 锚点 | DD 锚点 | 代码位置 | 自动化测试 | 验收 # |
|---|------|---------|---------|---------|----------|--------|
| A-01 | 一键启动 `run --worker N`（N≥6，默认 6） | prd §5.1 | dd/config-and-cli §3 | `packages/cli/src/index.ts:17-42`、`packages/orchestrator/src/run.ts` | `packages/cli/tests/core/unit/cli.test.ts` | A-01 |
| A-02 | 5 链责任链：plan → build → verify → review → accept | prd §4 | core/core-chain-overview | `packages/leader/src/chain-router.ts:37-51`（NEXT/PREV_LINKS）；`packages/worker/src/evaluator.ts:16-22`（CHAIN_LINKS） | `packages/leader/tests/core/unit/chain-router.test.ts` | A-02 |
| A-03 | EvalDecision 四态：activate_next / feedback / reject / close_chain | prd §4 + workflow §5.8 | dd/contracts §3.5 | `packages/contracts/src/schemas/eval.ts:5-34`；`packages/leader/src/chain-router.ts:541-624` | `packages/contracts/tests/core/unit/schemas.test.ts`；`chain-router.test.ts` | A-03 |
| A-04 | ChainDef 拆解（plan/build/verify/review/accept，plan 可选） | prd §5.2 | dd/contracts §3.4 | `packages/contracts/src/schemas/chain.ts`；`packages/leader/src/chain-router.ts:362-503`（handleTaskDefinitions） | `chain-router.test.ts` "handleTaskDefinitions" 子套件 | A-04 |
| A-05 | 角色权重表与任务认领排序 | prd §3.2 | dd/contracts §6 | `packages/contracts/src/roleWeights.ts:3-12`；`packages/coordination/src/task-queue.ts` claim 路径 | `packages/coordination/tests/core/unit/task-queue-*.test.ts` | A-05 |
| A-06 | 名称池（20 人名）+ 角色解耦分配 | prd §3.3 | dd/config-and-cli §6 | `packages/orchestrator/src/worktree-initializer.ts` 名称分配逻辑 | `packages/orchestrator/tests/core/unit/worktree-initializer.test.ts` | A-06 |
| A-07 | Worker 隔离（git worktree + 独立分支） | prd §6.1 | dd/execution-runtime + workflow §00 | `packages/orchestrator/src/worktree-initializer.ts:134-216` | `worktree-initializer.test.ts` | A-07 |
| A-08 | 身份注入（`--append-system-prompt` 三段拼接） | prd §6.2 | dd/execution-runtime §1.2；workflow §00 | `packages/runtime/src/runner.ts:24-33`（buildIdentityPrompt）；`templates/agents/worker-identity.md` | `packages/runtime/tests/core/unit/template.test.ts` | A-08 |
| A-09 | TUI 6 面板：TEAM / PENDING / IN PROGRESS / WORKER MESSAGES / EVENT LOG / INPUT | prd §2 | dd/architecture §2.5 | `packages/leader/src/tui/renderer.ts:92-300`；`controller.ts` | TUI 渲染断言通过 e2e；当前未提供 unit | A-09 |
| A-10 | TUI 键盘交互：Tab / Shift+Tab / 1-9 / Enter / Backspace / Escape / ? / Ctrl+C | prd §2 | dd/architecture §2.5 | `packages/leader/src/tui/input.ts:13-28`；`controller.ts:123-187` | 手动验收 | A-10 |
| A-11 | TUI 输入框 → `user_input` 消息 → Leader 自处理 decompose | prd §5.2 | core/01-requirement-to-tasks | `packages/leader/src/tui/controller.ts`；`packages/leader/src/chain-router.ts:297-360`（handleRequirement） | `chain-router.test.ts` "handleRequirement" 子套件 | A-11 |
| A-12 | Slash 命令 `/init` 触发 workspace memory bootstrap | dd/workspace-memory §6.1 | dd/workspace-memory | `packages/leader/src/chain-router.ts:183-232`；`packages/leader/src/memory-bootstrap.ts` | `chain-router.test.ts` "/init routing"；`memory-bootstrap.test.ts` | A-12 |
| A-13 | Workspace memory 增量刷新（commit 后 `memory_refresh` 消息） | dd/workspace-memory §6.2 | dd/workspace-memory | `packages/worker/src/watcher.ts:365-388`；`packages/leader/src/chain-router.ts:245-286` | `chain-router.test.ts` "memory_refresh"；`memory-bootstrap.test.ts` | A-13 |
| A-14 | Workspace memory 陈旧扫描（`source_hash` 漂移） | dd/workspace-memory §6.3 | dd/workspace-memory | `packages/leader/src/memory-bootstrap.ts:298-314`（refreshStale）；同上 `/init` 入口 | `memory-bootstrap.test.ts` "stale detection" | A-14 |
| A-15 | 自评估三连重试 + format-hint 追加 | core/02 §5.8 | dd/contracts §3.5 | `packages/worker/src/evaluator.ts:56-128`；`templates/agents/worker-evaluate.md`、`worker-evaluate-format-hint.md` | `packages/worker/tests/core/unit/evaluator.test.ts` | A-15 |
| A-16 | 自动 commit + claude 生成 commit message | core/02 §5.7 | dd/execution-runtime；workflow §02 §5.7 | `packages/worker/src/commit-checker.ts`；`templates/agents/worker-commit-message.md` | `packages/worker/tests/core/unit/commit-checker.test.ts` | A-16 |
| A-17 | MergeValidator（merge / skip / review_first） | core/04 §4.2 | dd/contracts §3.6 | `packages/leader/src/merge-validator.ts:37-81`；`templates/agents/worker-merge-decision.md` | 接 chain-router.test.ts 通过 mock validator 覆盖 | A-17 |
| A-18 | close_chain 自动触发 MergeValidator + ChainAudit closeChain | core/04 | dd/architecture | `packages/leader/src/chain-router.ts:602-650` | `chain-router.test.ts` "merge validation on close_chain" | A-18 |
| A-19 | Recovery：孤儿 claimed 任务回收（retry < 3） | core/05 | dd/error-and-recovery §5.4 | `packages/leader/src/recovery.ts:11、47-79` | `recovery` 单元行为通过 chain-router 集成路径覆盖；待补独立单测 | A-19 |
| A-20 | Worker 子进程自动重启（最多 3 次） | core/05 §4.1 | dd/error-and-recovery §5.1 | `packages/orchestrator/src/run.ts` ChildSupervisor 段；`packages/orchestrator/src/worktree-initializer.ts` | 手动验收（kill 子进程后观察重启） | A-20 |
| A-21 | Worker 检测父进程死亡 → 自杀（1 Hz） | core/05 §4.2 | dd/error-and-recovery §5.2 | `packages/orchestrator/src/child-boot.ts` startParentAliveCheck | 手动验收 | A-21 |
| A-22 | ChainAudit：manifest.json + audit.jsonl + requirement.md | core/03 + workflow §02 §5.9 | dd/architecture §6 + dd/contracts | `packages/leader/src/chain-audit.ts` | `packages/leader/tests/core/unit/chain-audit.test.ts` | A-22 |
| A-23 | chain-shared cache（`tasks/<task_id>/result.md` + `docs/<worker>/<date>/`） | core/02 §5.6 + workflow §00 §6.1 | dd/zk-schema + dd/contracts paths | `packages/contracts/src/paths/cachePaths.ts` | `packages/contracts/tests/core/unit/paths.test.ts` | A-23 |
| A-24 | Lifecycle hooks（worker_message_start/end、task_claimed/completed） | dd/execution-runtime §Hooks | dd/execution-runtime | `packages/runtime/src/hook-engine.ts`；`packages/worker/src/watcher.ts` 6 处 fire | 手动验收（hook 脚本观察 CO_* 环境变量） | A-24 |

## 第二区：RC0 修复的 REVIEW.md 缺陷

每行对应一项已修复缺陷，给出修复 commit / 代码 / 测试，验收人需要确认行为已变更。

| # | 缺陷 | 修复内容 | 代码位置 | 自动化测试 | 验收 # |
|---|------|---------|---------|----------|--------|
| R-01 | A1：commit 失败被吞噬，task 仍完成 | `git commit` 失败抛 `CommitFailedError`；watcher 捕获后强制 `feedback` 决策回退给同 worker | `packages/worker/src/commit-checker.ts:56-86`；`packages/worker/src/watcher.ts:350-410`、`sendForcedFeedbackReport` | `packages/worker/tests/core/unit/commit-checker.test.ts` "failure surfacing" | R-01 |
| R-02 | A2+A3：merge 错误吞噬 + 链仍标 completed + 用户不可见 | `runMergeValidation` 收集失败列表；close_chain 命中失败时标 `merge_failed`、推送 builder retry、发射 `chain_merge_failed` 事件、TUI 渲染 | `packages/leader/src/chain-router.ts:602-650`（close_chain）+ `pushMergeConflictRetries`；`packages/contracts/src/events.ts` 新事件；`packages/leader/src/tui/renderer.ts` MERGE_FAILED 行 | `chain-router.test.ts` "merge_failed + builder retry" | R-02 |
| R-03 | A4：evaluator fallback 在 accept link 自动 close_chain（质量门反向） | 3 次自评失败一律 `reject`，不再 activate_next/close_chain | `packages/worker/src/evaluator.ts:115-129` | `packages/worker/tests/core/unit/evaluator.test.ts` "falls back to reject" / "NOT close_chain when accept fails" | R-03 |
| R-04 | A5：反馈无上限 → 资源耗尽 | manifest 增 `total_retry_count` + `max_total_retries`（默认 9，`CO_CHAIN_MAX_RETRIES` 覆写）；超限时 chain 转 `aborted` 不再 push | `packages/leader/src/chain-audit.ts:30-31, 42, 84-135, 142-166`；`packages/leader/src/chain-router.ts` dispatchFeedbackAsRetry 前置检查；`packages/orchestrator/src/run.ts` env var 读取 | `chain-router.test.ts` "aborts the chain when feedback exceeds max_chain_retries" | R-04 |
| R-05 | A6：feedback 默认 fallback 回报告者自己（死循环风险） | `resolveFeedbackTarget` 返回 `InstanceId \| null`；null 时记 audit `feedback_unresolved` + 发射 `debug_info` + 不派发 | `packages/leader/src/chain-router.ts:672-688`（resolveFeedbackTarget）+ feedback case 处理 | `chain-router.test.ts` "drops feedback when neither explicit target nor prior-link worker is resolvable" | R-05 |
| R-06 | A7：chain_id 重用污染审计（写覆盖 completed manifest） | `openChain` 终态校验 → 抛 `ChainConflictError`；chain-router 捕获记录 `chain_id_conflict` audit 并丢弃需求 | `packages/contracts/src/errors.ts` ChainConflictError；`packages/leader/src/chain-audit.ts:84-100`；`packages/leader/src/chain-router.ts:386-417` | `packages/leader/tests/core/unit/chain-audit.test.ts` "openChain throws ChainConflictError" 三个变体 | R-06 |
| R-07 | （存量未变）`ChainStatus` 新增 `merge_failed` 终态 | 增加枚举值；closeChain extra 参数承载 failure 详情 | `packages/leader/src/chain-audit.ts:13-18, 250` | 接 R-02 的测试覆盖（merge_failed 路径） | R-02（含） |

## 第三区：明示已知边界（验收时不强制核对）

参见 `known-boundaries.md`。简表：

| 边界 | 描述 |
|------|------|
| close_chain 单向 | 链关闭后不可重新开启，重做需新建 chain |
| 跨级 feedback 实现受限 | 默认单步上一链路稳定；Worker 暂不读取 manifest 主动指定跨级 target |
| 无 deploy 后回归 | merge 到 main 后没有 CI/test 钩子 |
| 单 Leader、无热备 | Leader 崩溃需重启操作员 `run` |
| Hook 事件名固定 | 不支持自定义事件 |
| 无 `/context` ZK 路径 | 上下文存储未实现 |
| 无 task TTL 自动清理 | completed 任务保留到手动清理 |

## 第四区：使用本矩阵的方法

1. **验收前**：阅读 `known-boundaries.md`，明确哪些场景不应纳入验收范围。
2. **逐行验收**：按 `acceptance-checklist.md` 中对应编号执行操作，对照本表"自动化测试"列确认 `pnpm test` 全绿。
3. **失败定位**：失败时打开"代码位置"列指向的文件，结合"DD 锚点"和"PRD 锚点"理解预期行为。
4. **回归判定**：任何一行 R-* 行为退回 v0.6 状态视为质量回归，必须 hold 发布。
