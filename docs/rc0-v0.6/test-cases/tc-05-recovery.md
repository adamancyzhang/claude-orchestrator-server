# TC-05 — 孤儿恢复链路测试用例

> **覆盖链路**：Worker 失联 → 孤儿检测 → retry / archive failed（`core/05-recovery.md`）

## Level 1 — 单点测试

### TC-05.1.1 解析 claimed 节点名

```typescript
it("should parse claimed node name into instance_id and task_id → verify: correct extraction", async () => {
  // Given: "test-worker-0001-task-0000000001"
  const nodeName = "test-worker-0001-task-0000000001";

  // When:
  const { instanceId, taskId } = parseClaimedNodeName(nodeName);

  // Then:
  expect(instanceId).toBe("test-worker-0001");
  expect(taskId).toBe("task-0000000001");
});
```

### TC-05.1.2 检测 EPHEMERAL 节点消失

```typescript
it("should detect instance EPHEMERAL node removal → verify: exists returns false", async () => {
  // Given: 创建 EPHEMERAL instance 节点
  await zk.createEphemeral("/claude-orchestrator/instances/test-worker-0001", Buffer.from("{}"));

  // When: 关闭该 ZK session（模拟 Worker 崩溃）
  await workerZkSession.close();

  // 等待 ZK session 超时（或手动删除）
  await sleep(500);
  const exists = await zk.exists("/claude-orchestrator/instances/test-worker-0001");

  // Then:
  expect(exists).toBe(false);
});
```

### TC-05.1.3 retry_count 限制

```typescript
it("should enforce MAX_RETRY = 3 → verify: OrphanRetryExhaustedError thrown", async () => {
  // Given: task 已重试 3 次
  const taskSnapshot = { ...baseTask, retry_count: 3 };

  // When/Then:
  await expect(recovery.reclaim(taskSnapshot)).rejects.toThrow(OrphanRetryExhaustedError);
});
```

## Level 2 — 双点对接

### TC-05.2.1 Instance 消失 → Claimed 删除 → 孤儿检测

```typescript
it("should detect orphan when instance disappears → verify: task recovered", async () => {
  // Given: claim 任务后 Worker ZK session 断开
  const task = await taskQueue.push({ title: "T", link: "build" });
  await taskQueue.claim(worker1Id, "builder");

  // 模拟 Worker 崩溃：关闭 session
  await worker1ZkSession.close();
  await sleep(500);  // 等待 EPHEMERAL 清理

  // When: Recovery 扫描
  await recovery.scanOrphans();

  // Then: 任务重新入 pending
  const pending = await taskQueue.listPending();
  const recovered = pending.find(t => t.title === "T");
  expect(recovered).toBeDefined();
  expect(recovered!.retry_count).toBe(1);
  expect(recovered!.status).toBe("pending");
});
```

### TC-05.2.2 孤儿 retry_count < 3 → 重新入队

```typescript
it("should re-enqueue orphan with incremented retry_count → verify: retry_count +1", async () => {
  // Given: retry_count = 1 的孤儿
  const taskSnapshot = { ...baseTask, id: "task-001" as TaskId, retry_count: 1 };

  // When:
  await recovery.reclaim(taskSnapshot);

  // Then: 新任务入 pending，retry_count = 2
  const pending = await taskQueue.listPending();
  const recovered = pending.find(t => t.description === taskSnapshot.description);
  expect(recovered).toBeDefined();
  expect(recovered!.retry_count).toBe(2);
});
```

### TC-05.2.3 孤儿 retry_count >= 3 → 归档 failed

```typescript
it("should archive as failed when retry exhausted → verify: completed/failed node created", async () => {
  // Given: retry_count = 3 的孤儿
  const taskSnapshot = { ...baseTask, id: "task-001" as TaskId, retry_count: 3 };

  // When:
  try { await recovery.reclaim(taskSnapshot); } catch { /* expected */ }

  // Then: 归档为 failed
  const completed = await zk.getData("/claude-orchestrator/tasks/completed/task-001");
  const archived = JSON.parse(completed.data.toString());
  expect(archived.status).toBe("failed");

  // task_failed 事件
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "task_failed", taskId: "task-001" })
  );
});
```

## Level 3 — 短链测试

### TC-05.3.1 启动时孤儿扫描

```typescript
it("should recover all orphans on Leader startup → verify: all orphans re-enqueued", async () => {
  // Given: 3 个 claimed 任务，对应 Worker 都已离线
  for (let i = 0; i < 3; i++) {
    const task = await taskQueue.push({ title: `Task ${i}`, link: "build" });
    // 手动创建 claimed 节点（simulate claim without active instance）
    await zk.createEphemeral(
      `/claude-orchestrator/tasks/claimed/dead-worker-${i}-${task.id}`,
      Buffer.from(JSON.stringify({
        task_id: task.id,
        instance_id: `dead-worker-${i}`,
        claimed_at: new Date().toISOString(),
        task_snapshot: { ...task, retry_count: 0 },
      })),
    );
  }

  // When: Leader 启动，触发 scanOrphans
  await recovery.scanOrphans();

  // Then: 3 个孤儿重新入 pending
  const pending = await taskQueue.listPending();
  expect(pending.length).toBe(3);
  expect(pending.every(t => t.retry_count === 1)).toBe(true);
});
```

### TC-05.3.2 运行时孤儿检测

```typescript
it("should detect orphan at runtime via ChildWatch → verify: orphan recovered without restart", async () => {
  // Given: Worker claim 任务后 ZK session 过期
  const task = await taskQueue.push({ title: "Runtime Orphan", link: "verify" });
  await taskQueue.claim(worker1Id, "verifier");

  // When: Worker ZK session 断开 → EPHEMERAL 清理 → ChildWatch 触发
  await worker1ZkSession.close();
  await sleep(500);
  await taskOrchestrator.triggerClaimedWatchCheck();

  // Then: 孤儿被恢复
  const pending = await taskQueue.listPending();
  const recovered = pending.find(t => t.title === "Runtime Orphan");
  expect(recovered).toBeDefined();
  expect(recovered!.retry_count).toBe(1);

  // task_recovered 事件
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "task_recovered" })
  );
});
```

## Level 4 — 全链测试

### TC-05.4.1 Worker 崩溃 → 孤儿 → 重试 → 成功

```typescript
it("should recover task after Worker crash and succeed on retry → verify: full recovery cycle", async () => {
  // Given: Worker 在执行 build 任务时崩溃
  const chainId = "chain-recovery-001";
  const planTask = await taskQueue.push({ title: "Plan", link: "plan", chain_id: chainId });
  const buildTask = await taskQueue.push({
    title: "Build", link: "build", chain_id: chainId,
    depends_on: [planTask.id],
  });

  // Plan 完成
  await taskQueue.claim(worker1Id, "planner");
  await taskQueue.complete(planTask.id, "done", worker1Id, "Tom", null);

  // Build 被 claim 但 Worker 崩溃
  await taskQueue.claim(worker2Id, "builder");
  await simulateWorkerCrash(worker2Id);

  // When: Recovery 触发
  await recovery.scanOrphans();

  // Then: Build 任务重新入 pending，retry_count = 1
  const pending = await taskQueue.listPending();
  const recovered = pending.find(t => t.chain_id === chainId && t.link === "build");
  expect(recovered).toBeDefined();
  expect(recovered!.retry_count).toBe(1);

  // 新 Worker 认领并完成
  const newWorkerId = "test-worker-0003";
  await instanceRegistry.register({ name: "Lisa", role: "builder" });
  const claimed = await taskQueue.claim(newWorkerId, "builder");
  expect(claimed).not.toBeNull();

  await taskQueue.complete(claimed!.id, "done", newWorkerId, "Lisa", 120);
  // task_completed 事件
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "task_completed", taskId: claimed!.id })
  );
});
```

### TC-05.4.2 多次重试最终归档

```typescript
it("should archive task after 3 failed retries → verify: task in completed as failed", async () => {
  // Given: 一个任务经历 3 次孤儿回收
  let task = await taskQueue.push({ title: "Unlucky Task", link: "build" });

  for (let round = 1; round <= 3; round++) {
    // Claim
    const workerId = `worker-round-${round}`;
    await instanceRegistry.register({ name: `Worker${round}`, role: "builder" });
    const claimed = await taskQueue.claim(workerId, "builder");
    expect(claimed).not.toBeNull();
    task = claimed!;

    // Worker 崩溃
    await simulateWorkerCrash(workerId);

    // Recovery
    await recovery.scanOrphans();

    if (round < 3) {
      const pending = await taskQueue.listPending();
      expect(pending.some(t => t.title === "Unlucky Task")).toBe(true);
    }
  }

  // After 3rd retry: archived as failed
  const completed = await taskQueue.listCompleted();
  const failed = completed.find(t => t.title === "Unlucky Task" && t.status === "failed");
  expect(failed).toBeDefined();
  expect(failed!.retry_count).toBe(3);
});
```

## Level 5 — 异常路径

### TC-05.5.1 父进程崩溃 → Worker 自杀

```typescript
it("should self-terminate when parent process dies → verify: child exits cleanly", async () => {
  // Given: Worker 子进程运行中
  const child = await startWorkerChild(config);

  // When: 主进程被 kill
  process.kill(process.ppid, "SIGKILL");  // 模拟

  // Then: 子进程在 1-2 秒内退出
  await expect(child.exitPromise).resolves.toBe(1);
});
```

### TC-05.5.2 ZK Session Expired → in-flight 任务继续 + 去重

```typescript
it("should continue in-flight claude call during ZK expiry → verify: dedup on completion report", async () => {
  // Given: Worker 正在执行 claude -p 时 ZK session expired
  const task = await taskQueue.push({ title: "T", link: "build" });
  await taskQueue.claim(worker1Id, "builder");

  // 模拟长时间运行的 claude 调用
  const longRunningPromise = new Promise(resolve => setTimeout(resolve, 3000));

  // ZK session expired → EPHEMERAL 清理 → Recovery 回收
  await worker1ZkSession.forceExpire();
  await recovery.scanOrphans();

  // 任务被重新入 pending（retry_count = 1）
  const pending = await taskQueue.listPending();
  const recoveredTask = pending.find(t => t.title === "T");
  expect(recoveredTask).toBeDefined();

  // 旧 Worker 完成 claude 调用后发送 completion_report
  await longRunningPromise;
  const msg = createCompletionReport("build", task.id, "chain-001", {
    decision: "activate_next", reason: "Done", next_link: "verify",
  });

  // When: Leader 收到旧的完成报告
  await chainRouter.route(msg);

  // Then: 去重 — task 已经被 re-enqueued 有新 ID，旧 report 被丢弃
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({
      type: "debug_info",
      message: expect.stringContaining("stale completion report"),
    })
  );
});
```

### TC-05.5.3 子进程重启 3 次后放弃

```typescript
it("should give up restarting after 3 crashes → verify: worker_left event", async () => {
  // Given: Worker 子进程连续崩溃
  const config = createChildConfig("Crashy", "builder");

  for (let i = 0; i < 4; i++) {
    const child = forkWorker(config);
    child.kill("SIGKILL");  // 模拟崩溃
    await sleep(200);
    // run.ts Phase 4 的 exit handler 自动重启（前 3 次）
  }

  // Then: 第 4 次崩溃后放弃
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({
      type: "worker_left",
      name: "Crashy",
    })
  );
});
```
