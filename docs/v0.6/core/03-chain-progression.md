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
| EvalDecision 解析失败 | 视为协议违规，记录 `task_failed` |
| nextLink 对应任务不存在 | `debug_info` 事件，不崩溃 |
| 无空闲 Worker | 任务保持在 pending，等待 Worker 自动 claim |
| feedback 目标 Worker 已离线 | 按角色权重找替代，或无目标广播 |
