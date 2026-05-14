# TC-03 — 责任链推进链路测试用例

> **覆盖链路**：完成报告 → ChainRouter 机械路由 → 激活下一环节 / feedback / reject / close_chain（`core/03-chain-progression.md`）

## Level 1 — 单点测试

### TC-03.1.1 路由判定：completion_report 类型

```typescript
it("should identify completion_report message → verify: routed to handleCompletionReport", async () => {
  // Given: completion_report 消息
  const msg = createMessage({
    type: "completion_report",
    content: JSON.stringify({ decision: "activate_next", reason: "ok", next_link: "build" }),
  });

  // When:
  const route = chainRouter.classify(msg);

  // Then:
  expect(route).toBe("completion_report");
});
```

### TC-03.1.2 路由判定：user_input + ChainDef

```typescript
it("should identify ChainDef in user_input → verify: routed to handleChainDef", async () => {
  // Given: user_input 消息内容为 ChainDef JSON
  const chainDef = JSON.parse(readFixture("chain-def-auth.json"));
  const msg = createMessage({
    type: "user_input",
    content: JSON.stringify(chainDef),
  });

  // When:
  const route = chainRouter.classify(msg);

  // Then:
  expect(route).toBe("chain_def");
});
```

### TC-03.1.3 路由判定：user_input 自由文本

```typescript
it("should identify free text as requirement → verify: routed to handleRequirement", async () => {
  // Given: 普通文本
  const msg = createMessage({ type: "user_input", content: "Implement login" });

  // When:
  const route = chainRouter.classify(msg);

  // Then:
  expect(route).toBe("requirement");
});
```

### TC-03.1.4 查找上一环节

```typescript
it("should return previous link in chain → verify: correct mapping", () => {
  expect(getPreviousLink("build")).toBe("plan");
  expect(getPreviousLink("verify")).toBe("build");
  expect(getPreviousLink("review")).toBe("verify");
  expect(getPreviousLink("accept")).toBe("review");
  expect(getPreviousLink("plan")).toBe("plan"); // plan feedback 回到 plan
});
```

## Level 2 — 双点对接

### TC-03.2.1 activate_next → 发送 task_dispatch

```typescript
it("should send task_dispatch to next worker on activate_next → verify: message delivered", async () => {
  // Given: 链中有 build 任务 pending，Worker 完成 plan 报告 activate_next(build)
  const chainId = "chain-test-001";
  await taskQueue.push({ title: "Build Auth", link: "build", chain_id: chainId });
  await instanceRegistry.register({ name: "Jerry", role: "builder" });

  const msg = createMessage({
    type: "completion_report",
    link: "plan",
    task_id: "task-0000000001",
    chain_id: chainId,
    content: JSON.stringify({
      decision: "activate_next",
      reason: "Plan complete",
      next_link: "build",
    }),
  });

  // When:
  await chainRouter.route(msg);

  // Then: Jerry 收到 task_dispatch
  const jerryMessages = await messageRouter.poll(jerryId);
  const dispatch = jerryMessages.find(m => m.type === "task_dispatch" && m.link === "build");
  expect(dispatch).toBeDefined();
  expect(dispatch!.chain_id).toBe(chainId);
});
```

### TC-03.2.2 feedback → 重新派发上一 link

```typescript
it("should re-dispatch to previous link on feedback → verify: task_dispatch sent with feedback content", async () => {
  // Given: build 完成报告 feedback
  const msg = createMessage({
    type: "completion_report",
    link: "build",
    task_id: "task-0000000002",
    chain_id: "chain-test-001",
    content: JSON.stringify({
      decision: "feedback",
      reason: "Missing error handling",
      feedback_to_worker: "Please add error codes and fallback strategy",
    }),
  });

  // When:
  await chainRouter.route(msg);

  // Then: plan worker 收到 feedback 消息
  const tomMessages = await messageRouter.poll(tomId);
  const feedback = tomMessages.find(m =>
    m.type === "task_dispatch" && m.link === "plan" && m.content.includes("[Feedback]")
  );
  expect(feedback).toBeDefined();
  expect(feedback!.task_title).toContain("[Revise]");
});
```

### TC-03.2.3 reject → 级联失败

```typescript
it("should fail all chain tasks on reject → verify: all tasks marked failed", async () => {
  // Given: 链中有 3 个 pending 任务
  const chainId = "chain-test-001";
  await taskQueue.push({ title: "Plan", link: "plan", chain_id: chainId });
  await taskQueue.push({ title: "Build", link: "build", chain_id: chainId });
  const verifyTask = await taskQueue.push({ title: "Verify", link: "verify", chain_id: chainId });

  // When: verify reject
  const msg = createMessage({
    type: "completion_report",
    link: "verify",
    task_id: verifyTask.id,
    chain_id: chainId,
    content: JSON.stringify({ decision: "reject", reason: "Architecture conflict" }),
  });
  await chainRouter.route(msg);

  // Then: 链上所有任务 failed
  const pending = await taskQueue.listPending();
  const chainTasks = pending.filter(t => t.chain_id === chainId);
  expect(chainTasks.length).toBe(0);  // 全部从 pending 移除

  // task_failed 事件已发出
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "task_failed", taskId: verifyTask.id })
  );
});
```

## Level 3 — 短链测试

### TC-03.3.1 Plan → Build → Verify 顺序推进

```typescript
it("should progress plan→build→verify sequentially → verify: each link activates after completion", async () => {
  // Given: 完整链 tasks
  const chainId = "chain-test-seq";
  const planTask = await taskQueue.push({ title: "Plan", link: "plan", chain_id: chainId });
  const buildTask = await taskQueue.push({ title: "Build", link: "build", chain_id: chainId, depends_on: [planTask.id] });
  const verifyTask = await taskQueue.push({ title: "Verify", link: "verify", chain_id: chainId, depends_on: [buildTask.id] });

  // Step 1: Plan 完成 → activate_next(build)
  await chainRouter.route(createCompletionReport("plan", planTask.id, chainId, {
    decision: "activate_next", reason: "done", next_link: "build",
  }));
  let jerryMessages = await messageRouter.poll(jerryId);
  expect(jerryMessages.some(m => m.link === "build")).toBe(true);

  // Step 2: Build 完成 → activate_next(verify)
  await chainRouter.route(createCompletionReport("build", buildTask.id, chainId, {
    decision: "activate_next", reason: "done", next_link: "verify",
  }));
  let lucyMessages = await messageRouter.poll(lucyId);
  expect(lucyMessages.some(m => m.link === "verify")).toBe(true);
});
```

### TC-03.3.2 feedback 后重新执行成功

```typescript
it("should complete after feedback and re-execution → verify: chain progresses", async () => {
  // Given: build 任务第一次 feedback
  const buildTask = await taskQueue.push({ title: "Build", link: "build", chain_id: "chain-fb" });

  // 第一次: feedback
  await chainRouter.route(createCompletionReport("build", buildTask.id, "chain-fb", {
    decision: "feedback", reason: "Missing tests", feedback_to_worker: "Add unit tests",
  }));

  // Plan worker 收到 feedback
  const tomMessages = await messageRouter.poll(tomId);
  expect(tomMessages.some(m => m.content.includes("[Feedback]"))).toBe(true);

  // Worker 重新执行后: activate_next
  await chainRouter.route(createCompletionReport("build", buildTask.id, "chain-fb", {
    decision: "activate_next", reason: "Tests added", next_link: "verify",
  }));

  // Verify worker 收到 dispatch
  const lucyMessages = await messageRouter.poll(lucyId);
  expect(lucyMessages.some(m => m.link === "verify")).toBe(true);
});
```

## Level 4 — 全链测试

### TC-03.4.1 完整 P→B→V→R→A 链推进

```typescript
it("should complete full plan→build→verify→review→accept chain → verify: all links activated and chain closed", async () => {
  // Given: 5 个任务 + 5 个 Worker
  const chainId = "chain-full-001";
  const tasks: Record<string, Task> = {};

  for (const link of ["plan", "build", "verify", "review", "accept"]) {
    tasks[link] = await taskQueue.push({
      title: `${link} task`,
      link: link as TaskLink,
      chain_id: chainId,
      depends_on: link === "plan" ? [] : [tasks[prevLink(link)]?.id].filter(Boolean),
    });
  }

  // Register 5 workers
  await registerWorker("Tom", "planner");
  await registerWorker("Jerry", "builder");
  await registerWorker("Lucy", "verifier");
  await registerWorker("Thomas", "reviewer");
  await registerWorker("Jack", "accepter");

  // When: 依次推进每个环节

  // Plan → Build
  await chainRouter.route(createCompletionReport("plan", tasks.plan.id, chainId, {
    decision: "activate_next", reason: "Blueprint done", next_link: "build",
  }));
  expect(await hasMessageFor("Jerry", "build")).toBe(true);

  // Build → Verify
  await chainRouter.route(createCompletionReport("build", tasks.build.id, chainId, {
    decision: "activate_next", reason: "Implemented", next_link: "verify",
  }));
  expect(await hasMessageFor("Lucy", "verify")).toBe(true);

  // Verify → Review
  await chainRouter.route(createCompletionReport("verify", tasks.verify.id, chainId, {
    decision: "activate_next", reason: "Verified", next_link: "review",
  }));
  expect(await hasMessageFor("Thomas", "review")).toBe(true);

  // Review → Accept
  await chainRouter.route(createCompletionReport("review", tasks.review.id, chainId, {
    decision: "activate_next", reason: "Passed review", next_link: "accept",
  }));
  expect(await hasMessageFor("Jack", "accept")).toBe(true);

  // Accept → close_chain
  await chainRouter.route(createCompletionReport("accept", tasks.accept.id, chainId, {
    decision: "close_chain", reason: "Accepted, all criteria met",
  }));

  // Then: 链关闭事件
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "chain_activated", chainId })
  );
});
```

## Level 5 — 异常路径

### TC-03.5.1 nextLink 任务不存在

```typescript
it("should emit debug_info when next task not found → verify: no crash", async () => {
  // Given: activate_next 但 nextLink 任务不在 pending 中
  const msg = createCompletionReport("plan", "task-0000000001", "chain-ghost", {
    decision: "activate_next", reason: "done", next_link: "build",
  });

  // When:
  await chainRouter.route(msg);

  // Then: debug_info 事件，不崩溃
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "debug_info" })
  );
});
```

### TC-03.5.2 EvalDecision JSON 解析失败

```typescript
it("should handle invalid EvalDecision JSON gracefully → verify: task_failed", async () => {
  // Given: completion_report 但 content 不是有效 EvalDecision
  const msg = createMessage({
    type: "completion_report",
    content: "not valid json {{{",
    task_id: "task-001",
    chain_id: "chain-001",
  });

  // When:
  await chainRouter.route(msg);

  // Then: 协议违规，标记 failed
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "task_failed" })
  );
});
```

### TC-03.5.3 无空闲 Worker 时任务保持 pending

```typescript
it("should keep task in pending when no idle worker → verify: task not claimed", async () => {
  // Given: 所有 Worker 都 busy
  setAllWorkersBusy();

  await chainRouter.route(createCompletionReport("plan", "task-001", "chain-001", {
    decision: "activate_next", reason: "done", next_link: "build",
  }));

  // Then: build 任务仍在 pending（未被 claim）
  const pending = await taskQueue.listPending();
  expect(pending.some(t => t.link === "build" && t.chain_id === "chain-001")).toBe(true);
});
```
