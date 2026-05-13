# `--resume` 优化：保持对话上下文传递

## 问题

当前 Worker 执行一个 chain-link 任务时，会多次调用 `claude -p`：

```
1. claude -p "执行 plan 任务"           → 完整上下文 A
2. claude -p "自我评估刚才的输出"        → 空白上下文，看不到步骤 1 做了什么
3. claude -p "生成 git commit message"  → 空白上下文，看不到步骤 1 和 2 做了什么
```

步骤 2 和 3 每次都是**冷启动**。SelfEvaluator 只能看到 `worker-evaluate.md` 模板中拼入的 `{{task_title}}`、`{{task_description}}` 和 `{{task_result_path}}`（一个文件路径），它需要自己再去读文件来了解执行结果。CommitChecker 也只能看到 git status 的文件列表 + task title，无法生成有意义的 commit message。

这导致：

- **评估质量低**：evaluator 不了解实际执行过程和修改意图，只能基于极有限的 prompt 信息做判断
- **Commit message 质量低**：当前 `CommitChecker.generateCommitMessage()` 实际生成的是机械的 `chore: auto-commit` fallback，没有任何语义
- **重试成本高**：evaluator 每次重试也是冷启动，失败后 format hint 无法参考上次错误进行调整（`src/worker/evaluator.ts:87-89` 的 `formatHint` 是拼入 prompt 的，看不到上次的实际错误输出）

## 方案：`--resume` 保持会话连续性

### `--resume` 工作机制

Claude Code 的 `--resume` flag 允许恢复一个已存在的会话：

```
claude -p "执行任务"                              # 创建 session_abc123
claude --resume session_abc123 -p "评估你的输出"    # 在同一个 session 中继续
claude --resume session_abc123 -p "生成 commit"    # 继续追加
```

恢复后的会话包含**完整的对话历史**（之前所有的 prompt 和 response），且可以继续读写文件。

### 优化后流程

```
1. claude -p "执行 plan 任务"
   → 返回 { code: 0, sessionId: "abc123" }

2. claude --resume abc123 -p "自我评估刚才的输出（不需要再描述任务）"
   → evaluator 能直接看到步骤 1 的完整上下文

3. claude --resume abc123 -p "生成 git commit message"
   → commit generator 能看到执行结果和评估结论
```

## 改动清单

### 1. `src/utils/exec.ts` — 从 stream-json 输出中提取 session_id

由于所有调用都使用 `--output-format stream-json`（`src/config.ts:62-63`），stdout 每行都是 JSON。session_id 出现在启动阶段的某一行中。

**新增共享函数**：

```typescript
function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    return obj.session_id || obj.sessionId || null;
  } catch {
    return null;
  }
}
```

**修改 `execWithTee`**：新增 session ID 提取逻辑，在 `stdout.on("data")` 中解析 JSON 行。

**修改 `execWithStreaming`**：已有 line-by-line 解析（`partial` buffer），在现有循环中加入 `extractSessionId`。

**修改 `execAndCapture`**：同上。

**返回值变更**：

| 函数 | 当前返回 | 新返回 |
|------|----------|--------|
| `execWithTee` | `{ code }` | `{ code, sessionId? }` |
| `execWithStreaming` | `{ code }` | `{ code, sessionId? }` |
| `execAndCapture` | `{ code, stdout, stderr }` | `{ code, stdout, stderr, sessionId? }` |

### 2. `src/executor/runner.ts` — 支持 `--resume`

**`run()` 签名变更**：

```typescript
// 当前
async run(prompt: string, logPath: string, onStreamChunk?: (line: string) => void): Promise<{ code: number }>

// 优化后
async run(
  prompt: string,
  logPath: string,
  opts?: {
    onStreamChunk?: (line: string) => void;
    resumeSessionId?: string;
  },
): Promise<{ code: number; sessionId?: string }>
```

**内部实现**：
```typescript
async run(prompt: string, logPath: string, opts?: {...}): Promise<{ code: number; sessionId?: string }> {
  let cmd = this.command;
  if (opts?.resumeSessionId) {
    cmd = `${cmd} --resume ${opts.resumeSessionId}`;
  }
  // 使用 cmd 而非 this.command 进行本次调用
  if (opts?.onStreamChunk) {
    return execWithStreaming(cmd, prompt, logPath, opts.onStreamChunk, this.workDir, this.quiet);
  }
  return execWithTee(cmd, prompt, logPath, this.workDir, this.quiet);
}
```

### 3. `src/worker/evaluator.ts` — 使用 `--resume` 上下文

**`evaluate()` 签名变更**：

```typescript
async evaluate(
  link: string,
  msgVars: Record<string, string>,
  taskResultPath: string,
  uniqueKey: string,
  resumeSessionId?: string,  // 新增
): Promise<string>
```

**内部改动**：将 `resumeSessionId` 传递到每次 `runner.run()` 调用（含重试）。

```typescript
await this.runner.run(prompt, evalLogPath, { resumeSessionId });
```

**附加收益**：evaluator 可以使用精简后的评估模板。因为 evaluator 能直接看到会话中已执行的任务，模板中不再需要重复 `task_title`、`task_description`、`task_criteria` 等已在主任务 prompt 中的内容。evaluator 只需：

```markdown
## Self-Evaluation

Review the task you just completed. The result is at {{task_result_path}}.

Decide: activate_next, feedback, or close_chain.

Output ONLY valid JSON: {"decision": "...", "reason": "...", ...}
```

### 4. `src/worker/commit-checker.ts` — 使用 `--resume` 上下文

**`check()` 签名变更**：

```typescript
async check(
  taskContext: { link: string; taskTitle: string; taskDescription: string },
  resumeSessionId?: string,  // 新增
): Promise<CommitResult | null>
```

**`generateCommitMessage()` 改动**：

```typescript
const result = await this.runner.run(prompt, logPath, { resumeSessionId });
```

**附加收益**：有完整上下文后，commit message 不再需要 fallback 到 `chore: auto-commit`。Claude 能看到自己做了哪些修改，能生成如 `feat: add login form with validation` 这样有意义的 message。

### 5. `src/worker/watcher.ts` — 串联 session_id

**`processMessage()` 改动**：

```typescript
// 主任务执行，捕获 sessionId
const result = await this.runner.run(prompt, logPath);
// result.sessionId  ← 新增

// 传递给 evaluator
reportContent = await this.evaluator.evaluate(
  link, msgVars, resultPath, uniqueKey,
  result.sessionId,  // 新增
);

// 传递给 commit checker
commitResult = await this.commitChecker.check(
  { link, taskTitle, taskDescription },
  result.sessionId,  // 新增
);
```

### 6. `src/leader/chain-router.ts` — Leader 侧（可选）

Leader 的 decompose 自执行（`handleRequirement`）调用 `runner.run()` 后没有下游 evaluator/commit 步骤，不需要 `--resume`。但如果未来 Leader 也有类似自查需求，改动方式与 Worker 侧一致。

## 调用方兼容性汇总

所有 `runner.run()` 调用方在本次改动中的适配：

| 调用位置 | 当前 | 改动 |
|----------|------|------|
| `WorkerWatcher.processMessage()` (L115) | `run(prompt, logPath)` | `run(prompt, logPath)`，解构 `{ code, sessionId }` |
| `SelfEvaluator.evaluate()` (L92) | `run(prompt, evalLogPath)` | `run(prompt, evalLogPath, { resumeSessionId })` |
| `CommitChecker.generateCommitMessage()` (L102) | `run(prompt, logPath)` | `run(prompt, logPath, { resumeSessionId })` |
| `ChainRouter.handleRequirement()` (L99) | `run(prompt, logPath, cb)` | `run(prompt, logPath, { onStreamChunk: cb })` |

## 边缘情况

### 1. session_id 提取失败

如果 `--output-format stream-json` 被用户覆盖，或者 Claude Code 输出格式变化导致无法解析 session_id：

- `sessionId` 为 `undefined`
- `--resume` 不会被追加到命令中
- 行为退化到当前状态 — 冷启动，无上下文传递
- 不阻塞任务执行

### 2. `--resume` 的 session 已被删除

如果 session 过期或被用户手动删除：

- Claude Code 会报错退出，返回非零 exit code
- Worker 的 evaluator 重试机制（max 3）会捕获错误
- 第 2 次重试时可用 `--resume` 的 fallback（不带 `--resume` 再试）

实际上，由于 evaluator 和 commit checker 紧接着主任务执行（秒级间隔），session 被删除的概率极低。不额外处理这个边缘情况。

### 3. evaluator 重试时 session 连续性

```
主任务 → session 中有 [task_prompt, task_response]
eval 第 1 次 → session 中追加 [eval_prompt, eval_response_v1]  ← 可能格式错误
eval 第 2 次 → session 中追加 [eval_prompt_v2, eval_response_v2]  ← 能看到 v1 的错误
```

每次重试恢复同一个 session，evaluator 能**直接看到上次的格式错误**而不只依赖 `formatHint` 文本。这提升了重试的成功率。

### 4. 不使用 `--resume` (仅 `--resume` 不带参数)

不推荐使用不带 session ID 的 `--resume`（resume 最近 session），因为可能有并发任务导致恢复错误的 session。始终使用明确的 session ID。

## 收益

| 维度 | 当前 | 优化后 |
|------|------|--------|
| Evaluator 可见信息 | 仅 `{{task_title}}`, `{{task_description}}`, result file path | 完整的任务执行对话历史 |
| Commit message 语义 | `chore: auto-commit plan task` | 基于实际变更内容生成，如 `feat: add user login blueprint` |
| Evaluator 重试利用率 | 每次冷启动，失败后靠文本 hint 修正 | 能看到上次的实际错误输出，修正更精准 |
| Evaluator 模板复杂度 | 需要在 prompt 中重复 task 信息 | 可精简，上下文已有 |
| 向后兼容 | N/A | session_id 提取失败时自动退化到冷启动 |

## 实施风险

- **低风险**：`--resume` 是纯增量 flag，不改变现有执行逻辑
- **无破坏性变更**：所有接口变更都是新增可选参数，现有调用方按旧方式调用仍可编译通过
- **回退简单**：如果 `--resume` 有问题，删除 `sessionId` 传递即可回退到冷启动模式
