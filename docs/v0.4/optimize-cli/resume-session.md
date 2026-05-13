# `--resume` 优化：保持对话上下文传递

> **Status: ✅ Implemented** (2026-05)
>
> 方案已完全落地。额外引入了 `--fork-session` 以消除 evaluator 重试时的锚定效应。

## 问题

Worker 执行一个 chain-link 任务时，会多次调用 `claude -p`：

```
1. claude -p "执行 plan 任务"           → 完整上下文 A
2. claude -p "自我评估刚才的输出"        → 空白上下文，看不到步骤 1 做了什么
3. claude -p "生成 git commit message"  → 空白上下文，看不到步骤 1 和 2 做了什么
```

步骤 2 和 3 每次都是**冷启动**，导致评估质量低、commit message 无意义、重试成本高。

## 方案：`--resume` + `--fork-session`

### `--resume` 工作机制

```
claude -p "执行任务"                              # 创建 session_abc123
claude --resume session_abc123 -p "评估你的输出"    # 在同一个 session 中继续
claude --resume session_abc123 -p "生成 commit"    # 继续追加
```

### `--fork-session` 补充（实际实现新增）

Evaluator 重试时，如果直接 `--resume` 同一个 session，每次重试的 prompt/response 会叠加在对话历史中，造成锚定效应。`--fork-session` 基于主任务 session 创建一个**全新独立 session**（保留任务上下文，无评估历史）：

```
claude --resume session_abc123 --fork-session -p "评估..."  # 第 1 次，fork 干净分支
claude --resume session_abc123 --fork-session -p "评估..."  # 第 2 次，再次 fork 干净分支
```

## 实际实现

### 1. `src/utils/exec.ts` — session_id 提取 ✅

```typescript
// exec.ts:5-12
function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    return obj.session_id || null;
  } catch {
    return null;
  }
}
```

`execWithStreaming` 逐行解析 stdout JSON，从第一行 `system/init` 提取 `session_id`。返回值 `{ code: number; sessionId?: string }`。

### 2. `src/executor/runner.ts` — `--resume` + `--fork-session` ✅

```typescript
// runner.ts:81-102
async run(
  prompt: string,
  logPath: string,
  opts?: {
    systemPrompt?: string;
    resumeSessionId?: string;
    forkSession?: boolean;
  },
): Promise<{ code: number; sessionId?: string }> {
  let cmd = this.command;
  if (opts?.resumeSessionId) {
    cmd = `${cmd} --resume ${opts.resumeSessionId}`;
    if (opts?.forkSession) {
      cmd = `${cmd} --fork-session`;
    }
  }
  return execWithStreaming(cmd, prompt, logPath, opts?.systemPrompt, this.onChunk, this.workDir, this.quiet);
}
```

### 3. `src/worker/evaluator.ts` — Evaluator 使用 `--resume` + `--fork-session` ✅

```typescript
// evaluator.ts:88-92
await this.runner.run(prompt, evalLogPath, {
  systemPrompt: this.runner.buildIdentityPrompt(),
  resumeSessionId,
  forkSession: true,  // 每次重试 fork 干净分支
});
```

### 4. `src/worker/commit-checker.ts` — CommitChecker 使用 `--resume` ✅

```typescript
// commit-checker.ts:106
await this.runner.run(prompt, logPath, { resumeSessionId });
```

### 5. `src/worker/watcher.ts` — session_id 串联 ✅

```typescript
// watcher.ts:110-112 — 主任务执行，捕获 sessionId
const result = await this.runner.run(prompt, logPath, {
  systemPrompt: this.runner.buildIdentityPrompt(),
});

// watcher.ts:118-122 — 传递给 commit checker
commitResult = await this.commitChecker.check({...}, result.sessionId);

// watcher.ts:167 — 传递给 evaluator
reportContent = await this.evaluator.evaluate(link, msgVars, resultPath, uniqueKey, mainSessionId);
```

## 调用方适配汇总

所有 `runner.run()` 调用方已适配：

| 调用位置 | 实现 |
|----------|------|
| `WorkerWatcher.processMessage()` (L110) | `run(prompt, logPath, { systemPrompt })`，解构 `{ code, sessionId }` |
| `SelfEvaluator.evaluate()` (L88) | `run(prompt, evalLogPath, { systemPrompt, resumeSessionId, forkSession: true })` |
| `CommitChecker.generateCommitMessage()` (L106) | `run(prompt, logPath, { resumeSessionId })` |
| `ChainRouter.handleRequirement()` (L94) | `run(prompt, logPath, { systemPrompt })` |

## 边缘情况

### 1. session_id 提取失败

`--output-format stream-json --verbose` 已强制追加。仅在 Claude Code 未来版本改变输出格式时可能提取失败。此时：
- `sessionId` 为 `undefined`
- `--resume` 不会被追加到命令中
- 行为退化到冷启动，不阻塞任务执行

### 2. `--resume` 的 session 已被删除

由于 evaluator 和 commit checker 紧接着主任务执行（秒级间隔），session 被删除的概率极低。不额外处理。

### 3. evaluator 重试时 `--fork-session` 行为

每次重试 fork 一个独立 session（保留任务上下文，无评估历史）。这避免了之前重试的格式错误锚定效应。与原始方案（在同一 session 中累积历史）相比，`--fork-session` 更安全，但 evaluator 看不到上次的具体错误输出（仅依赖 `formatHint` 文本提示）。

## 收益

| 维度 | 优化前 | 优化后 | 状态 |
|------|--------|--------|------|
| Evaluator 可见信息 | 仅模板变量 + result file path | 完整的任务执行对话历史 | ✅ |
| Commit message 语义 | `chore: auto-commit plan task` | 基于实际变更内容生成 | ✅ |
| Evaluator 重试 | 每次冷启动，锚定效应 | `--fork-session` 干净分支 | ✅ |
| Evaluator 模板复杂度 | 需在 prompt 中重复 task 信息 | 可精简（上下文已有） | ✅ |
| 向后兼容 | N/A | session_id 提取失败时退化到冷启动 | ✅ |
