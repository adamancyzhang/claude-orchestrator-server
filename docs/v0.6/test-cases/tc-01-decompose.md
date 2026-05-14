# TC-01 — 需求拆解链路测试用例

> **覆盖链路**：用户输入 → decompose → ChainDef → push tasks（`core/01-requirement-to-tasks.md`）

## Level 1 — 单点测试

### TC-01.1.1 创建 pending 任务

```typescript
it("should push a task to /tasks/pending → verify: task exists with correct data", async () => {
  // Given: clean ZK
  // When:
  const task = await taskQueue.push({
    title: "Test Task",
    description: "A test task",
    priority: 1,
    link: "build",
  });

  // Then:
  expect(task.id).toMatch(/^task-\d{10}$/);
  expect(task.status).toBe("pending");

  const stored = await zk.getData(`/claude-orchestrator/tasks/pending/${task.id}`);
  const parsed = JSON.parse(stored.data.toString());
  expect(parsed.title).toBe("Test Task");
  expect(parsed.link).toBe("build");
});
```

### TC-01.1.2 解析 ChainDef JSON

```typescript
it("should parse a valid ChainDef JSON → verify: all 5 tasks extracted", async () => {
  // Given: valid ChainDef fixture
  const chainDef = JSON.parse(readFixture("chain-def-auth.json"));

  // When:
  const parsed = ChainDefSchema.parse(chainDef);

  // Then:
  expect(parsed.chain_id).toBe("chain-test-001");
  expect(parsed.tasks.plan).not.toBeNull();
  expect(parsed.tasks.build.title).toBe("Build Auth");
  expect(parsed.tasks.verify).toBeDefined();
  expect(parsed.tasks.review).toBeDefined();
  expect(parsed.tasks.accept).toBeDefined();
});
```

### TC-01.1.3 ChainDef 允许 plan 为 null

```typescript
it("should accept ChainDef with plan=null → verify: parsed successfully", async () => {
  // Given: ChainDef with plan=null
  const chainDef = { ...fixtureChainDef, tasks: { ...fixtureChainDef.tasks, plan: null } };

  // When:
  const parsed = ChainDefSchema.parse(chainDef);

  // Then:
  expect(parsed.tasks.plan).toBeNull();
});
```

### TC-01.1.4 拒绝无效 ChainDef

```typescript
it("should reject ChainDef missing build task → verify: ZodError", async () => {
  // Given: ChainDef without build
  const invalid = { chain_id: "c1", chain_title: "T", tasks: { plan: null } };

  // When/Then:
  expect(() => ChainDefSchema.parse(invalid)).toThrow();
});
```

## Level 2 — 双点对接

### TC-01.2.1 Decompose 输出 → Push 任务

```typescript
it("should push 5 tasks from ChainDef → verify: all tasks exist in pending", async () => {
  // Given: valid ChainDef
  const chainDef = ChainDefSchema.parse(JSON.parse(readFixture("chain-def-auth.json")));

  // When: handleChainDef
  await chainRouter.handleChainDef(chainDef);

  // Then:
  const pending = await taskQueue.listPending();
  expect(pending.length).toBe(5);

  const links = pending.map(t => t.link).sort();
  expect(links).toEqual(["accept", "build", "plan", "review", "verify"]);

  // All share same chain_id
  expect(new Set(pending.map(t => t.chain_id)).size).toBe(1);
});
```

### TC-01.2.2 ChainDef plan=null → Push 4 个任务

```typescript
it("should push only 4 tasks when plan=null → verify: no plan task", async () => {
  // Given: ChainDef with plan=null
  const chainDef = { ...fixtureChainDef, tasks: { ...fixtureChainDef.tasks, plan: null } };

  // When:
  await chainRouter.handleChainDef(chainDef);

  // Then:
  const pending = await taskQueue.listPending();
  expect(pending.length).toBe(4);
  expect(pending.find(t => t.link === "plan")).toBeUndefined();
});
```

### TC-01.2.3 Push 任务 → 生成任务文档

```typescript
it("should generate task doc for each pushed task → verify: doc files exist", async () => {
  // Given: valid ChainDef
  const chainDef = fixtureChainDef;

  // When:
  await chainRouter.handleChainDef(chainDef);

  // Then:
  const pending = await taskQueue.listPending();
  for (const task of pending) {
    expect(task.task_doc_path).not.toBeNull();
    const docExists = await fs.exists(path.join(cacheDir, leaderId, task.task_doc_path!));
    expect(docExists).toBe(true);
  }
});
```

## Level 3 — 短链测试

### TC-01.3.1 TUI 输入 → Decompose → Push 任务

```typescript
it("should decompose user input into 5 tasks → verify: full chain created", async () => {
  // Given: Leader TUI 输入 "Implement user authentication"
  const userInput = "Implement user authentication module with login and registration";

  // Mock claude-cli decompose 输出
  mockClaudeRunner.setFixture("decompose-auth-output.json");

  // When: 模拟 TUI → ZK → LeaderWatcher → ChainRouter 流程
  await simulateUserInput(userInput);

  // Then:
  const pending = await taskQueue.listPending();
  expect(pending.length).toBe(5);
  expect(pending.every(t => t.chain_id === pending[0].chain_id)).toBe(true);

  // 任务依赖关系正确
  const planTask = pending.find(t => t.link === "plan")!;
  const buildTask = pending.find(t => t.link === "build")!;
  expect(buildTask.depends_on).toContain(planTask.id);
});
```

### TC-01.3.2 Decompose 失败时不创建任务

```typescript
it("should not create tasks when decompose fails → verify: pending remains empty", async () => {
  // Given: mock claude-cli decompose 失败
  mockClaudeRunner.setError(new ClaudeRunnerError("CLAUDE_RUNNER_EXIT_NON_ZERO", "exit 1"));

  // When:
  await simulateUserInput("Some requirement");

  // Then:
  const pending = await taskQueue.listPending();
  expect(pending.length).toBe(0);
  // TUI should show debug_info event
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "debug_info" })
  );
});
```

## Level 4 — 全链测试

### TC-01.4.1 端到端：需求输入到任务就绪

```typescript
it("should go from user input to ready-to-claim tasks → verify: all tasks in pending with correct dependencies", async () => {
  // Given: 完整的 Leader 环境（TUI + ZK + TemplateEngine + ChainRouter）
  await startLeader();
  mockClaudeRunner.setFixture("decompose-auth-output.json");

  // When: 用户输入需求
  await tui.simulateInput("Implement user authentication module");
  await tui.simulateEnter();

  // 等待异步处理完成
  await waitFor(() => eventBus.hasEvent("chain_activated"), 5000);

  // Then:
  const pending = await taskQueue.listPending();
  expect(pending.length).toBe(5);

  // 验证链结构
  const chainId = pending[0].chain_id;
  const plan = pending.find(t => t.link === "plan" && t.chain_id === chainId)!;
  const build = pending.find(t => t.link === "build" && t.chain_id === chainId)!;
  const verify = pending.find(t => t.link === "verify" && t.chain_id === chainId)!;
  const review = pending.find(t => t.link === "review" && t.chain_id === chainId)!;
  const accept = pending.find(t => t.link === "accept" && t.chain_id === chainId)!;

  // 依赖关系: plan → build → verify → review → accept
  expect(build.depends_on).toEqual([plan.id]);
  expect(verify.depends_on).toEqual([build.id]);
  expect(review.depends_on).toEqual([verify.id]);
  expect(accept.depends_on).toEqual([review.id]);

  // 任务文档存在
  for (const task of pending) {
    const docExists = await fs.exists(path.join(cacheDir, leaderId, task.task_doc_path!));
    expect(docExists).toBe(true);
  }
});
```

## 测试数据依赖

| Fixture | 路径 | 用途 |
|---------|------|------|
| `chain-def-auth.json` | `tests/fixtures/` | 标准 ChainDef JSON |
| `chain-def-no-plan.json` | `tests/fixtures/` | plan=null 的 ChainDef |
| `decompose-auth-output.json` | `tests/fixtures/` | Mock claude-cli decompose 输出 |
