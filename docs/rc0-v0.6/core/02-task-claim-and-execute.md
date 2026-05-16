# Core Chain 2 — 任务认领 → 模板渲染 → 执行 → 自评估

> **链路定位**：Worker 从 ZK 消息到达、认领任务、渲染模板、调用 claude-cli 执行、自动 commit、自评估、到发送完成报告的全过程。这是 Worker 子进程的核心工作流。

## 1. 链路总览

```
/messages/{worker_id}/msg-{seq}    ← ChildWatch 触发
    │
    ▼
WorkerWatcher.processMessage(msgId)
    │
    ├─ Step 1: 解析 Message → 提取 link
    ├─ Step 2: 选择模板 worker-{link}.md
    ├─ Step 3: Hook worker_message_start
    ├─ Step 4: TemplateEngine.render() → prompt
    ├─ Step 5: ClaudeRunner.run() → {code, sessionId}
    ├─ Step 6: CommitChecker.check() → commit or null
    ├─ Step 7: SelfEvaluator.evaluate() → EvalDecision
    └─ Step 8: sendCompletionReport() → Leader
```

## 2. Step 1 — 解析消息

```typescript
async processMessage(msgId: string): Promise<void> {
  const msg = MessageSchema.parse(await zk.getMessage(instanceId, msgId));
  if (msg.read || this.inFlight.has(msgId)) return;
  this.inFlight.add(msgId);

  const link = msg.link || "_generic";
  // _generic = 无模板的直接 Claude 调用
```

## 3. Step 2 — 选择模板

```typescript
const template = this.templateEngine.get(`worker-${link}.md`);
if (!template && link !== "_generic") {
  throw new TemplateNotFoundError("TEMPLATE_NOT_FOUND", `worker-${link}.md not found`);
}
```

`link` 与模板对应：

| link | 模板 | 说明 |
|------|------|------|
| `plan` | `worker-plan.md` | 设计蓝图 |
| `build` | `worker-build.md` | 按蓝图实现 |
| `verify` | `worker-verify.md` | 验证实现 |
| `review` | `worker-review.md` | 审查产出 |
| `accept` | `worker-accept.md` | 验收交付 |
| `decompose` | `worker-decompose.md` | 需求拆解（Planner 专用） |
| `_generic` | — | 无模板直接执行 |

## 4. Step 3 — Hook worker_message_start

```typescript
await this.hooks.fire("worker_message_start", {
  CO_EVENT: "worker_message_start",
  CO_WORKER_NAME: this.instance.name,
  CO_WORKER_ROLE: this.instance.role,
  CO_TASK_ID: msg.task_id ?? "",
  CO_MESSAGE_ID: msgId,
  CO_LINK: link,
});
```

## 5. Step 4 — 渲染模板

```typescript
const uniqueKey = `task-${msg.task_id || msgId}-${Date.now().toString(36)}`;
const logPath = path.join(cacheDir, leaderInstanceId, `${uniqueKey}.log`);
const resultPath = path.join(cacheDir, leaderInstanceId, `${uniqueKey}-result.md`);

const vars = {
  task_title: msg.task_title ?? "",
  task_description: msg.task_description ?? msg.content,
  task_criteria: msg.task_criteria ?? "",
  task_doc_path: msg.task_doc_path ?? "",
  result_path: resultPath,
  work_dir: this.worktreePath,
  time: new Date().toISOString(),
  content: msg.content,
};

const prompt = this.templateEngine.render(template, vars);
```

身份信息不通过模板变量传递，由 `ClaudeRunner.buildIdentityPrompt()` 单独生成 system prompt。

## 6. Step 5 — 主任务执行

```typescript
const { code, sessionId } = await this.runner.run(prompt, logPath, {
  systemPrompt: this.runner.buildIdentityPrompt(),
});
```

`sessionId` 来自 claude-cli stream-json 输出的第一行 `system/init` 事件。后续步骤通过 `--resume <sessionId>` 共享上下文。

## 7. Step 6 — 自动提交

```typescript
let commitResult: CommitResult | null = null;
if (link !== "_generic") {
  commitResult = await this.commitChecker.check(
    { link, taskTitle: msg.task_title ?? "", taskDescription: msg.task_description ?? "" },
    sessionId,
  );
}
```

CommitChecker 流程：

```
check(taskContext, mainSessionId):
  1. git status --porcelain
  2. 若无变更 → 返回 null
  3. runner.run("worker-commit-message.md", logPath, {resumeSessionId})
  4. 解析 commit message（截断 72 字符）
  5. git add -A
  6. git commit -m "..."
  7. return {sha, message, changedFiles, untrackedFiles}
```

错误处理：

| 场景 | 处理 |
|------|------|
| git status 失败 | 返回 null |
| claude-cli 生成失败 | 回退 `"chore: auto-commit from {Name}"` |
| git commit 失败 | 返回 null |

## 8. Step 7 — 自评估

```typescript
const reportContent = await this.evaluator.evaluate(
  link, vars, resultPath, uniqueKey, sessionId,
);
```

SelfEvaluator 流程：

```
evaluate(link, vars, resultPath, uniqueKey, mainSessionId):
  for (attempt = 0; attempt < 3; attempt++):
    prompt = templateEngine.render("worker-evaluate.md", {link, ...vars})
    runner.run(prompt, evalLogPath, {
      systemPrompt: buildIdentityPrompt(),
      resumeSessionId: mainSessionId,
      forkSession: true,  // 每次都 fork 干净分支
    })
    解析输出 → EvalDecision JSON
    若解析成功 → return JSON.stringify(decision)
    若格式错误 → 追加 worker-evaluate-format-hint.md 重试

  3 次仍失败 → 返回 feedback 默认决策
```

EvalDecision JSON：

```json
{
  "decision": "activate_next",
  "reason": "blueprint complete, all criteria met",
  "next_link": "build",
  "suggested_worker": null
}
```

`--fork-session` 确保每次重试从干净分支开始，消除先前格式错误输出的锚定效应。

## 9. Step 8 — 发送完成报告

```typescript
await this.hooks.fire("worker_message_end", { ... });

await this.sendCompletionReport(link, msg, resultPath, uniqueKey, commitResult, reportContent);

await this.zk.markMessageRead(this.instance.id, msgId);
this.inFlight.delete(msgId);
```

完成报告消息：

```json
{
  "type": "completion_report",
  "from_instance": "Tom_instance_id",
  "from_name": "Tom",
  "from_role": "planner",
  "to_instance": "leader_instance_id",
  "link": "plan",
  "task_id": "task-0000000001",
  "content": "<EvalDecision JSON, 含 commit 字段>",
  "result_path": "task-001-result.md"
}
```

## 10. 完整调用链

```
WorkerWatcher.processMessage(msg)
  ├─ MessageSchema.parse()
  ├─ TemplateEngine.get(`worker-${link}.md`)
  ├─ HookEngine.fire("worker_message_start", CO_* env)
  ├─ TemplateEngine.render(template, vars)
  ├─ ClaudeRunner.run(prompt, logPath, {systemPrompt})
  │     └─ execWithStreaming:
  │         spawn(claude --append-system-prompt '...' -p '...')
  │         → tee → logPath
  │         → 提取 session_id
  │         → return {code, sessionId}
  ├─ CommitChecker.check(taskContext, sessionId)
  │     ├─ git status
  │     ├─ ClaudeRunner.run(commit prompt, logPath, {resumeSessionId})
  │     └─ git commit
  ├─ SelfEvaluator.evaluate(link, vars, resultPath, key, sessionId)
  │     └─ ClaudeRunner.run(eval prompt, logPath, {
  │         systemPrompt, resumeSessionId, forkSession: true
  │       })
  ├─ HookEngine.fire("worker_message_end")
  └─ sendCompletionReport()
        └─ zk.createMessage(leader_id, completionReport)
```

## 11. 链路产出

| 产出 | 位置 | 说明 |
|------|------|------|
| 任务日志 | `cache_dir/{leader_id}/tasks/<task_id>/exec-<ts>.log` | stream-json 完整流 |
| 任务结果 | `cache_dir/{leader_id}/tasks/<task_id>/result.md` | Worker 按 link 产出（chain 共享） |
| Worker 自留副本 | `cache_dir/{leader_id}/docs/<worker>/<date>/<prefix>-<chain_id>.md` | 同任务的备份 |
| Git commit | worktree 分支 | 代码变更自动提交（commit-checker） |
| 评估日志 | `cache_dir/{leader_id}/tasks/<task_id>/eval-<N>.log` | 自评估日志（最多 3 次） |
| 完成报告 | `/messages/{leader_id}/msg-{seq}` | EvalDecision + commit info |

## 12. commit-failure 分支（RC0 新增）

`CommitChecker.check` 区分两种"无 commit 产出"路径：

| 场景 | 行为 |
|------|------|
| `git status --porcelain` 干净 | `check()` 返回 `null`（合法短路，无副作用），Worker 走 self-evaluator + 正常 completion_report |
| `git add -A` 或 `git commit -m <message>` 抛非零退出 | `check()` 抛 `CommitFailedError(message, stderr)`，Worker 跳过 self-evaluator |

第二种路径下，`WorkerWatcher.processTask` 捕获 `CommitFailedError` 后：

1. 跳过 `recordCommit`（不让该 link 的 commit 进 chainCommits）
2. 跳过 `memory_refresh` 发送（无变更可刷新）
3. 调 `sendForcedFeedbackReport(...)`：直接构造一份 `feedback` EvalDecision，feedback_target = 当前 instance_id，feedback_to_worker 文本指引该 worker 用 `git status / git diff` 诊断
4. 该 completion_report 走 Leader 标准 feedback 分支 → push 一条 retry task 给同一 worker
5. retry 同样计入 chain 反馈上限（`CO_CHAIN_MAX_RETRIES`，默认 9）

效果：commit 失败不再静默推进、不再让 MergeValidator 漏 commit，链路在 retry 上限内有自愈机会。

历史背景：v0.6 早期 `CommitChecker.check` 在 `git commit` 失败时 `return null`，与"无变更"路径不可区分，watcher 仍走 self-evaluator → 通常输出 `activate_next` → 链推进到下一 link → close_chain 时该 link 的 commit 不在 `chainCommits`，MergeValidator 跳过 → 主线缺该 link 代码。详见 RC0 修复 R-01。
