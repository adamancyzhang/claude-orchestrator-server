# 02 — Step 6：Plan 链环节全状态（Tom 处理 task-0000000001）

> 入口状态：Tom 收件箱有 `msg-0000000001`（task_dispatch, link=plan, task_id=task-0000000001），`/tasks/pending/task-0000000001` 仍在（⚠️ Worker 不会去 claim 它）。
>
> 出口状态：Tom 已发完成报告给 Leader，Leader push 出新的 build task，并派发给 Jerry。

## 概览图（Plan 子流程 5.1–5.9）

```
WorkerWatcher (Tom) ← msg-0000000001
    │ 5.1 ⚠️ 不 claim ZK pending
    ▼
5.2 LINK_TO_TEMPLATE → "worker-plan.md"
    │
    ▼
5.3 HookEngine.fire("worker_message_start")
    │
    ▼
5.4 TemplateEngine.render → prompt
    │
    ▼
5.5 ClaudeRunner.run({prompt, system_prompt=identity, cwd=worktree})
    │  ├─ log: cache/leader-01/logs/task-0000000001-{ts}.log
    │  └─ result.md: cache/leader-01/results/task-0000000001.md
    │     ( + blueprint.md / CLAUDE.md 等 worktree 内文件 )
    ▼
5.6 CommitChecker.check (git status → commit message → git commit)
    │  └─ commit log: cache/leader-01/commits/task-0000000001.log
    ▼
5.7 SelfEvaluator.evaluate (worker-evaluate.md, fork_session, ≤3 次重试)
    │  └─ eval log: cache/leader-01/evals/task-0000000001-attempt-N.log
    ▼
5.8 HookEngine.fire("worker_message_end")
    sendCompletionReport → /messages/leader-01/msg-0000000002
    message_router.dismiss(/messages/tom-01/msg-0000000001)
    │
    ▼
5.9 Leader LeaderWatcher ← msg-0000000002
    ChainRouter.handleCompletionReport
      → activate_next → task_queue.push (build) → task-0000000006
      → findIdleWorkerByRole("builder") → Jerry
      → MessageRouter.send → /messages/jerry-01/msg-0000000001
```

## 5.1 任务认领（⚠️ 不走 task_queue.claim）

**现状**：`WorkerWatcher` 完全消息驱动。`packages/worker/src/watcher.ts:57-67` `start()` 只注册 `message_router.waitForMessage(instance_id, cb)`，cb 中调 `processMessage(msg)`。整个 worker 代码路径中没有任何 `task_queue.claim()` 调用。

**因此**：
- `/tasks/pending/task-0000000001` **依然在 ZK 中**，没有被移除
- `/tasks/claimed/` **依然为空**
- ZK 上看不到 "Tom 正在处理 plan 任务" 这件事，仅能从 `/messages/tom-01/msg-0000000001` 的存在推断

`task_queue.claim()` 的代码 (`packages/coordination/src/task-queue.ts:92-153`) 仍然存在，但是 dormant —— 可能未来由 leader recovery / 一致性扫描 / CLI 命令使用。本工作流路径下不调用。

### 5.1.x 假设走 claim 时的排序逻辑（仅参考）

若有人调用 `claim("tom-01", "planner")`：

`packages/coordination/src/task-queue.ts:92-124`：

1. `getChildren("/tasks/pending")` → `["task-0000000001", ..., "task-0000000005"]`，已按字典序排序
2. 对每个 task：
   - `weight = ROLE_WEIGHTS["planner"][link]` →
     - plan: 100, build: 10, verify: 10, review: 20, accept: 10
   - `assignedMatch = task.assigned_to === claimer ? 0 : 1` → 全部为 1（5 个 task 都没 assigned_to）
   - 排序 key: `[assignedMatch, -weight, priority, id]`
3. 排序后顺序：
   ```
   key=[1, -100, 1, task-0000000001]  ← plan，权重 100，最优
   key=[1, -20,  1, task-0000000004]  ← review，权重 20
   key=[1, -10,  1, task-0000000002]  ← build
   key=[1, -10,  1, task-0000000003]  ← verify
   key=[1, -10,  1, task-0000000005]  ← accept
   ```
4. 原子认领：`createEphemeral("/tasks/claimed/tom-01-task-0000000001", record)`；成功后 `delete("/tasks/pending/task-0000000001")`。
5. 若 createEphemeral 抛冲突（其他 worker 抢先） → continue 下一候选。

## 5.2 选择模板

`packages/worker/src/watcher.ts:73-100` `processMessage()`：

```typescript
const link = (msg.link ?? null) as TaskLink | "decompose" | null;
//   "plan"
const taskId = (msg.task_id as TaskId | null) ?? asTaskId(`adhoc-${msg.id || ...}`);
//   "task-0000000001"
const resultPath = cachePaths.taskResultPath(this.opts.cache_paths, taskId);
//   ~/.claude-orchestrator/cache/leader-01/results/task-task-0000000001.md
//   ⚠️ 注意 "task-task-" 双前缀，因为 task_id 本身以 "task-" 开头，而 cachePaths 又拼上 "task-"
//   见 packages/contracts/src/paths/cachePaths.ts:24-26
const logPath = cachePaths.taskLogPath(this.opts.cache_paths, taskId, new Date().toISOString());
//   ~/.claude-orchestrator/cache/leader-01/logs/task-task-0000000001-2026-05-14T03:00:03.000Z.log

const tplName = LINK_TO_TEMPLATE[link];      // "worker-plan.md"
```

⚠️ **双前缀路径**：cachePaths 假定 taskId 不含 "task-" 前缀，但 task_queue 生成的 id 是 `task-0000000001`，最终路径出现 `task-task-0000000001`。保留现状描述。

## 5.3 Hook: worker_message_start

`packages/worker/src/watcher.ts:102-113`：

```typescript
await this.opts.hooks.fire({
  type: "worker_message_start",
  env: {
    CO_WORKER_NAME: "Tom",
    CO_WORKER_ID:   "tom-01",
    CO_TASK_ID:     "task-0000000001",
    CO_LINK:        "plan",
    CO_CHAIN_ID:    "chain-pagination-001",
    CO_LOG_PATH:    "~/.../cache/leader-01/logs/task-task-0000000001-...log",
    CO_RESULT_PATH: "~/.../cache/leader-01/results/task-task-0000000001.md",
  },
});
```

`HookEngine`（`packages/runtime/src/hook-engine.ts`）按配置触发 shell 脚本，环境变量按上表注入。

## 5.4 模板渲染

`packages/worker/src/watcher.ts:88-99`：

```typescript
prompt = this.opts.template_engine.render(tplName /* worker-plan.md */, {
  task_title:       msg.task_title ?? "",                            // "设计 /api/users 分页接口蓝图"
  task_description: msg.task_description ?? msg.content,             // ⚠️ msg.task_description=null → fallback msg.content = title
  task_criteria:    msg.task_criteria ?? "",                         // ""
  task_doc_path:    msg.task_doc_path ?? "",                         // ""
  result_path:      resultPath,                                      // 见 5.2
  work_dir:         this.opts.worktree_path,                         // "~/work/co-pagination/.worktrees/Tom"
  time:             new Date().toISOString(),
  content:          msg.content,                                     // "设计 /api/users 分页接口蓝图"
});
```

**渲染后 prompt 全文**（template 见 `templates/agents/worker-plan.md`）：

```markdown
Your link in the responsibility chain is **Plan** — define the blueprint that Build, Verify, Review, and Accept will follow.

## Step 0: Restore Directory Memory

Read `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` to restore session context (create the directory and seed it if new). Read your personal CLAUDE.md at `.claude-orchestrator/docs/{{name}}/CLAUDE.md`.

## Task

- **Title**: 设计 /api/users 分页接口蓝图
- **Description**: 设计 /api/users 分页接口蓝图
- **Criteria**:
- **Spec**:

## Process

Use the **task-planning** skill (read `.claude/skills/task-planning/SKILL.md`). Use **task-traceability** (`.claude/skills/task-traceability/SKILL.md`) as the foundational layer. Follow Trace → Execute → Map → Evidence → Record.

## Outputs

1. Write blueprint to **~/.claude-orchestrator/cache/leader-01/results/task-task-0000000001.md** (for Leader evaluation)
2. Write identical copy to **.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/blueprint.md** (for downstream Workers)

Blueprint must be self-contained with architecture, interfaces, data flow, and concrete build steps with verifiable criteria.

## Completion Report

```
Link: plan
Status: completed
Blueprint Summary: <one paragraph>
Build Steps: <count> steps listed
Self-Check: all passed | <items needing attention>
Blueprint Path: .claude-orchestrator/docs/{{name}}/YYYY-MM-DD/blueprint.md
```

Update `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` with completion status.
```

⚠️ 注意 **Description 退化为 title** 与 **Criteria/Spec 为空**（见 `01-tui-input-and-decompose.md` §5.5 解释）。Tom 实际看到的 Plan task 信息密度比 ChainDef 中定义的薄得多。

✅ **issue #2 修复**：`{{name}}` / `{{role}}` 现在会被替换。Tom 的 prompt 里 "Read `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md`" 实际渲染为 "Read `.claude-orchestrator/docs/Tom/YYYY-MM-DD/CLAUDE.md`"，下游 evaluator 同此。

## 5.5 主任务执行 claude-cli

`packages/worker/src/watcher.ts:115-121`：

```typescript
const result = await this.opts.runner.run({
  prompt,
  log_path: logPath,
  system_prompt: this.opts.identity_system_prompt,    // ← Tom 的 identity_system_prompt
  cwd: this.opts.worktree_path,                        // "~/work/co-pagination/.worktrees/Tom"
  quiet: true,
});
```

`ClaudeRunner.run()` 经 `execWithStreaming` 调起：

```bash
cd ~/work/co-pagination/.worktrees/Tom
claude --append-system-prompt '<Tom identity card>' \
       -p '<rendered worker-plan.md>' \
       --output-format stream-json --verbose \
  > ~/.claude-orchestrator/cache/leader-01/logs/task-task-0000000001-<ts>.log
```

**session_id 抽取规则**：`execWithStreaming` 解析 stream-json 第一行 `system/init` 事件的 `session_id` 字段，回传给 `ClaudeRunner.run()` 作为 `result.session_id`，供后续 `--resume` 使用。

**返回值** `RunResult`：

```typescript
{
  exit_code: 0,
  session_id: "sess-tom-plan-001",       // 形如 UUID，由 claude-cli 生成
  log_path: "<the log path>",
}
```

### 5.5.x 生成文件

| 路径 | 类型 | 内容 |
|------|------|------|
| `~/.claude-orchestrator/cache/leader-01/logs/task-task-0000000001-<ts>.log` | claude-cli stream-json | 完整流（system/init, assistant_message, tool_use 等） |
| `~/.claude-orchestrator/cache/leader-01/results/task-task-0000000001.md` | markdown | Tom 写入的 blueprint（即"Outputs #1"） |
| `~/work/co-pagination/.worktrees/Tom/.claude-orchestrator/docs/Tom/2026-05-14/blueprint.md` | markdown | 同上 blueprint 的副本（Tom 自行替换 `{{name}}` 为自己的名字） |
| `~/work/co-pagination/.worktrees/Tom/.claude-orchestrator/docs/Tom/2026-05-14/CLAUDE.md` | markdown | 每日 directory memory，记录完成状态 |

**blueprint.md 内容（示意）**：

```markdown
# /api/users 分页接口蓝图

## 接口签名
GET /api/users?page=<int>&page_size=<int>

## 入参合法性
- page: integer, default 1, must >= 1
- page_size: integer, default 20, must in [1, 100]
- 不合法时返回 400 with {"error": {"code": "...", "msg": "..."}}

## 响应 JSON Schema
{ "page": int, "page_size": int, "total": int, "items": [User, ...] }

## DB 层
SELECT * FROM users ORDER BY id LIMIT :page_size OFFSET (:page - 1) * :page_size;
SELECT count(*) FROM users;

## 兼容性
- 不带 page 参数时等价于 page=1&page_size=20 → 不破坏现有客户端

## 测试用例
1. GET /api/users?page=2&page_size=5 → 200, items.length<=5, total int
2. GET /api/users?page=0 → 400
3. GET /api/users?page_size=200 → 400
4. GET /api/users → 默认 page=1/page_size=20
5. GET /api/users?page=999999 → 200, items=[]
```

## 5.6 自动 commit（CommitChecker）

`packages/worker/src/watcher.ts:137-148`：

```typescript
let commit: CommitResult | null = null;
if (link && CHAIN_LINKS.includes(link as TaskLink)) {
  commit = await this.opts.commit_checker.check(
    {
      link: "plan",
      task_id: "task-0000000001",
      task_title: msg.task_title ?? link,
      task_description: msg.task_description ?? msg.content,
    },
    result.session_id ?? undefined,    // "sess-tom-plan-001"
  );
}
```

`packages/worker/src/commit-checker.ts:39-79` `check()` 流程：

1. `git status --porcelain` （cwd=worktree_path）
   - 假设输出：
     ```
      M .claude-orchestrator/docs/Tom/2026-05-14/CLAUDE.md
     ?? .claude-orchestrator/docs/Tom/2026-05-14/blueprint.md
     ```
2. `parseStatus()` → `changed=[" M .claude-orchestrator/docs/Tom/2026-05-14/CLAUDE.md"]`, `untracked=[".claude-orchestrator/docs/Tom/2026-05-14/blueprint.md"]`
3. `generateMessage()`：
   - 模板：`templates/agents/worker-commit-message.md`
   - vars: `changed_files / untracked_files / task_title / link`
   - 调 `ClaudeRunner.run({prompt, log_path: commitLogPath, resume_session_id: "sess-tom-plan-001", quiet: true})`
   - log 路径：`~/.claude-orchestrator/cache/leader-01/commits/task-task-0000000001.log`
   - 读 log 首行截 72 字符 → 假设 `feat(plan): blueprint for /api/users pagination`
4. `git add -A` + `git commit -m "feat(plan): blueprint for /api/users pagination"`
5. `git rev-parse HEAD` → `7c4f3a2b...`
6. 返回 `CommitResult`：

```json
{
  "sha": "7c4f3a2b9d1e5f6a8b4c3d2e1f0987654321abcd",
  "message": "feat(plan): blueprint for /api/users pagination",
  "changed_files": ["M .claude-orchestrator/docs/Tom/2026-05-14/CLAUDE.md"],
  "untracked_files": [".claude-orchestrator/docs/Tom/2026-05-14/blueprint.md"]
}
```

⚠️ 错误处理（`packages/worker/src/commit-checker.ts:60-65`）：`git commit` 失败 → 返回 null。`git status` 失败由 execSync 抛异常（未在外层 catch，**会冒泡到 processMessage 终止整个流程**）。生成 commit message 失败 → fallback `chore: auto-commit from Tom`。

## 5.7 自评估（SelfEvaluator）

`packages/worker/src/watcher.ts:150-158`：

```typescript
if (link && CHAIN_LINKS.includes(link as TaskLink)) {
  await this.sendCompletionReport(link as TaskLink, msg, resultPath, taskId, commit, result.session_id ?? undefined);
}
```

`packages/worker/src/watcher.ts:169-189` `sendCompletionReport()` 第一步是评估：

```typescript
const evalContent = await this.opts.evaluator.evaluate({
  link: "plan",
  task_id: "task-0000000001",
  task_result_path: resultPath,
  msg_vars: {
    task_title:       "设计 /api/users 分页接口蓝图",
    task_description: "",                    // ⚠️ msg.task_description=null
    task_criteria:    "",
    task_doc_path:    "",
    content:          "设计 /api/users 分页接口蓝图",
  },
  resume_session_id: "sess-tom-plan-001",
});
```

`packages/worker/src/evaluator.ts:54-124` `evaluate()` 流程，循环 ≤ MAX_RETRIES=3 次：

每次 attempt N：
- `evalLogPath = cachePaths.evalLogPath(cache_paths, taskId, N)` → `~/.../cache/leader-01/evals/task-task-0000000001-attempt-{N}.log`
- `evalResultPath = evalLogPath + ".result.md"`
- prompt = `template_engine.render("worker-evaluate.md", { ...baseVars, result_path: evalResultPath })`
  - baseVars: `link=plan, task_result_path=results/...md, work_dir=worktree, time=...` + msg_vars
- attempt > 0 时追加 `worker-evaluate-format-hint.md` 内容
- `runner.run({prompt, log_path: evalLogPath, system_prompt: identity, resume_session_id, fork_session: true, quiet: true})`
  - ⚠️ `fork_session=true` → 每次重试从主任务 session 分叉出干净分支，避免错误锚定
- 读 `evalResultPath`，过 `extractJson` + `EvalDecisionSchema.safeParse`
- 成功 → return JSON.stringify(parsed.data)
- 失败 → 进入下一次重试

3 次全失败 → `packages/worker/src/evaluator.ts:111-123` fallback：
```typescript
const next = NEXT_LINKS[input.link];           // "build"
if (next) return JSON.stringify({
  decision: "activate_next",
  reason: `auto-advance from plan after 3 eval failures`,
  next_link: "build",
});
```

### 5.7.x ⚠️ 现状：模板字段名与 Schema 不一致

`templates/agents/worker-evaluate.md` 要求 claude 输出：

```json
{
  "decision": "activate_next" | "feedback" | "close_chain",
  "reason": "...",
  "feedback": "...",
  "nextLink": "build",
  "suggestedWorker": null
}
```

但 `EvalDecisionSchema`（`packages/contracts/src/schemas/eval.ts`）要求：

```
activate_next: {decision, reason, next_link, suggested_worker?}
feedback:      {decision, reason, feedback_to_worker, feedback_target?}
reject:        {decision, reason}
close_chain:   {decision, reason}
```

字段差异：
| 模板字段 | Schema 字段 |
|---------|------------|
| `nextLink` | `next_link` |
| `suggestedWorker` | `suggested_worker` |
| `feedback` | `feedback_to_worker` |
| `reject` | （模板没有该选项） |

即使 claude 严格按模板输出，`safeParse` 也会失败 → 走重试 → 最终 fallback 到 `activate_next + next_link`。模板上的 `nextLink` 文本实际上**永远不会被 schema 接受**——但 fallback 路径**总能产生正确字段**的 `next_link`。这是一个真实的"靠重试兜底"的现状⚠️。

### 5.7.x EvalDecision 最终内容（取自 fallback 或 schema 命中）

假设 claude 输出最终命中 schema（或走 fallback）：

```json
{
  "decision": "activate_next",
  "reason": "blueprint complete, all 5 criteria addressed",
  "next_link": "build"
}
```

返回给 `sendCompletionReport` 的 `evalContent` 是 `JSON.stringify(...)` 字符串。

## 5.8 完成报告

`packages/worker/src/watcher.ts:191-222`：

```typescript
let body = evalContent;
if (commit) {
  try {
    const json = JSON.parse(evalContent);
    json.commit = {
      sha: commit.sha,
      message: commit.message,
      branch: this.opts.worktree_branch,          // "co/tom-01"
      changed_files: commit.changed_files,
      untracked_files: commit.untracked_files,
    };
    body = JSON.stringify(json);
  } catch {
    body = evalContent + `\nCommit: ${commit.sha.slice(0, 7)} - ${commit.message}`;
  }
}

await this.opts.message_router.send({
  type: "completion_report",
  from_instance: "tom-01",
  from_name: "Tom",
  from_role: "planner",
  to_instance: "leader-01",
  content: body,                                  // JSON 字符串（含 commit 信息）
  link: "plan",
  task_id: "task-0000000001",
  chain_id: "chain-pagination-001",
  result_path: resultPath,                        // results/task-task-0000000001.md
});
```

### 5.8.1 完成报告消息体

**ZK 路径**：`/claude-orchestrator/messages/leader-01/msg-0000000002`
**完整 Message JSON**：

```json
{
  "id": "msg-0000000002",
  "type": "completion_report",
  "from_instance": "tom-01",
  "from_name": "Tom",
  "from_role": "planner",
  "to_instance": "leader-01",
  "to_name": null,
  "content": "{\"decision\":\"activate_next\",\"reason\":\"blueprint complete, all 5 criteria addressed\",\"next_link\":\"build\",\"commit\":{\"sha\":\"7c4f3a2b9d1e5f6a8b4c3d2e1f0987654321abcd\",\"message\":\"feat(plan): blueprint for /api/users pagination\",\"branch\":\"co/tom-01\",\"changed_files\":[\"M .claude-orchestrator/docs/Tom/2026-05-14/CLAUDE.md\"],\"untracked_files\":[\".claude-orchestrator/docs/Tom/2026-05-14/blueprint.md\"]}}",
  "link": "plan",
  "task_id": "task-0000000001",
  "chain_id": "chain-pagination-001",
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "task_doc_path": null,
  "result_path": "~/.claude-orchestrator/cache/leader-01/results/task-task-0000000001.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:01:30.000Z"
}
```

### 5.8.2 Hook: worker_message_end

`packages/worker/src/watcher.ts:123-135`：

```typescript
await this.opts.hooks.fire({
  type: "worker_message_end",
  env: { /* same as start */, exit_code: result.exit_code /* 0 */ },
});
```

⚠️ **顺序**：现状代码中 hook end 触发**在** commit 和 evaluate **之前**（watcher.ts:123 早于 137 / 150）。文档结构里写在"5.8 完成报告 / 收尾"位置只是为了语义分组，实际时序是：runner.run → hook_end → commit_check → sendCompletionReport（含 evaluate）。

### 5.8.3 dismiss 自己的消息

`packages/worker/src/watcher.ts:163` `await this.opts.message_router.dismiss(this.opts.instance_id, msg.id)`：

- `packages/coordination/src/message-router.ts:130-134` `delete("/claude-orchestrator/messages/tom-01/msg-0000000001")`
- ZK 删除节点

## 5.9 Leader 处理完成报告 → 激活 Build

### 5.9.1 LeaderWatcher 捕获

`/messages/leader-01/` 子节点变更 → `waitForMessage` → `poll` → `LeaderWatcher.processMessage(msg-0000000002)` → `chain_router.route(msg)`。

### 5.9.2 ChainRouter 路由

`packages/leader/src/chain-router.ts:58-72`：
- `msg.link === "plan"` 且 `msg.type === "completion_report"` → 命中 line 63 分支 → `handleCompletionReport(msg)`

### 5.9.3 handleCompletionReport

`packages/leader/src/chain-router.ts:180-240`：

```typescript
const parsed = EvalDecisionSchema.safeParse(JSON.parse(extractJson(msg.content)));
```

注意：⚠️ 这里 `msg.content` 是 JSON 字符串（含 commit 字段），`extractJson` 会找首个 `{...}` 块——含 commit 的外层 JSON。`EvalDecisionSchema` 是 discriminated union，不允许额外字段除非 schema 显式声明。**实测 zod default 是 strip** mode（不抛错），所以 commit 字段会被忽略，只解析出 decision/reason/next_link。

```typescript
const decision: EvalDecision = parsed.data;
//   { decision: "activate_next", reason: "...", next_link: "build" }

switch (decision.decision) {
  case "activate_next": {
    if (!msg.chain_id) break;                                 // 通过
    const nextLink = decision.next_link;                       // "build"
    const newTask = await this.opts.task_queue.push({
      title: `[${msg.chain_id}] ${nextLink}`,                  // "[chain-pagination-001] build"
      link: nextLink,
      chain_id: msg.chain_id,
      priority: 1,
      created_by: this.opts.leader_id,
      created_by_name: this.opts.leader_name,
    });
    //   ⚠️ 注意：这是一个**新**的 task，task-0000000006，与原 task-0000000002（之前 push 的 build）并存
    const worker = await this.findIdleWorkerByRole(LINK_TO_ROLE[nextLink]);
    //   "builder" → Jerry
    if (worker) {
      await this.opts.message_router.send({
        type: "task_dispatch",
        from_instance: leader_id, from_name: "Leader", from_role: "leader",
        to_instance: worker.id,                                // "jerry-01"
        content: newTask.title,                                // "[chain-pagination-001] build"
        link: nextLink,
        chain_id: msg.chain_id,
        task_id: newTask.id,                                   // "task-0000000006"
        task_title: newTask.title,
      });
    }
    break;
  }
  // ... 其余 case 见 04-/05-/06- 文档
}
```

### 5.9.4 ⚠️ 任务沉积现象

注意：task-0000000001 (原 plan task) 至今**还在 `/tasks/pending`**！因为：
- Worker 没 claim 它
- handleCompletionReport 中 **没有调用 `task_queue.complete(task-0000000001)`**

所以这个原 plan task 永远沉积在 pending 中。task-0000000002 (原 build task) 同理。仅有新 push 的 task-0000000006 (新 build task) 被 jerry-01 通过 task_dispatch 消息处理。

整条链跑完后，pending 中会有 5（初始） + 4（每个 link 完成时新 push） = 9 个任务沉积，且全部 status=pending、claimed_by=null。⚠️ 这是一个真实的现状问题，可能影响 TUI 显示与重启恢复。

### 5.9.5 新 task 完整 JSON

```json
{
  "id": "task-0000000006",
  "title": "[chain-pagination-001] build",
  "description": "",
  "priority": 1,
  "status": "pending",
  "link": "build",
  "chain_id": "chain-pagination-001",
  "task_doc_path": null,
  "result_path": null,
  "retry_count": 0,
  "depends_on": [],
  "blocked_by": [],
  "blocked_reason": null,
  "fail_reason": null,
  "created_by": "leader-01",
  "created_by_name": "Leader",
  "assigned_to": null,
  "assigned_to_name": null,
  "claimed_by": null,
  "completed_by_name": null,
  "created_at": "2026-05-14T03:01:31.000Z",
  "claimed_at": null,
  "completed_at": null,
  "duration_seconds": null,
  "leader_only": false,
  "result": null
}
```

### 5.9.6 派发给 Jerry 的 task_dispatch 消息

**ZK 路径**：`/claude-orchestrator/messages/jerry-01/msg-0000000001`

```json
{
  "id": "msg-0000000001",
  "type": "task_dispatch",
  "from_instance": "leader-01",
  "from_name": "Leader",
  "from_role": "leader",
  "to_instance": "jerry-01",
  "to_name": null,
  "content": "[chain-pagination-001] build",
  "link": "build",
  "task_id": "task-0000000006",
  "chain_id": "chain-pagination-001",
  "task_title": "[chain-pagination-001] build",
  "task_description": null,
  "task_criteria": null,
  "task_doc_path": null,
  "result_path": null,
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:01:32.000Z"
}
```

⚠️ Jerry 收到的 task description 只有 `[chain-pagination-001] build`，完全丢失了原 ChainDef 中"按 Plan 实现 controller / service / repository 三层修改..."的细节。Jerry 实际可拿到的 Plan 信息**全靠 Tom 在 worktree 中写下的 `blueprint.md`**——但 Tom 和 Jerry **在不同的 worktree**（不同分支），Jerry 的 worktree 不会自动看到 Tom 的 blueprint，除非：

1. 跨 worktree 读：`worker-build.md` 中说 "Read `.claude-orchestrator/docs/{planner_name}/YYYY-MM-DD/blueprint.md`" —— 但路径写法是相对 `cwd=Jerry 的 worktree`，所以 `.claude-orchestrator/docs/Tom/...` 在 Jerry 的 worktree 中**不存在**（除非主项目根目录共享）
2. Jerry 的 worktree 通过 git 取得 Tom 已 commit 的 blueprint —— 但 Tom commit 在 `co/tom-01` 分支，Jerry 在 `co/jerry-01` 分支，需要 git merge / cherry-pick / pull，**当前实现没有自动 sync**

这是另一处现状⚠️——Plan → Build 之间的 artifact 传递依赖 worktree/分支结构与 Tom/Jerry 自行读取主项目根目录，存在断链风险。

## Plan 环节产物清单

### ZK 新增节点

| 路径 | 类型 | 备注 |
|------|------|------|
| `/messages/leader-01/msg-0000000002` | PERSISTENT_SEQUENTIAL | Tom 的 completion_report |
| `/tasks/pending/task-0000000006` | PERSISTENT_SEQUENTIAL | Leader 新 push 的 build task ⚠️ |
| `/messages/jerry-01/msg-0000000001` | PERSISTENT_SEQUENTIAL | Leader 发给 Jerry 的 task_dispatch |

### ZK 修改节点

| 路径 | 修改 |
|------|------|
| `/messages/tom-01/msg-0000000001` | **删除**（Worker dismiss） |
| `/messages/leader-01/msg-0000000002` | `read=false` → `read=true`（LeaderWatcher poll） |

### Cache 文件

| 路径 | 来源 |
|------|------|
| `~/.../cache/leader-01/logs/task-task-0000000001-<ts>.log` | claude-cli 主执行 |
| `~/.../cache/leader-01/results/task-task-0000000001.md` | blueprint.md（Leader 视角） |
| `~/.../cache/leader-01/commits/task-task-0000000001.log` | commit message claude 调用日志 |
| `~/.../cache/leader-01/evals/task-task-0000000001-attempt-{0,1,2}.log` | self-eval claude 调用日志（重试视情况） |
| `~/.../cache/leader-01/evals/task-task-0000000001-attempt-{N}.log.result.md` | self-eval JSON 输出 |

### Worktree 内文件（Tom 的分支）

| 路径 | 内容 |
|------|------|
| `~/work/co-pagination/.worktrees/Tom/.claude-orchestrator/docs/Tom/2026-05-14/blueprint.md` | 蓝图副本 |
| `~/work/co-pagination/.worktrees/Tom/.claude-orchestrator/docs/Tom/2026-05-14/CLAUDE.md` | 当日记忆 |

### Git commit

| 分支 | SHA | message |
|------|-----|---------|
| `co/tom-01` | `7c4f3a2b...` | `feat(plan): blueprint for /api/users pagination` |

### Leader 事件总线

```
[03:00:03]  message_received  from=tom-01 msg=msg-0000000002
[03:01:31]  chain_activated?  ⚠️ 不发：activate_next 走 task_queue.push，但 chain_router 不 emit 后续事件
[03:01:32]  message_processed msg=msg-0000000002
```

⚠️ ChainRouter 在 `activate_next` / `feedback` / `reject` / `close_chain` 中**只在 reject/close_chain 时 emit `chain_closed`**。Plan→Build 推进时没有 `task_dispatched` 或 `link_advanced` 一类事件。详见 `packages/leader/src/chain-router.ts:189-239`。TUI 仅靠 `message_received/processed` 与 ZK watch 重渲染感知进度。

## 衔接到 Step 7

Jerry 的 `WorkerWatcher` 触发，开始处理 `msg-0000000001`。流程基本同 Plan，差异点在 [`03-build-link.md`](./03-build-link.md) 展开。
