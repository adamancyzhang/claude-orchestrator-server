# Workflow — Leader × Worker × claude-cli 全链路现状基线

> **本目录定位**：基于 `packages/` 源码 + `templates/agents/` 模板的**现状基线文档**。以一个具体样例贯穿 Leader、5 个 Worker、claude-cli 的完整运行，对每一步固化"生成了什么文件 / ZK 节点是什么状态 / 消息体长什么样 / 任务是如何被调度和认领的 / 调用了什么模板 / 对应到哪段代码"。
>
> **使用方式**：未来迭代 prompt 模板或调整链路前，先读本目录看现状，再到 `docs/v0.6/core/` 看设计意图、`docs/v0.6/dd/` 看类型协议。
>
> **不引入新设计**——本目录只描述代码现状，遇到模板/代码不一致或可疑现象会用 ⚠️ 标记原样保留。

## 贯穿样例

- **需求**：`为 REST API /api/users 增加分页支持，支持 page/page_size 参数，默认 page=1/page_size=20`
- **chain_id**：`chain-pagination-001`
- **运行假设**：以 `node dist/index.js run --worker 5` 启动，5 个 Worker 分别担任 5 个角色，名称按 20 人名池抽取为 `Tom / Jerry / Lucy / Mia / Leo`。
- **Leader 实例**：`name=Leader`, `instance_id=leader-01`。
- **持久化根**：`~/.claude-orchestrator/projects/leader-01/` —— 下含 `chains/<chain_id>/`、`tasks/<task_id>/`、`messages/<message_id>/`、`docs/<worker>/<date>/` 四个子目录。路径函数集中在 `packages/contracts/src/paths/cachePaths.ts`。

完整 Worker 实例化见 `00-identity-cards.md`。

## 整体步骤一览（10 步跨 8 个文件）

| Step | 角色 / 子系统 | 行为 | 文档 |
|------|--------------|------|------|
| 0 | 系统启动 | Leader + 5 Worker 完成 worktree、ZK 注册、watch 建立 | `00-identity-cards.md` |
| 1 | 用户 → TUI | 键入需求文本，按 Enter | `01-tui-input-and-decompose.md` §1 |
| 2 | Leader / Watcher | ZK 写入 `messages/{leader}/msg-*`、Watcher 捕获 | `01` §2 |
| 3 | ChainRouter | 路由判定：自由文本 → `handleRequirement` | `01` §3 |
| 4 | Leader 自处理 decompose | 渲染 `worker-decompose.md` → claude-cli → ChainDef JSON | `01` §4 |
| 5 | ChainRouter | 解析 ChainDef → push 5 个任务 → 派发首任务（plan）给 Planner | `01` §5 |
| 6 | Planner (Tom) | Plan 任务全流程：模板渲染 → claude-cli → commit → 自评估 → 完成报告 | `02-plan-link.md` |
| 7 | Builder (Jerry) | Build 任务全流程，活化由 Plan 的 `activate_next` 触发 | `03-build-link.md` |
| 8 | Verifier (Lucy) | Verify 任务全流程 | `04-verify-link.md` |
| 9 | Reviewer (Mia) | Review 任务全流程 | `05-review-link.md` |
| 10 | Accepter (Leo) | Accept 任务 + EvalDecision `close_chain` + 链关闭 + 合并校验 | `06-accept-and-close.md` |

## 文档清单

| 文件 | 内容 |
|------|------|
| `README.md` | 本文件 |
| `00-identity-cards.md` | 5 个 Worker 身份卡（基础信息、注入方式、能力边界、典型产出、role-link 权重） |
| `01-tui-input-and-decompose.md` | Step 1–5：TUI 输入 → ChainRouter → decompose → ChainDef → 5 任务入队 |
| `02-plan-link.md` | Step 6 详细子流程（5.1–5.9）：Plan 任务的认领、模板、执行、commit、评估、回报、激活下一环 |
| `03-build-link.md` | Step 7：Build 链环节差异化内容 |
| `04-verify-link.md` | Step 8：Verify 链环节差异化内容 |
| `05-review-link.md` | Step 9：Review 链环节差异化内容 |
| `06-accept-and-close.md` | Step 10：Accept 链环节 + close_chain + MergeValidator |
| `appendix-state-reference.md` | ZK 路径 / cache 文件路径 / Schema / link-template-role 对照 / hook 事件 速查 |

## 与其他文档层的关系

| 层 | 回答 | 与本目录的关系 |
|----|------|--------------|
| `prd/` | 做什么、为什么做 | 本目录提供"是什么"的具体化 |
| `dd/contracts.md` `dd/protocol.md` `dd/zk-schema.md` | 类型 / wire-format / ZK Schema（权威） | 本目录给出实例化 JSON，应能被 Schema 校验通过 |
| `dd/architecture.md` `dd/execution-runtime.md` | 组件如何交互、执行层细节 | 本目录给出具体一次运行下各组件协作时的状态切片 |
| `core/01~05` | 五条核心链路的抽象描述 | 本目录是 `core/` 的"具体化注释版" |
| `test-cases/` | 验证策略 | 本目录的步骤可作为人工对照表 |

## 现状基线 — 全部 ⚠️ 已落地

下面这张表对应早期版本里的 11 个 ⚠️ + 6 项后续治理项，全部已在代码或文档层解决。每条都给出"代码位置 / 文档落点"，方便后续 PR 反查或回归测试时锁定。

### 11 个原始 issue（功能修复）

1. ✅ **issue #1 — 任务认领进 ZK 状态机**：`WorkerWatcher.processMessage` 收到 task_dispatch 后调 `task_queue.claimById(task_id, instance_id)` 把节点从 `/tasks/pending/{task-id}` 原子搬到 `/tasks/claimed/{instance_id}-{task-id}`（EPHEMERAL，断线自删）；执行 + 自评估完成后调 `task_queue.complete(task_id, …)` 写 `/tasks/completed/{task-id}` 并记 duration。位置：`packages/worker/src/watcher.ts:processMessage`。详见 `02` §5.1。
2. ✅ **issue #2 — `{{name}}` / `{{role}}` 占位符替换**：`WorkerWatcher.processMessage`、`SelfEvaluator.evaluate`、`ChainRouter.handleRequirement` 渲染时全部传 `name/role`。位置：`packages/worker/src/watcher.ts:180-200` / `packages/worker/src/evaluator.ts` / `packages/leader/src/chain-router.ts:177-211`。详见 `00` §3。
3. ✅ **issue #3 — EvalDecision schema 对齐**：`worker-evaluate.md` 与 `worker-evaluate-format-hint.md` 全部 snake_case（`next_link / feedback_to_worker / suggested_worker / feedback_target`），按 discriminated union 列四分支（含 `reject`）。详见 `02` §5.7。
4. ✅ **issue #4 — activate_next 复用初始 task**：`ChainRouter.handleCompletionReport.activate_next` → `findOrCreatePendingTask(chain_id, next_link)` 复用初始 5 个 pending；只有完全不匹配才回退为新建。位置：`packages/leader/src/chain-router.ts:findOrCreatePendingTask`。详见 `02` §5.9。
5. ✅ **issue #5 — decompose 独立 cache 路径**：`cachePaths.decomposeResultPath(o, messageId)` 把 decompose 产物落到 `messages/<message_id>/decompose.md`，不再借道 task results 路径。详见 `01` §4。
6. ✅ **issue #6 — feedback 路由到前一环 worker**：`ChainRouter.resolveFeedbackTarget` 优先级 = ① `decision.feedback_target`（显式指定）→ ② `manifest.link_workers[prev_link]`（持久化到 chain manifest，详见 §"持久化 link_workers"）→ ③ `msg.from_instance`。详见 `04/05/06`。
7. ✅ **issue #7 — close_chain 自动触发 MergeValidator**：`ChainRouter.chainCommits` 收集每环 commit，`close_chain` 时按 plan→build→verify→review→accept 顺序调 `MergeValidator.validate`；任一失败仅 warn，不阻断后续。详见 `06` §9.10。
8. ✅ **issue #8 — cachePaths 去 `task-` 双前缀**：`taskLogPath` 等函数不再附加 `task-` 前缀（taskId 自带）。详见 `appendix-state-reference.md` §B。
9. ✅ **issue #9 — task_dispatch 携带 description/criteria**：`handleTaskDefinitions` 把 ChainDef 中的 `description`/`criteria` 一并写入 task_dispatch 消息及 Task 节点，下游 worker prompt 直接拿到完整上下文。详见 `01` §5.5。
10. ✅ **issue #10 — 跨 worktree artifact 传递**：链 artifact 通过共享 cache 路径 `tasks/<task_id>/result.md` 传递；下游 worker 通过 `manifest.link_tasks[<prev_link>]` 解析路径，模板变量 `{{upstream_plan_artifact}} / upstream_build_artifact / upstream_verify_artifact / upstream_review_artifact` 在 `WorkerWatcher.collectChainArtifacts` 里组装。详见 `03 / 04 / 05 / 06`。
11. ✅ **issue #11 — CommitChecker 命令注入**：`packages/worker/src/commit-checker.ts` 切到 `execFileSync("git", ["commit", "-m", message], …)`，message 作为单独 argv 元素传给 git，跳过 shell 解析。

### 6 项后续治理（本轮新增）

12. ✅ **task_doc_path / depends_on / blocked_by / blocked_reason 完全移除**：原设计字段从未落地，全部从 `Task` / `Message` schema、协调层 push、模板渲染变量、模板正文中删除；`TaskStatus.blocked` 与 `ITaskQueue.block()` 一并清理。模板 `worker-task-doc.md` 删除。Zod strip 模式保证旧 ZK 节点反序列化无副作用。详见 `appendix-state-reference.md` §C。
13. ✅ **Instance status = "busy" 真正写 ZK**：`WorkerWatcher.processMessage` 入口前调 `registry.heartbeat(instance_id, { status: "busy", current_task_id })`；try/finally 末尾回写 `idle`；心跳异常仅 warn 不影响主流程。位置：`packages/worker/src/watcher.ts:processMessage`。这下 `ChainRouter.findIdleWorkerByRole` 真正按 status 筛选，第二条链或并发派发的行为符合预期。
14. ✅ **chainWorkers Map → ChainAudit 持久化**：内存 `Map<ChainId, Map<TaskLink, InstanceId>>` 删除，统一改写 `chain manifest.link_workers`（新字段）；`ChainAudit.setLinkWorker` 在每次 dispatch 时持久化到 `chains/<chain_id>/manifest.json`。Leader 重启后 feedback 路由依然可恢复。详见 `01` §5 + `appendix-state-reference.md` §B（manifest 表）。
15. ✅ **feedback decision 现在物化为 retry task**：`ChainRouter.handleCompletionReport(feedback)` 不再只发 `direct` 消息——而是 `task_queue.push()` 一条新的 pending task（同 prev_link、retry_count++、`description = feedback_to_worker`），并 `task_dispatch` 派发给 target worker。Worker 走标准 claimById → run → evaluate 流程；旧 completed task 不被覆盖，审计可追溯。详见 `04` §7.9.1 / `05` §8.x / `06` §9.x。
16. ✅ **task_claimed / task_completed hook 真正触发**：`WorkerWatcher` 在 `claimById` 成功后 fire `task_claimed`，在 `complete()` 成功后 fire `task_completed`（env 含 `duration_seconds`）。`TaskHookEnv` 同步扩展，加 `CO_WORKER_NAME` / `CO_WORKER_ID`。详见 `appendix-state-reference.md` §hook 表。
17. ✅ **personal-claude-{role}.md 模板 {{name}} 替换**：`packages/orchestrator/src/worktree-initializer.ts:265-271` 在拷贝 `templates/claude-memory/personal-claude-{role}.md` 到 worker worktree 时先做 `{{name}}`/`{{role}}` 替换再写入。模板正文中的 `{{task_doc_path}}` fallback 已全部删除，改为指向 `{{upstream_*_artifact}}` 变量。详见 `00` §3。
