# TC-06 — 评估器 fallback 测试用例（RC0 新增）

> **覆盖路径**：Self-Evaluator 三连失败 → 强制 reject 决策（不再 activate_next/close_chain）
> **对应代码**：`packages/worker/src/evaluator.ts`
> **对应实现修复**：REVIEW.md A4 / RC0 修复 R-03

## 背景

v0.6 早期实现：3 次 self-evaluate 失败时按 link 强制 fallback：
- 非 accept link → `{decision: "activate_next", next_link: NEXT_LINKS[link]}` —— 链推进到下一环节
- accept link → `{decision: "close_chain"}` —— 触发 MergeValidator 自动合并

后者是质量门反向：accept 评估器格式异常时会**自动签字**未审核的内容，等同于 bypass 人工/LLM 判断。

RC0 修复：3 次失败一律 `{decision: "reject", reason: "self-evaluation failed after 3 attempts (link=<link>) — see eval logs"}`，Leader 视为链终止 → `closeChain(chainId, "aborted")`、emit `chain_closed`，不触发 MergeValidator。

## Level 1 — 单点测试

### TC-06.1.1 plan link 三连失败 → reject

```typescript
it("should fallback to reject when plan link self-eval fails 3 times", async () => {
  // Given: 模板 + runner，runner 永远写非法 JSON
  const runner = new RecordingRunner(() => "junk");
  const evaluator = evaluatorWith(runner);

  // When:
  const out = await evaluator.evaluate({
    link: "plan",
    task_id: asTaskId("t-plan"),
    msg_vars: {},
    task_result_path: "/r/t-plan.md",
  });

  // Then:
  const parsed = JSON.parse(out);
  expect(parsed.decision).toBe("reject");
  expect(parsed.reason).toContain("link=plan");
  expect(runner.calls).toHaveLength(3); // MAX_RETRIES
});
```

### TC-06.1.2 accept link 三连失败 → reject（NOT close_chain）

**回归守门用例**：明确断言 fallback 不是 close_chain。

```typescript
it("should fallback to reject (NOT close_chain) when accept link self-eval fails 3 times", async () => {
  const runner = new RecordingRunner(() => "");
  const evaluator = evaluatorWith(runner);

  const out = await evaluator.evaluate({
    link: "accept",
    task_id: asTaskId("t-accept"),
    msg_vars: {},
    task_result_path: "/r/t-accept.md",
  });

  const parsed = JSON.parse(out);
  expect(parsed.decision).toBe("reject");
  expect(parsed.decision).not.toBe("close_chain"); // 关键
  expect(parsed.reason).toContain("link=accept");
});
```

### TC-06.1.3 第一次就成功 → 不走 fallback

```typescript
it("should NOT trigger fallback when first attempt succeeds", async () => {
  const runner = new RecordingRunner(() =>
    JSON.stringify({
      decision: "activate_next",
      reason: "ok",
      next_link: "build",
    }),
  );
  const evaluator = evaluatorWith(runner);

  const out = await evaluator.evaluate({
    link: "plan",
    task_id: asTaskId("t-1"),
    msg_vars: {},
    task_result_path: "/r/t-1.md",
  });

  expect(JSON.parse(out).decision).toBe("activate_next");
  expect(runner.calls).toHaveLength(1); // 没有重试
});
```

## Level 2 — 双点对接

### TC-06.2.1 fallback reject 被 ChainRouter 转为 aborted

```typescript
it("should route fallback reject through ChainRouter into closeChain('aborted')", async () => {
  // Given: ChainRouter + audit 已通过 handleTaskDefinitions 开链
  const audit = new FakeChainAudit();
  const router = chainRouterWith({ audit });
  await router.route(chainDefMessage(chainDefJson()));

  // 模拟一份 evaluator fallback 的 completion_report
  const fallbackDecision = JSON.stringify({
    decision: "reject",
    reason: "self-evaluation failed after 3 attempts (link=plan) — see eval logs",
  });

  // When:
  await router.route(
    completionMessage("plan", fallbackDecision, asInstanceId("tom-01")),
  );

  // Then: chain 状态转 aborted
  const closure = audit.closures.find((c) => c.chainId === CHAIN_ID);
  expect(closure!.status).toBe("aborted");
});
```

## Level 5 — 异常路径

### TC-06.5.1 不会触发 MergeValidator

```typescript
it("should NOT invoke MergeValidator when fallback emits reject from accept link", async () => {
  const validated: unknown[] = [];
  const mergeValidator = {
    async validate(c: unknown) {
      validated.push(c);
      return { decision: "merge" as const, reason: "" };
    },
  };
  const router = chainRouterWith({ merge_validator: mergeValidator });

  // accept 报告 reject（fallback 产物）
  await router.route(
    completionMessage(
      "accept",
      JSON.stringify({
        decision: "reject",
        reason: "self-evaluation failed after 3 attempts (link=accept) — see eval logs",
      }),
      asInstanceId("leo-01"),
    ),
  );

  // MergeValidator 必须未被触发
  expect(validated).toHaveLength(0);
});
```

## 涉及文件

| 文件 | 角色 |
|------|------|
| `packages/worker/src/evaluator.ts:115-129` | fallback 强制 reject 实现 |
| `packages/worker/tests/core/unit/evaluator.test.ts` | Level 1 测试落地点 |
| `packages/leader/src/chain-router.ts` | reject 路由到 closeChain("aborted") |
| `packages/leader/tests/core/unit/chain-router.test.ts` | Level 2/5 测试落地点 |

## 预期失败模式与处理

| 失败 | 含义 |
|------|------|
| fallback 输出 `decision: "activate_next"` | RC0 修复 R-03 退回 v0.6 状态，必须 hold 发布 |
| fallback 输出 `decision: "close_chain"` 在 accept link | 同上，质量门反向被重新引入 |
| accept link fallback 后 MergeValidator 仍被触发 | chain-router 未识别 reject，需检查 closeChain 调用路径 |
