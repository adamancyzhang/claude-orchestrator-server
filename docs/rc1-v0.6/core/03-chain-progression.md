# Core Chain 3 — 完成报告 → 双轨 commit 记账 → 路由 → 激活下一环节

> **链路定位**：Leader 收到 Worker 完成报告后，ChainRouter 解析 EvalDecision JSON + `commits` envelope，把双轨 commit 写入 chain manifest，按 decision 分支路由（activate_next 携 `upstream_commits` 向下游派发 / feedback 清理下游 commit / reject 终止 / close_chain 跳合并链路）。本文重写自 rc0 同名文件，主要新增 §3 commit 记账、§4.2 upstream_commits 注入、§5.2 clearLinkCommitsFrom 三节。

## 1. 链路总览

```
Worker 完成报告到达 /messages/{leader_id}/msg-{seq}
    │
    ▼
LeaderWatcher → ChainRouter.route → handleCompletionReport
    │
    ├─ Step 1: 解析 EvalDecision JSON（discriminated union by decision）
    │
    ├─ Step 2: 写 commit 记账
    │     ├─ 2.1 legacy `commit` 字段 → in-memory chainCommits（向后兼容）
    │     └─ 2.2 `commits` envelope → chain_audit.recordLinkCommit  ◄── rc1 关键
    │
    ├─ Step 3: 写 audit 事件 `completion_report`
    │
    └─ Step 4: 按 decision 分支
          ├── activate_next:
          │     ├─ findOrCreatePendingTask(nextLink)
          │     ├─ 选 worker → task_queue.assign + chain_audit.setLinkTask
          │     ├─ collectUpstreamCommits(chain_id)  ◄── rc1
          │     └─ message_router.send(task_dispatch, upstream_commits=...)
          │
          ├── feedback:
          │     ├─ resolveFeedbackTarget → null 则丢弃 + audit feedback_unresolved
          │     └─ dispatchFeedbackAsRetry
          │           ├─ incrementRetry → 超 max → closeChain("aborted")
          │           ├─ clearLinkCommitsFrom(prevLink)  ◄── rc1
          │           ├─ task_queue.push（retry，assigned_to=target）
          │           └─ collectUpstreamCommits + dispatch
          │
          ├── reject:
          │     └─ closeChain("aborted", reason="evaluator_reject")
          │
          └── close_chain → 跳链路 4（详见 04-merge-and-close.md）
```

## 2. Step 1 — 解析 EvalDecision

```ts
// chain-router.ts:560-566
const raw = JSON.parse(extractJson(msg.content));
const parsed = EvalDecisionSchema.safeParse(raw);
if (!parsed.success) {
  throw new ValidationError("invalid EvalDecision", parsed.error);
}
const decision: EvalDecision = parsed.data;
```

`EvalDecisionSchema` 是 discriminated union（discriminator: `decision`），4 种 variant：`activate_next` / `feedback` / `reject` / `close_chain`。所有 variant 均可选携带 `commits: { worktree, docs, branch }` 字段。

## 3. Step 2 — 双轨 commit 记账（rc1 关键）

### 3.1 legacy `commit` 字段（向后兼容）

```ts
// chain-router.ts:572-581
if (msg.chain_id && msg.link && raw.commit && typeof raw.commit === "object") {
  const c = raw.commit as Record<string, unknown>;
  if (typeof c.sha === "string" && typeof c.message === "string") {
    this.recordCommit(msg.chain_id, msg.link, msg.task_title ?? null, {
      sha: c.sha,
      message: c.message,
      branch: typeof c.branch === "string" ? c.branch : undefined,
    });
  }
}
```

`recordCommit` 把 commit 写入 ChainRouter 的内存 map `chainCommits: Map<ChainId, CommitInfo[]>`，用于 `runMergeValidation` legacy fallback（详见 `04-merge-and-close.md §5`）。旧 Worker 不发 `commits` envelope 时这是唯一通道。

### 3.2 新 `commits` envelope（rc1 默认）

```ts
// chain-router.ts:583-613
const commitsField = decision.commits as CompletionCommits | undefined;
if (
  this.opts.chain_audit &&
  msg.chain_id &&
  msg.link &&
  commitsField &&
  (commitsField.worktree || commitsField.docs) &&
  typeof this.opts.chain_audit.recordLinkCommit === "function"
) {
  const record: LinkCommitRecord = {
    worktree: commitsField.worktree,
    docs: commitsField.docs,
    branch: commitsField.branch,
  };
  await this.opts.chain_audit
    .recordLinkCommit(msg.chain_id, msg.link, record)
    .catch((err) => logger.warn("recordLinkCommit failed", {...}));
}
```

`chain_audit.recordLinkCommit`（`chain-audit.ts:218-236`）原子地把 `{worktree, docs, branch}` 写入 manifest.link_commits[link]。这条记录有两个用途：

1. **下一 link 派发时**：`collectUpstreamCommits(chain_id)` 从 manifest.link_commits 取出所有上游 link 的 worktree hash，注入下游 task_dispatch 的 `upstream_commits`，驱动 Worker 的 pre-task rebase。
2. **close_chain 合并时**：`runCloseChainMerge` 读 `link_commits.accept.{worktree, branch}`，对 accept 分支做单次合并（详见 `04-merge-and-close.md §2`）。

写入失败仅 log warn，**不影响**后续 decision 路由（best-effort 语义）。

## 4. Step 4a — activate_next（rc1 注入 upstream_commits）

```ts
// chain-router.ts:629-682
case "activate_next": {
  if (!msg.chain_id) break;
  const nextLink = decision.next_link;
  const nextTask = await this.findOrCreatePendingTask(msg.chain_id, nextLink);
  const worker = await this.findIdleWorkerByRole(LINK_TO_ROLE[nextLink]);
  if (worker) {
    await this.opts.task_queue.assign(nextTask.id, worker.id, worker.name);
    if (this.opts.chain_audit) {
      await this.opts.chain_audit.setLinkTask(msg.chain_id, nextLink, nextTask.id);
      await this.opts.chain_audit.record(msg.chain_id, {
        event: "task_dispatch", link: nextLink, worker_id, worker_name, task_id,
      });
    }
    const upstreamCommits = await this.collectUpstreamCommits(msg.chain_id);
    await this.opts.message_router.send({
      type: "task_dispatch",
      from_instance: leaderId, from_name: leaderName, from_role: "leader",
      to_instance: worker.id,
      link: nextLink,
      chain_id: msg.chain_id,
      task_id: nextTask.id,
      task_title, task_description, task_criteria,
      original_requirement_path: requirementPath,
      upstream_commits: upstreamCommits,
    });
    await this.rememberDispatch(msg.chain_id, nextLink, worker.id);
  }
  break;
}
```

### 4.1 worker 选择

`LINK_TO_ROLE` 映射决定首选角色（plan→planner, build→builder, ...）。`findIdleWorkerByRole` 优先返回 idle 状态、role 匹配的 Worker；没有 idle worker 时本次 dispatch 不发送，任务保持 pending，等下次有 worker idle 时由 `findOrCreatePendingTask` 路径重派。

### 4.2 collectUpstreamCommits 注入

```ts
// chain-router.ts:182-200
private async collectUpstreamCommits(chainId: ChainId): Promise<UpstreamCommits> {
  if (!this.opts.chain_audit) return {};
  if (typeof this.opts.chain_audit.collectUpstreamCommits !== "function") {
    return {};
  }
  try {
    return await this.opts.chain_audit.collectUpstreamCommits(chainId);
  } catch (err) {
    logger.warn("collectUpstreamCommits failed", { chain_id, error });
    return {};
  }
}
```

`chain_audit.collectUpstreamCommits`（`chain-audit.ts:249-265`）按 plan/build/verify/review 顺序遍历 manifest.link_commits，把 `worktree` 非空的项收入返回 map。返回值类型 `UpstreamCommits = { plan?, build?, verify?, review? }`，accept 不会被收（accept 是终点，没有下游）。

注入到 `task_dispatch` 后，Worker 在 Step 4 的 `pickImmediatePredecessor` 走查会读到这些 hash 选出 rebase 目标（详见 `02-task-claim-and-execute.md §3.1`）。

### 4.3 rememberDispatch — 记账 worker

```ts
// rememberDispatch（在 chain-router 内部）
// chain_audit.setLinkWorker(chainId, link, workerId)
// 在 chain-audit.ts:314-321 中：
manifest.link_workers ??= {plan:null, build:null, verify:null, review:null, accept:null};
manifest.link_workers[link] = workerId;
```

`link_workers` 用于两处：
- **feedback target 解析**：`resolveFeedbackTarget` 优先用显式 `feedback_target`，其次回退到 `manifest.link_workers[PREV_LINKS[msg.link]]`（详见 §5.1）。
- **merge_failed 重试**：`pushMergeConflictRetries` 用 `manifest.link_workers[failureLink]` 决定 retry 任务派给谁（详见 `04-merge-and-close.md §6`）。

## 5. Step 4b — feedback（rc1 含 clearLinkCommitsFrom）

```ts
// chain-router.ts:684-729
case "feedback": {
  const targetId = await this.resolveFeedbackTarget(msg, decision.feedback_target ?? null);
  if (!targetId) {
    logger.error("feedback target unresolved — dropping retry dispatch", {...});
    bus.emit({type:"debug_info", message: "feedback ... dropped: no resolvable target"});
    chain_audit.record({event:"feedback_unresolved", ...});
    break;
  }
  await this.dispatchFeedbackAsRetry({msg, targetId, feedback, requirementPath});
  break;
}
```

### 5.1 resolveFeedbackTarget（rc0 R-05 行为继承）

按优先级解析：
1. 显式 `decision.feedback_target`
2. `manifest.link_workers[PREV_LINKS[msg.link]]`（上一 link 的 worker）
3. 两者皆无 → 返回 `null`

返回 null 时 chain 仍 `running`（不修改 status），但本次 feedback 静默丢失。**不再** fallback 到 `msg.from_instance`（防止 self-feedback 死循环）。

### 5.2 dispatchFeedbackAsRetry — 关键节点（rc1 含 clearLinkCommitsFrom）

`chain-router.ts:1072-1198`：

```ts
// 1. 反馈累计上限熔断（rc0 R-04 行为）
if (chain_audit) {
  const counters = await chain_audit.incrementRetry(chainId);
  if (counters && counters.total_retry_count > counters.max_total_retries) {
    await chain_audit.closeChain(chainId, "aborted", {
      reason: "retry_ceiling_exceeded", total_retry_count, max_total_retries,
    });
    emitChainClosed(chainId);
    forgetChain(chainId);
    return;
  }
}

// 2. 解析 prevLink + retry_count
const prevLink = PREV_LINKS[msg.link] ?? msg.link;
const priorRetry = await this.lookupPriorRetry(chainId, prevLink, msg.task_id);

// 3. push retry task
const newTask = await task_queue.push({
  title: `[${chainId}] ${prevLink} (retry ${priorRetry + 1})`,
  description: feedback,
  criteria: "",
  priority: 1,
  link: prevLink,
  chain_id,
  retry_count: priorRetry + 1,
  created_by: leaderId,
  created_by_name: leaderName,
  assigned_to: targetId,
  assigned_to_name: targetName,
});

// 4. 清理被反馈 link 及其下游 commits（rc1 关键）
if (typeof chain_audit.clearLinkCommitsFrom === "function") {
  await chain_audit.clearLinkCommitsFrom(chainId, prevLink)
    .catch((err) => logger.warn("clearLinkCommitsFrom failed", {...}));
}

// 5. 注入 upstream_commits 后派发
const upstreamCommits = await collectUpstreamCommits(chainId);
await message_router.send({
  type: "task_dispatch",
  ...
  link: prevLink,
  task_id: newTask.id,
  task_description: feedback,
  task_criteria: "",
  upstream_commits: upstreamCommits,
});
```

### 5.3 为什么 feedback 要清理下游 commits

`chain_audit.clearLinkCommitsFrom(chainId, prevLink)`（`chain-audit.ts:268-289`）按 plan/build/verify/review/accept 顺序，**删除** `prevLink` 及其后所有 link 在 manifest.link_commits 中的记录。

假设场景：build 给 plan 反馈。如果不清理：
- plan 的 worktree commit（旧版本 P0）仍在 manifest.link_commits.plan
- 新 plan 完工写入 P1 时调 recordLinkCommit("plan", {worktree: P1, ...}) 会覆盖 P0 ✓
- 但 build link 已记录的 commit B（基于 P0 的 rebase 结果）仍在 manifest.link_commits.build
- 下次再走到 build 链节，collectUpstreamCommits 会返回 `{plan: P1, build: B}`
- verify 收到后 `pickImmediatePredecessor("verify", {plan:P1, build:B})` 返回 B —— **B 是基于 P0 的脏 commit**

清理后：
- prevLink="plan" → 删除 plan/build/verify/review/accept 所有 commit
- 新 plan 完工 recordLinkCommit("plan", {P1, ...}) 创建新条目
- 下游 link 重走时 collectUpstreamCommits 只会看到合法的"已重做"上游

## 6. Step 4c — reject

```ts
// chain-router.ts:793-804
case "reject": {
  if (msg.chain_id) {
    await chain_audit.closeChain(msg.chain_id, "aborted", { reason: "evaluator_reject" });
    emitChainClosed(msg.chain_id);
    forgetChain(msg.chain_id);
  }
  break;
}
```

reject 不调用 `clearLinkCommitsFrom`——chain 已 abort，下游永远不会再 dispatch，commit 记录是否清理无意义。manifest.link_commits 留作 audit 用途（已合并到 main 的 commit 仍然存在，只是不会被本系统再次访问）。

## 7. Step 4d — close_chain

直接跳到链路 4（`04-merge-and-close.md`）。本链路只负责"路由判定"，合并执行在合并链路完成。

## 8. 链路产出（rc1 全量）

| 产出 | 写入位置 | 触发场景 |
|------|---------|---------|
| `chainCommits` 内存 map 记账 | ChainRouter 实例字段 | legacy `commit` 字段存在时；fallback 合并用 |
| `manifest.link_commits[link]` | `<co_root>/chains/<chain_id>/manifest.json` | `commits` envelope 存在时；驱动 upstream + close_chain merge |
| `manifest.link_tasks[link]` | 同上 | dispatch 新任务时 setLinkTask |
| `manifest.link_workers[link]` | 同上 | rememberDispatch 时 setLinkWorker |
| `manifest.total_retry_count` | 同上 | dispatchFeedbackAsRetry 入口 incrementRetry |
| audit 事件 | manifest 同目录 events.ndjson | completion_report / task_dispatch / feedback_unresolved / retry_ceiling_exceeded / chain_closed |
| task_dispatch 消息 | `/messages/{worker}/msg-{seq}` | activate_next / feedback retry / merge_failed retry |

## 9. 错误处理

| 场景 | 处理 |
|------|------|
| EvalDecision 解析失败 | 抛 `ValidationError` 到 LeaderWatcher 边界，记 `debug_info` |
| `recordLinkCommit` 失败 | log warn，**继续** decision 路由（链推进不受影响） |
| `collectUpstreamCommits` 失败 | log warn，返回 `{}`（下游 Worker rebase 跳过） |
| `clearLinkCommitsFrom` 失败 | log warn，**继续** retry 派发（极端情况：下游 worker rebase 到陈旧 commit 时会在 commit/merge 节点再被发现） |
| nextLink 对应任务不存在 | `findOrCreatePendingTask` 兜底创建 |
| 无空闲 Worker | 任务保持 pending；下次 worker idle 时由 ZK Watch 触发 claim |
| feedback 目标不可解析 | 静默丢弃（rc0 R-05） |
| 反馈累计超 `max_total_retries` | 链转 `aborted` + 记 `retry_ceiling_exceeded`（rc0 R-04） |
| 评估器三连失败（Worker 侧） | 强制 `reject`（rc0 R-03） |
| `chain_id` 已 closed 后被重用 | 抛 `ChainConflictError` + 静默丢弃需求（rc0 R-06） |
