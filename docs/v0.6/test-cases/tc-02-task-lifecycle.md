# TC-02 — 任务生命周期链路测试用例

> **覆盖链路**：任务认领 → 模板渲染 → claude-cli 执行 → 自动提交 → 自评估（`core/02-task-claim-and-execute.md`）

## Level 1 — 单点测试

### TC-02.1.1 认领任务（原子锁）

```typescript
it("should claim a pending task atomically → verify: claimed node created, pending deleted", async () => {
  // Given: 一个 pending 任务
  const task = await taskQueue.push({ title: "T", link: "build" });

  // When:
  const claimed = await taskQueue.claim(worker1Id, "builder");

  // Then:
  expect(claimed).not.toBeNull();
  expect(claimed!.id).toBe(task.id);

  // pending 已删除
  const pending = await taskQueue.listPending();
  expect(pending.find(t => t.id === task.id)).toBeUndefined();

  // claimed 节点存在
  const claimedExists = await zk.exists(`/claude-orchestrator/tasks/claimed/${worker1Id}-${task.id}`);
  expect(claimedExists).toBe(true);
});
```

### TC-02.1.2 并发认领互斥

```typescript
it("should allow only one claimer to succeed → verify: second claim returns null", async () => {
  // Given: 一个 pending 任务，两个 Worker 同时 claim
  const task = await taskQueue.push({ title: "T", link: "build" });

  // When: 并发 claim
  const [result1, result2] = await Promise.all([
    taskQueue.claim(worker1Id, "builder"),
    taskQueue.claim(worker2Id, "builder"),
  ]);

  // Then: 只有一个成功
  const success = [result1, result2].filter(r => r !== null);
  expect(success.length).toBe(1);
  expect(success[0]!.id).toBe(task.id);
});
```

### TC-02.1.3 角色权重排序

```typescript
it("should prioritize role-link matching → verify: builder claims build task before planner", async () => {
  // Given: 两个 pending 任务 (build + plan)，builder 和 planner 同时 claim
  await taskQueue.push({ title: "Build Task", link: "build" });
  await taskQueue.push({ title: "Plan Task", link: "plan" });

  // When: builder claims
  const claimed = await taskQueue.claim(worker1Id, "builder");

  // Then: builder 应优先拿到 build 任务
  expect(claimed!.link).toBe("build");
});
```

### TC-02.1.4 解析 EvalDecision

```typescript
it("should parse valid activate_next EvalDecision → verify: all fields extracted", async () => {
  const json = JSON.parse(readFixture("eval-decision-activate-next.json"));
  const parsed = EvalDecisionSchema.parse(json);
  expect(parsed.decision).toBe("activate_next");
  expect(parsed.next_link).toBe("build");
});
```

### TC-02.1.5 拒绝无效 EvalDecision

```typescript
it("should reject EvalDecision with unknown decision → verify: ZodError", async () => {
  const invalid = { decision: "unknown_action", reason: "???" };
  expect(() => EvalDecisionSchema.parse(invalid)).toThrow();
});
```

## Level 2 — 双点对接

### TC-02.2.1 Task → Claim → 执行流程

```typescript
it("should claim task and process a message → verify: EvalDecision returned", async () => {
  // Given: pending 任务 + Worker 环境
  const task = await taskQueue.push({ title: "T", link: "plan" });
  await taskQueue.claim(worker1Id, "planner");

  // Mock claude-cli 输出
  mockClaudeRunner.setFixture("worker-plan-output.txt");
  mockEvaluator.setFixture("eval-decision-activate-next.json");

  // When: 模拟 ZK 消息到达
  const msg = await messageRouter.send({
    type: "task_dispatch",
    from_instance: leaderId,
    to_instance: worker1Id,
    link: "plan",
    task_id: task.id,
    content: "Plan the auth module",
  });

  // WorkerWatcher 处理
  await workerWatcher.processMessage(msg.id);

  // Then: EvalDecision 已发送
  const leaderMessages = await messageRouter.poll(leaderId);
  const completionReport = leaderMessages.find(m => m.type === "completion_report");
  expect(completionReport).toBeDefined();

  const evalDecision = JSON.parse(completionReport!.content);
  expect(evalDecision.decision).toBe("activate_next");
});
```

### TC-02.2.2 执行无变更任务 → CommitChecker 返回 null

```typescript
it("should skip commit when no git changes → verify: commitResult is null", async () => {
  // Given: 任务执行但不产生文件变更
  mockClaudeRunner.setOutput("No code changes needed, only documentation");
  mockGitStatus("");  // 空 status

  // When:
  const commitResult = await commitChecker.check(
    { link: "plan", taskTitle: "T", taskDescription: "D" },
    "session-123",
  );

  // Then:
  expect(commitResult).toBeNull();
});
```

### TC-02.2.3 执行产生变更 → 自动 commit

```typescript
it("should auto-commit when git has changes → verify: commit SHA returned", async () => {
  // Given: 任务执行产生文件变更
  await fs.writeFile(path.join(worktree, "test.txt"), "hello");
  mockClaudeRunner.setOutput("feat: add test file");

  // When:
  const commitResult = await commitChecker.check(
    { link: "build", taskTitle: "T", taskDescription: "D" },
    "session-123",
  );

  // Then:
  expect(commitResult).not.toBeNull();
  expect(commitResult!.sha).toMatch(/^[a-f0-9]{7,40}$/);
  expect(commitResult!.changedFiles).toContain("test.txt");
});
```

## Level 3 — 短链测试

### TC-02.3.1 消息 → 执行 → commit → 自评估 → 完成报告

```typescript
it("should complete full message processing pipeline → verify: completion report with EvalDecision + commit", async () => {
  // Given: Worker 完整环境 + pending 任务
  const task = await taskQueue.push({ title: "Build Auth", link: "build" });
  await taskQueue.claim(worker1Id, "builder");

  // Mock 各个阶段
  mockClaudeRunner.setFixture("worker-build-output.txt", { sessionId: "sess-001" });
  await fs.writeFile(path.join(worktree, "src/auth.ts"), "// auth impl");
  mockClaudeRunner.setNextCommitMessage("feat(auth): implement authentication");
  mockEvaluator.setFixture("eval-decision-activate-next.json");

  // When: 消息到达 → 完整管线
  const msg = await messageRouter.send({
    type: "task_dispatch",
    from_instance: leaderId,
    to_instance: worker1Id,
    link: "build",
    task_id: task.id,
    content: "Build the auth module",
  });

  await workerWatcher.processMessage(msg.id);

  // Then:
  const leaderMessages = await messageRouter.poll(leaderId);
  const report = leaderMessages.find(m => m.type === "completion_report")!;
  expect(report).toBeDefined();

  const content = JSON.parse(report.content);
  expect(content.decision).toBe("activate_next");
  expect(content.next_link).toBe("verify");

  // commit 信息嵌入
  const evalWithCommit = JSON.parse(report.content);
  expect(evalWithCommit.commit).toBeDefined();
  expect(evalWithCommit.commit.sha).toMatch(/^[a-f0-9]+$/);

  // 消息已标记已读
  const updatedMsg = await zk.getMessage(worker1Id, msg.id);
  expect(JSON.parse(updatedMsg!.data.toString()).read).toBe(true);
});
```

### TC-02.3.2 Evaluator 格式错误重试

```typescript
it("should retry evaluation on format error → verify: succeeds on retry", async () => {
  // Given: first 2 attempts return bad JSON, 3rd succeeds
  mockClaudeRunner.setSequence([
    { output: "not valid json", sessionId: "sess-001" },
    { output: "still not json", sessionId: "sess-002" },
    { output: JSON.stringify({ decision: "activate_next", reason: "ok", next_link: "verify" }), sessionId: "sess-003" },
  ]);

  // When:
  const result = await evaluator.evaluate("build", vars, resultPath, "key-001", "main-session");

  // Then:
  const parsed = JSON.parse(result);
  expect(parsed.decision).toBe("activate_next");
  // 验证 fork-session 被调用
  expect(mockClaudeRunner.getForkSessionCalls()).toBe(3);
});
```

## Level 4 — 全链测试

### TC-02.4.1 端到端 Worker 执行流程

```typescript
it("should go from pending task to completion report → verify: full pipeline succeeds", async () => {
  // Given: 完整 Worker 环境
  const task = await taskQueue.push({
    title: "Build Auth Module",
    description: "Implement login, registration, password reset",
    criteria: "All endpoints return 200, tests pass",
    link: "build",
    chain_id: "chain-test-001",
  });

  await taskQueue.claim(worker1Id, "builder");

  // Mock claude-cli 输出
  mockClaudeRunner.setFixture("worker-build-output.txt", { sessionId: "sess-build-001" });

  // 模拟产物
  await fs.writeFile(path.join(worktree, "src/auth/login.ts"), "export function login() {}");
  await fs.writeFile(path.join(worktree, "src/auth/register.ts"), "export function register() {}");
  mockClaudeRunner.setNextCommitMessage("feat(auth): implement login and registration");

  // Mock 自评估
  mockEvaluator.setFixture("eval-decision-activate-next-build.json");

  // When: 发送任务消息
  const msg = await messageRouter.send({
    type: "task_dispatch",
    from_instance: leaderId,
    to_instance: worker1Id,
    link: "build",
    task_id: task.id,
    chain_id: "chain-test-001",
    task_title: "Build Auth Module",
    task_description: "Implement login, registration, password reset",
    task_criteria: "All endpoints return 200, tests pass",
    task_doc_path: "tasks/task-0000000002.md",
    content: "Build the auth module",
  });

  await workerWatcher.processMessage(msg.id);

  // Then: 验证完成报告
  const leaderMessages = await messageRouter.poll(leaderId);
  const report = leaderMessages.find(m =>
    m.type === "completion_report" && m.task_id === task.id
  );
  expect(report).toBeDefined();
  expect(report!.link).toBe("build");
  expect(report!.result_path).not.toBeNull();

  // 验证 EvalDecision
  const evalDecision = JSON.parse(report!.content);
  expect(evalDecision.decision).toBe("activate_next");

  // 验证 commit
  expect(evalDecision.commit).toBeDefined();
  expect(evalDecision.commit.changed_files).toContain("src/auth/login.ts");
  expect(evalDecision.commit.changed_files).toContain("src/auth/register.ts");

  // 验证日志文件存在
  const logFiles = await fs.readdir(path.join(cacheDir, leaderId));
  expect(logFiles.some(f => f.includes("task-") && f.endsWith(".log"))).toBe(true);
  expect(logFiles.some(f => f.includes("-eval") && f.endsWith(".log"))).toBe(true);
  expect(logFiles.some(f => f.includes("-commit") && f.endsWith(".log"))).toBe(true);
});
```

## Level 5 — 异常路径

### TC-02.5.1 Claude 执行失败 → 发送 reject

```typescript
it("should send reject when claude exits non-zero → verify: completion_report with reject", async () => {
  // Given: claude-cli 返回非零退出码
  mockClaudeRunner.setError(new ClaudeRunnerError("CLAUDE_RUNNER_EXIT_NON_ZERO", "exit 1"));

  const task = await taskQueue.push({ title: "T", link: "build" });
  await taskQueue.claim(worker1Id, "builder");

  // When:
  const msg = await messageRouter.send({
    type: "task_dispatch", to_instance: worker1Id, link: "build",
    task_id: task.id, content: "Do something",
  });
  await workerWatcher.processMessage(msg.id);

  // Then:
  const leaderMessages = await messageRouter.poll(leaderId);
  const report = leaderMessages.find(m => m.type === "completion_report")!;
  const evalDecision = JSON.parse(report.content);
  expect(evalDecision.decision).toBe("reject");
});
```

### TC-02.5.2 Template 缺失 → 发送 reject

```typescript
it("should reject when template not found → verify: TemplateNotFoundError handled", async () => {
  // Given: 请求不存在的 link
  const task = await taskQueue.push({ title: "T", link: "unknown_link" as any });

  // When:
  const result = await workerWatcher.processMessageSafely("msg-001");

  // Then:
  expect(result).toBe("reject");
});
```

### TC-02.5.3 CommitChecker fallback

```typescript
it("should use fallback commit message when claude fails → verify: commit with fallback", async () => {
  // Given: claude-cli commit message 生成失败
  await fs.writeFile(path.join(worktree, "test.txt"), "hello");
  mockClaudeRunner.setErrorForCommit(new ClaudeRunnerError("CLAUDE_RUNNER_EXIT_NON_ZERO", "exit 1"));

  // When:
  const result = await commitChecker.check(
    { link: "build", taskTitle: "T", taskDescription: "D" },
    "session-123",
  );

  // Then: 使用 fallback message
  expect(result).not.toBeNull();
  expect(result!.message).toMatch(/^chore: auto-commit from/);
});
```
