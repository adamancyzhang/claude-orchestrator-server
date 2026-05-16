# Core Chain 3 — 完成报告 → 机械路由 → 激活下一环节

> **链路定位**：Leader 收到 Worker 完成报告后，ChainRouter 机械解析 EvalDecision JSON，决定激活下一环节、反馈修正、拒绝或关闭链。这是责任链推进的核心决策链路。

## 1. 链路总览

```
Worker 完成报告到达
    │
    ▼
/messages/{leader_id}/msg-{seq}    ← ChildWatch 触发
    │
    ▼
LeaderWatcher → ChainRouter.route(msg)
    │
    ▼
解析 EvalDecision JSON
    │
    ├── activate_next → MergeValidator.validate(commit)
    │     └─ 找到 nextLink 对应的 task → 发送 task_dispatch 消息给 Worker
    │
    ├── feedback → 重新派发上一 link 任务（附 feedback_to_worker）
    │
    ├── reject → 标记链失败，归档
    │
    └── close_chain → 标记链完成，归档
```

## 2. Step 1 — 解析 EvalDecision

```typescript
async handleCompletionReport(msg: Message, evalDecision: EvalDecision): Promise<void> {
  // 1. 如果有 commit，先做合并验证
  if (msg.commit?.sha) {
    const mergeDecision = await this.mergeValidator.validate({
      sha: msg.commit.sha,
      message: msg.commit.message,
      branch: msg.commit.branch,
      taskTitle: msg.task_title ?? "",
      taskLink: msg.link ?? "",
    });
    // 合并验证与 EvalDecision 解耦：即使 skip/review_first 也继续推进
  }

  // 2. 根据 decision 字段分支
  switch (evalDecision.decision) {
    case "activate_next": return this.handleActivateNext(msg, evalDecision);
    case "feedback":      return this.handleFeedback(msg, evalDecision);
    case "reject":        return this.handleReject(msg, evalDecision);
    case "close_chain":   return this.handleCloseChain(msg, evalDecision);
  }
}
```

## 3. Step 2a — activate_next

```typescript
async handleActivateNext(msg: Message, decision: EvalDecision): Promise<void> {
  const nextLink = decision.next_link;  // "build" | "verify" | "review" | "accept"

  // 1. 从当前 chain 中找到 nextLink 对应的 pending 任务
  const tasks = await taskQueue.listPending();
  const nextTask = tasks.find(t =>
    t.chain_id === msg.chain_id && t.link === nextLink
  );

  if (!nextTask) {
    // 该 link 任务不存在（可能已被认领或链异常）
    eventBus.emit({ type: "debug_info", message: `No pending task for link=${nextLink}` });
    return;
  }

  // 2. 找到合适的 Worker 发送任务消息
  const worker = findWorkerForLink(nextLink, decision.suggested_worker);

  // 3. 发送 task_dispatch 消息
  await messageRouter.send({
    type: "task_dispatch",
    from_instance: leaderId,
    from_name: "Leader",
    to_instance: worker?.id ?? null,
    link: nextLink,
    task_id: nextTask.id,
    chain_id: msg.chain_id,
    task_title: nextTask.title,
    task_description: nextTask.description,
    task_criteria: nextTask.criteria ?? "",
    task_doc_path: nextTask.task_doc_path,
    content: `${worker?.name ?? "Worker"}, 请执行 ${nextLink} 任务: ${nextTask.title}`,
  });

  eventBus.emit({ type: "task_dependency_resolved", taskId: nextTask.id });
}
```

### Worker 选择策略

```typescript
function findWorkerForLink(link: TaskLink, suggestedWorker?: InstanceId): WorkerInfo | undefined {
  // 1. 优先使用 Worker 建议的 instance
  if (suggestedWorker) {
    const suggested = workers.find(w => w.id === suggestedWorker && w.status === "idle");
    if (suggested) return suggested;
  }

  // 2. 按 ROLE_WEIGHTS 找最佳匹配的空闲 Worker
  const roleMap: Record<TaskLink, InstanceRole> = {
    plan: "planner", build: "builder", verify: "verifier",
    review: "reviewer", accept: "accepter",
  };
  const preferredRole = roleMap[link];

  return workers.find(w => w.role === preferredRole && w.status === "idle")
      || workers.find(w => w.status === "idle");  // 任意空闲 Worker
}
```

## 4. Step 2b — feedback

```typescript
async handleFeedback(msg: Message, decision: EvalDecision): Promise<void> {
  // 找到上一 link（当前 link 的前一环节）
  const prevLink = getPreviousLink(msg.link as TaskLink);

  // 重新派发给 feedback_target 指定的 Worker，或按角色权重找
  const targetWorker = decision.feedback_target
    ? workers.find(w => w.id === decision.feedback_target)
    : findWorkerForLink(prevLink);

  await messageRouter.send({
    type: "task_dispatch",
    to_instance: targetWorker?.id ?? null,
    link: prevLink,
    task_id: msg.task_id,  // 同一任务
    chain_id: msg.chain_id,
    content: `[Feedback] ${decision.feedback_to_worker}`,
    task_title: `[Revise] ${msg.task_title ?? ""}`,
    task_description: decision.feedback_to_worker,
  });

  eventBus.emit({ type: "debug_info", message: `Feedback to ${targetWorker?.name}: ${decision.reason}` });
}
```

### 上一环节映射

```typescript
function getPreviousLink(link: TaskLink): TaskLink {
  const order: TaskLink[] = ["plan", "build", "verify", "review", "accept"];
  const idx = order.indexOf(link);
  return order[Math.max(0, idx - 1)];  // plan 的 feedback 回到 plan
}
```

## 5. Step 2c — reject

```typescript
async handleReject(msg: Message, decision: EvalDecision): Promise<void> {
  // 链失败，归档
  await taskQueue.fail(msg.task_id!, decision.reason);

  eventBus.emit({ type: "task_failed", taskId: msg.task_id!, reason: decision.reason });

  // 级联失败：关闭链上所有其他 pending/claimed 任务
  const chainTasks = await taskQueue.listPending();
  for (const task of chainTasks) {
    if (task.chain_id === msg.chain_id && task.id !== msg.task_id) {
      await taskQueue.fail(task.id, `Chain rejected: ${decision.reason}`);
    }
  }
}
```

## 6. Step 2d — close_chain

```typescript
async handleCloseChain(msg: Message, decision: EvalDecision): Promise<void> {
  // 链正常关闭
  eventBus.emit({ type: "task_completed", taskId: msg.task_id!, instanceId: msg.from_instance });

  // 检查链上所有任务是否都已完成
  const allTasks = [
    ...(await taskQueue.listPending()),
    ...(await taskQueue.listClaimed()),
  ];
  const chainIncomplete = allTasks.some(t => t.chain_id === msg.chain_id);

  if (!chainIncomplete) {
    eventBus.emit({ type: "chain_activated", chainId: msg.chain_id! });
    // TUI 显示链完成
  }
}
```

## 7. 路由优先级回顾

ChainRouter 判定消息类别的优先级：

```
1. `type === "completion_report"` → content 是 EvalDecision JSON → 走本链路
2. `type === "user_input"` + content 是 ChainDef JSON → 走链路 1（push tasks）
3. `type === "user_input"` + 自由文本 → 走链路 1（decompose）
```

## 8. 与 MergeValidator 的集成

合并验证在 EvalDecision 处理**之前**执行，但与推进逻辑解耦：

```typescript
// 即使 merge 决策为 skip 或 review_first，链仍按 EvalDecision 继续推进
// 冲突分支保留在 Worker worktree，用户手动 merge
```

详见 `04-merge-and-close.md`。

## 9. 链路产出

| 产出 | 说明 |
|------|------|
| task_dispatch 消息 | 发送给下一环节 Worker |
| task_completed / task_failed 事件 | 更新 TUI |
| task_dependency_resolved 事件 | 解除下游任务阻塞 |
| chain_activated 事件 | 链关闭时通知 |

## 10. 错误处理

| 场景 | 处理 |
|------|------|
| EvalDecision 解析失败 | `ValidationError` 抛到 `LeaderWatcher.processMessage` 边界，记录 `debug_info` |
| nextLink 对应任务不存在 | `findOrCreatePendingTask` 兜底创建一个新 pending task |
| 无空闲 Worker | 任务保持 pending；ZK Watch 触发其他 Worker 后由 `claim` 排序认领 |
| feedback 目标不可解析 | **不再 fallback 到报告者自己**；记 `feedback_unresolved` audit 事件 + 丢弃（详见 §11 unresolved-target） |
| 反馈累计超 `max_total_retries` | 链转 `aborted` + 记 `retry_ceiling_exceeded` 事件（详见 §12 retry-ceiling） |
| 评估器三连失败 | 强制 `reject`（详见 §13 self-evaluation-fallback），不再 activate_next/close_chain |

## 11. unresolved-target — feedback 目标不可解析（RC0 新增）

`resolveFeedbackTarget(msg, explicit_target)` 按优先级解析：

1. **显式 target**（EvalDecision.feedback_target）
2. **prev-link worker**（`manifest.link_workers[PREV_LINKS[msg.link]]`）
3. 两者皆无 → 返回 `null`

返回 null 时 ChainRouter.handleCompletionReport 的 `feedback` 分支：

- 不派发任何 retry task
- 记 audit 事件 `feedback_unresolved`，payload 含 `feedback_to_worker` + `explicit_target`
- 发射 `debug_info` 事件：`feedback for chain <id>/<link> dropped: no resolvable target`
- 不修改 chain status（链仍 running，但本次 feedback 静默丢失）

历史背景：v0.6 早期返回 `msg.from_instance`（报告者本人）作为兜底，导致 worker 收到自己发的 feedback，可能死循环。修复见 R-05。

## 12. retry-ceiling — 反馈硬上限（RC0 新增）

每条 chain 的 manifest 持久化：

```
total_retry_count   // ChainAudit.incrementRetry 原子递增（持久化跨 Leader 重启）
max_total_retries   // 默认 DEFAULT_MAX_TOTAL_RETRIES = 9
                    // CO_CHAIN_MAX_RETRIES 环境变量 / ChainRouter.max_chain_retries 选项 覆写
```

`dispatchFeedbackAsRetry` 入口前置：

```
1. incrementRetry(chainId) → {total_retry_count, max_total_retries}
2. 若 total_retry_count > max_total_retries:
     - record audit event "retry_ceiling_exceeded"
     - closeChain(chainId, "aborted", { reason: "retry_ceiling_exceeded", ... })
     - emit debug_info: "chain <id> aborted: retry ceiling N exceeded"
     - emit chain_closed
     - 跳过本次 retry push
3. 否则继续标准 retry 流程
```

效果：A→B→A→B 无限相互反馈被熔断在第 N+1 次，资源不会耗尽。

## 13. self-evaluation-fallback — 评估器三连失败一律 reject（RC0 新增）

Worker 自评估最多重试 3 次。3 次都拿不到合法 JSON 时**强制输出**：

```json
{
  "decision": "reject",
  "reason": "self-evaluation failed after 3 attempts (link=<link>) — see eval logs"
}
```

regardless of which link the failure happened on。

历史背景：早期 fallback 在非 accept link 为 `activate_next`、accept link 为 `close_chain`。当 accept 的评估器输出格式持续异常时，等价于"无声签字" → 触发 MergeValidator 自动合并未审核内容。修复见 R-03。

## 14. chain_id-reuse — 重用已关闭 chain_id 被拒绝（RC0 新增）

`ChainAudit.openChain(chainId, meta)` 写盘前 `readManifest`：

- 存在 + `status !== "running"` → 抛 `ChainConflictError`
- 否则正常初始化

`ChainRouter.handleTaskDefinitions` catch：

- 记 audit 事件 `chain_id_conflict`，payload 含 `existing_status`、`existing_completed_at`、当次 requirement_path
- emit `debug_info`：`chain <id> already <status>; new requirement dropped`
- 跳过本次需求（原 manifest 不变）

效果：审计文件不会出现 `completed → running → completed` 的混乱轨迹。详见 R-06。
