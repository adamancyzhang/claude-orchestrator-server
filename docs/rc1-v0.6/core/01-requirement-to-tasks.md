# Core Chain 1 — 用户输入 → 需求拆解 → 任务入队（含 chain manifest 初始化）

> **链路定位**：用户通过 TUI 输入需求到最终产生 4-5 个 Pending 任务、chain audit manifest 初始化、首派任务携带空 `upstream_commits` 的全过程。本文在 rc0 同名文件基础上仅记录 git worktree 相关的增量；流程主体（TUI 输入 / 路由判定 / decompose 调用 / ChainDef 解析）参见 `docs/rc0-v0.6/core/01-requirement-to-tasks.md`。

## 1. 链路总览（rc1 视角）

```
TUI 键盘输入
    │
    ▼
/messages/{leader_id}/msg-{seq}
    │
    ▼
LeaderWatcher → ChainRouter.route
    ├── slash command? → 走 /init 等命令
    └── 自由文本 → handleRequirement
                        │
                        ▼
            Leader 自处理 decompose 或转发 Planner
                        │
                        ▼
            handleTaskDefinitions(ChainDef)
                        │
                        ├─ 持久化 requirement.md（CO root 内）
                        ├─ chain_audit.openChain(chain_id, meta)  ◄── rc1 关注
                        ├─ task_queue.push × 4-5（plan→build→verify→review→accept）
                        ├─ 把首 link 任务 assign_to 一名空闲 worker
                        └─ message_router.send(task_dispatch,
                              upstream_commits = collectUpstreamCommits(chain_id))
                                                              ◄── rc1 关注
                                                                = {} （此时 manifest 无 link_commits）
```

## 2. chain manifest 的初始状态

`chain_audit.openChain(chainId, meta)` （`packages/leader/src/chain-audit.ts:100`）写出的初始 manifest 形态：

```json
{
  "chain_id": "chain-001",
  "created_at": "...",
  "leader_id": "...",
  "leader_name": "Leader",
  "requirement_path": ".../chains/chain-001/requirement.md",
  "max_total_retries": 9,
  "total_retry_count": 0,
  "status": "running",
  "link_tasks":   { "plan": null, "build": null, "verify": null, "review": null, "accept": null },
  "link_workers": { "plan": null, "build": null, "verify": null, "review": null, "accept": null }
  // link_commits 字段此时不存在，直到首个 link 完工 recordLinkCommit 才创建
}
```

字段说明：

| 字段 | 含义 | 写入时机 |
|------|------|---------|
| `requirement_path` | 原始需求文本路径（CO root 内，由 Leader 直接 `fs.writeFile`，不入 DocsCommitter） | `openChain` 时 |
| `max_total_retries` | 单条 chain 反馈累计上限，默认 9，可由 `CO_CHAIN_MAX_RETRIES` 或选项覆写 | `openChain` 时 |
| `total_retry_count` | 反馈计数（feedback / merge_failed retry 都累加） | `dispatchFeedbackAsRetry` 中 `incrementRetry` 原子加 |
| `link_tasks[<link>]` | 该 link 当前 active task id（dispatch 时写入，被 feedback 取代时覆盖） | `setLinkTask`（`chain-audit.ts:201`） |
| `link_workers[<link>]` | 该 link 最近 dispatch 给的 worker id（feedback 目标解析与 merge 失败 retry 都依赖它） | `rememberDispatch` → `setLinkWorker`（`chain-audit.ts:314-321`） |
| `link_commits[<link>]` | 该 link 的双轨 commit 三元组 `{worktree, docs, branch}` | **首次 recordLinkCommit 调用时才创建该字段**（`chain-audit.ts:218-236`） |

## 3. 首派任务的 upstream_commits

```ts
// chain-router.ts:534-551
const initialUpstream = await this.collectUpstreamCommits(chainDef.chain_id);
await this.opts.message_router.send({
  type: "task_dispatch",
  ...
  link: firstLink,
  task_id: firstTaskId,
  ...,
  upstream_commits: initialUpstream,   // = {} 因为 manifest.link_commits 还不存在
});
```

`collectUpstreamCommits`（`chain-router.ts:182-200` 调 `chain-audit.ts:249-265`）的行为：
- manifest 不存在 / `link_commits` 不存在 → 返回 `{}`
- 否则按 plan/build/verify/review 顺序，将 `worktree` 非空的项收入返回 map

因此首派 plan 任务时 Worker 收到的是 `upstream_commits = {}`；`pickImmediatePredecessor("plan", {})` 返回 `null`；Worker 跳过 pre-task rebase 直接执行（详见链路 2 `§3 pre-task rebase` 行为）。

## 4. 关于 requirement 路径

```ts
// chain-router.ts:427-441
const requirementPath = cachePaths.chainRequirementPath(
  this.opts.cache_paths,
  chainDef.chain_id,
);
await fs.promises.writeFile(requirementPath, originalRequirement, "utf-8");
```

`chainRequirementPath` 解析到 CO root 仓内的 `chains/<chain_id>/requirement.md`。这条路径由 Leader 直接写入文件系统——**不**走 Worker DocsCommitter 通道，也**不**入 CO root 的 docs commit。原因：
- 它是 Leader 自身的产物，不属于任何 Worker 的 `docs/<Name>/` scope；
- 责任链推进过程中只需有一份"原始需求文本"可读，无需版本化历史；
- 若用户希望保留，可在外部进程对 CO root 仓做 `git add chains/` 单独提交（v0.6 不内置）。

## 5. 链路产出

| 产出 | 位置 | 说明 |
|------|------|------|
| 4-5 个 Task | `/tasks/pending/task-{seq}` | ZK PERSISTENT_SEQUENTIAL 节点；首 link 任务 `assigned_to` 已锁定到某空闲 worker |
| chain manifest | `<co_root>/chains/<chain_id>/manifest.json` | `link_tasks` 仅首 link 非 null；`link_workers` 仅首 link 非 null；`link_commits` 字段尚未创建 |
| requirement 文本 | `<co_root>/chains/<chain_id>/requirement.md` | 由 Leader 直接 `fs.writeFile`，不入 docs commit |
| task_dispatch 消息 | `/messages/<first_worker>/msg-{seq}` | 含 `upstream_commits = {}` |
| chain_activated 事件 | LeaderEventBus → TUI | EVENT LOG 展示链激活 |

## 6. 错误处理（rc1 关注项）

| 场景 | 处理 |
|------|------|
| `chain_id_conflict`（manifest 已存在且 status≠running） | 抛 `ChainConflictError` → 记 audit 事件 `chain_id_conflict` → 跳过本次需求（rc0 R-06，行为不变） |
| `requirement_path` 写盘失败 | log warn，**仍继续 push 任务**（首派 dispatch 的 `original_requirement_path` 为 null，下游 link 模板可读到 null 兜底） |
| `openChain` 写 manifest 失败 | 抛错到 LeaderWatcher 边界，本次需求不会 push 任务 |
| `collectUpstreamCommits` 抛错 | log warn → 返回 `{}`（chain-router.ts:188-200 兜底）；首派任务 upstream 永远是空，影响可忽略 |
