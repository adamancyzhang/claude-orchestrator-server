# TC-04 — 合并验证链路测试用例

> **覆盖链路**：Worker commit → MergeValidator 裁决 → git merge / skip / review_first（`core/04-merge-and-close.md`）

## Level 1 — 单点测试

### TC-04.1.1 解析 MergeDecision

```typescript
it("should parse valid MergeDecision JSON → verify: all fields correct", async () => {
  const json = { decision: "merge", reason: "Safe to merge", conflict_files: [] };
  const parsed = MergeDecisionSchema.parse(json);
  expect(parsed.decision).toBe("merge");
});

it("should parse review_first with conflict files → verify: conflict_files populated", async () => {
  const json = {
    decision: "review_first",
    reason: "Merge conflict",
    conflict_files: ["src/auth.ts", "src/index.ts"],
  };
  const parsed = MergeDecisionSchema.parse(json);
  expect(parsed.conflict_files).toHaveLength(2);
});
```

### TC-04.1.2 MergeValidator 调用 ClaudeRunner

```typescript
it("should render merge template and call ClaudeRunner → verify: runner invoked with correct prompt", async () => {
  // Given: commit 信息
  const commitInfo = {
    sha: "abc1234", message: "feat: add feature",
    branch: "claude-orchestrator/Tom-workspace",
    taskTitle: "Build Feature", taskLink: "build",
  };

  // When:
  await mergeValidator.validate(commitInfo);

  // Then: ClaudeRunner 被调用
  expect(mockClaudeRunner.run).toHaveBeenCalledTimes(1);
  // 传入的 prompt 包含 commit 信息
  const promptArg = mockClaudeRunner.run.mock.calls[0][0];
  expect(promptArg).toContain("abc1234");
  expect(promptArg).toContain("claude-orchestrator/Tom-workspace");
});
```

### TC-04.1.3 claude-cli 失败 → 保守策略

```typescript
it("should default to review_first when claude-cli produces no valid JSON → verify: conservative", async () => {
  // Given: claude-cli 输出无有效 JSON
  mockClaudeRunner.setOutput("Some unstructured error output");

  const decision = await mergeValidator.validate({
    sha: "abc1234", message: "test", branch: "claude-orchestrator/Tom-workspace",
    taskTitle: "T", taskLink: "plan",
  });

  // Then: 保守策略
  expect(decision.decision).toBe("review_first");
  expect(decision.reason).toContain("failed");
});
```

## Level 2 — 双点对接

### TC-04.2.1 已合并 → skip

```typescript
it("should return skip when commit already in main → verify: no merge executed", async () => {
  // Given: commit 已在 main 中
  await execGit("checkout main");
  await fs.writeFile(path.join(repo, "test.txt"), "test");
  await execGit("add -A && commit -m 'test'");
  const sha = (await execGit("rev-parse HEAD")).trim();

  // When:
  const decision = await mergeValidator.validate({
    sha, message: "test", branch: "main",
    taskTitle: "T", taskLink: "build",
  });

  // Then:
  expect(decision.decision).toBe("skip");
  expect(decision.reason).toContain("merged");
});
```

### TC-04.2.2 合并成功

```typescript
it("should merge worker branch into main → verify: commit appears in main log", async () => {
  // Given: worker 分支有独立 commit
  await execGit("checkout -b claude-orchestrator/Tom-workspace");
  await fs.writeFile(path.join(repo, "feature.ts"), "export const x = 1;");
  await execGit("add -A && commit -m 'feat: add feature'");
  const sha = (await execGit("rev-parse HEAD")).trim();
  await execGit("checkout main");

  // Mock claude-cli merge decision
  mockClaudeRunner.setOutput(JSON.stringify({ decision: "merge", reason: "Safe" }));

  // When:
  const decision = await mergeValidator.validate({
    sha, message: "feat: add feature",
    branch: "claude-orchestrator/Tom-workspace",
    taskTitle: "Build Feature", taskLink: "build",
  });

  // Then:
  expect(decision.decision).toBe("merge");

  // main 现在包含 feature commit
  await execGit("checkout main");
  const log = await execGit("log --oneline -5");
  expect(log).toContain("feat: add feature");
});
```

### TC-04.2.3 合并冲突 → review_first

```typescript
it("should abort and return review_first on conflict → verify: main unchanged", async () => {
  // Given: main 和 worker 分支同时修改同一文件
  await execGit("checkout main");
  await fs.writeFile(path.join(repo, "conflict.ts"), "main content");
  await execGit("add -A && commit -m 'main change'");

  await execGit("checkout -b claude-orchestrator/Jerry-workspace");
  await fs.writeFile(path.join(repo, "conflict.ts"), "worker content");
  await execGit("add -A && commit -m 'worker change'");
  const sha = (await execGit("rev-parse HEAD")).trim();

  // When:
  const decision = await mergeValidator.validate({
    sha, message: "worker change",
    branch: "claude-orchestrator/Jerry-workspace",
    taskTitle: "T", taskLink: "build",
  });

  // Then:
  expect(decision.decision).toBe("review_first");
  expect(decision.conflict_files).toContain("conflict.ts");

  // main 未被修改
  await execGit("checkout main");
  const mainContent = await fs.readFile(path.join(repo, "conflict.ts"), "utf-8");
  expect(mainContent).toBe("main content");
});
```

## Level 3 — 短链测试

### TC-04.3.1 完成报告带 commit → MergeValidator 裁决 → merge

```typescript
it("should validate and merge on completion report with commit → verify: merged + chain continues", async () => {
  // Given: Worker 完成报告含 commit 信息
  await setupWorkerBranch("claude-orchestrator/Tom-workspace", "feat: plan blueprint");
  const sha = await getHeadSha();

  mockClaudeRunner.setOutput(JSON.stringify({ decision: "merge", reason: "Plan doc only, safe" }));

  const msg = createMessage({
    type: "completion_report",
    link: "plan",
    task_id: "task-001",
    chain_id: "chain-001",
    content: JSON.stringify({
      decision: "activate_next",
      reason: "Blueprint done",
      next_link: "build",
      commit: {
        sha, message: "feat: plan blueprint",
        branch: "claude-orchestrator/Tom-workspace",
        changed_files: ["docs/auth-blueprint.md"],
        untracked_files: [],
      },
    }),
  });

  // When:
  await chainRouter.route(msg);

  // Then: merge 决策发送
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "debug_info", message: expect.stringContaining("Merge: merge") })
  );

  // 链继续推进（build 任务激活）
  const jerryMessages = await messageRouter.poll(jerryId);
  expect(jerryMessages.some(m => m.link === "build")).toBe(true);
});
```

### TC-04.3.2 Commit skip 但链继续推进

```typescript
it("should continue chain even when merge is skipped → verify: next link activated", async () => {
  // Given: commit 已合并 → skip
  const sha = await getHeadSha();  // 已在 main 中
  mockClaudeRunner.setOutput(JSON.stringify({ decision: "skip", reason: "Already merged" }));

  const msg = createCompletionReport("plan", "task-001", "chain-001", {
    decision: "activate_next", reason: "done", next_link: "build",
    commit: { sha, message: "...", branch: "...", changed_files: [], untracked_files: [] },
  });

  // When:
  await chainRouter.route(msg);

  // Then: merge skip 但链继续
  const jerryMessages = await messageRouter.poll(jerryId);
  expect(jerryMessages.some(m => m.link === "build")).toBe(true);
});
```

## Level 4 — 全链测试

### TC-04.4.1 多 Worker 分支合并 + 链关闭

```typescript
it("should merge multiple worker branches and close chain → verify: all commits in main", async () => {
  // Given: 4 个 Worker 子分支（plan 为纯文档，无 commit）
  const branches = {
    build:  "claude-orchestrator/Jerry-workspace",
    verify: "claude-orchestrator/Lucy-workspace",
    review: "claude-orchestrator/Thomas-workspace",
    accept: "claude-orchestrator/Jack-workspace",
  };

  const shas: Record<string, string> = {};
  for (const [link, branch] of Object.entries(branches)) {
    await execGit(`checkout -b ${branch}`);
    await fs.writeFile(path.join(repo, `${link}.ts`), `// ${link} output`);
    await execGit("add -A && commit -m 'feat: ${link} output'");
    shas[link] = (await execGit("rev-parse HEAD")).trim();
  }

  mockClaudeRunner.setOutput(JSON.stringify({ decision: "merge", reason: "Safe" }));

  const chainId = "chain-merge-001";

  // When: 依次完成各环节（含 commit），最终 close_chain
  for (const link of ["build", "verify", "review"]) {
    await chainRouter.route(createCompletionReport(link, `task-${link}`, chainId, {
      decision: "activate_next",
      reason: `${link} done`,
      next_link: link === "build" ? "verify" : link === "verify" ? "review" : "accept",
      commit: {
        sha: shas[link],
        message: `feat: ${link} output`,
        branch: branches[link],
        changed_files: [`${link}.ts`],
        untracked_files: [],
      },
    }));
  }

  // Accept → close_chain（无 commit）
  await chainRouter.route(createCompletionReport("accept", "task-accept", chainId, {
    decision: "close_chain", reason: "All done",
    commit: null,
  }));

  // Then:
  // 1. 所有变更在 main 中
  await execGit("checkout main");
  for (const link of ["build", "verify", "review"]) {
    expect(await fs.exists(path.join(repo, `${link}.ts`))).toBe(true);
  }

  // 2. 链关闭事件
  expect(eventBus.events).toContainEqual(
    expect.objectContaining({ type: "chain_activated", chainId })
  );
});
```

## Level 5 — 异常路径

### TC-04.5.1 Claude merge decision 失败 → review_first

```typescript
it("should default to review_first when claude merge decision fails → verify: conservative", async () => {
  // Given: claude-cli 调用失败
  mockClaudeRunner.setError(new ClaudeRunnerError("CLAUDE_RUNNER_EXIT_NON_ZERO", "exit 1"));
  const sha = await createCommitOnBranch("claude-orchestrator/Tom-workspace", "test");

  // When:
  const decision = await mergeValidator.validate({
    sha, message: "test", branch: "claude-orchestrator/Tom-workspace",
    taskTitle: "T", taskLink: "plan",
  });

  // Then: 保守策略
  expect(decision.decision).toBe("review_first");
});
```

### TC-04.5.2 ClaudeRunner 执行异常

```typescript
it("should handle ClaudeRunner execution failure → verify: review_first returned", async () => {
  // Given: ClaudeRunner 抛出异常（claude-cli 进程崩溃）
  mockClaudeRunner.setError(new ClaudeRunnerError("CLAUDE_RUNNER_EXIT_NON_ZERO", "exit 1"));

  // When:
  const decision = await mergeValidator.validate({
    sha: "abc1234", message: "test", branch: "claude-orchestrator/Tom-workspace",
    taskTitle: "T", taskLink: "build",
  });

  // Then:
  expect(decision.decision).toBe("review_first");
});
```

## RC0 新增用例：R-02 merge_failed + Builder retry

落地于 `packages/leader/tests/core/unit/chain-router.test.ts` "aborts close_chain as merge_failed and pushes a retry to the link's worker on conflict"。

### TC-04.RC.1 单 commit 合并冲突 → chain merge_failed + builder retry

```typescript
it("should mark chain merge_failed and push retry to the link's worker on conflict", async () => {
  const tom = makeInstance("tom-01", "Tom", "planner");
  const jerry = makeInstance("jerry-01", "Jerry", "builder");
  // ... + Lucy/Mia/Leo

  // merge validator throws on build commit only
  const mergeValidator = {
    async validate(commit) {
      if (commit.task_link === "build")
        throw new Error(`merge ${commit.branch} conflicted at ${commit.sha}`);
      return { decision: "merge", reason: "ok" };
    },
  };
  const { router, msg, bus, audit } = setupWithMergeValidator(mergeValidator);

  // 跑通 plan→build→verify→review activate_next，链 close on accept
  await driveChainThroughCloseChain(router);

  // chain status = merge_failed（不是 completed）
  const closure = audit.closures.find(c => c.chainId === CHAIN_ID);
  expect(closure!.status).toBe("merge_failed");
  expect(closure!.status).not.toBe("completed");

  // chain_merge_failed 事件已 emit
  const mfEvent = bus.emitted.find(e => e.type === "chain_merge_failed");
  expect(mfEvent).toBeTruthy();
  expect((mfEvent as any).failures[0].link).toBe("build");

  // Jerry 收到 retry task with "Merge conflict" description
  const retry = msg.sent.find(m =>
    m.type === "task_dispatch" &&
    m.to_instance === jerry.id &&
    m.task_description?.includes("Merge conflict"),
  );
  expect(retry).toBeTruthy();

  // audit log 有 merge_failure 事件
  expect(audit.events.some(e => e.event === "merge_failure")).toBe(true);
});
```

### TC-04.RC.2 链状态机：merge_failed 是终态

```typescript
it("should treat merge_failed as a terminal status (no more dispatches except the retry)", async () => {
  // setup + cause merge failure
  // ... 同上
  // 关链后再发 completion_report 也无效
  await router.route(completionMessage("accept", JSON.stringify({ decision: "close_chain", reason: "x" }), leo.id));
  const closures = audit.closures.filter(c => c.chainId === CHAIN_ID);
  expect(closures).toHaveLength(1); // 不重复
});
```

### TC-04.RC.3 全成功路径仍正常合并（回归保证）

```typescript
it("should still close chain as completed when no merge conflict occurs", async () => {
  const mergeValidator = {
    async validate() { return { decision: "merge", reason: "ok" }; },
  };
  // ... 跑通整条链
  const closure = audit.closures.find(c => c.chainId === CHAIN_ID);
  expect(closure!.status).toBe("completed");
});
```
