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

## 5.1 任务认领 ✅ issue #1 修复

`WorkerWatcher.processMessage`（`packages/worker/src/watcher.ts`）收到 task_dispatch 消息后，在主任务执行前调用 `task_queue.claimById(task_id, instance_id)`，把 ZK 节点从 `/tasks/pending/task-0000000001` 原子搬到 `/tasks/claimed/tom-01-task-0000000001` (EPHEMERAL)。

claimById 实现（`packages/coordination/src/task-queue.ts`）：
1. `getData("/tasks/pending/task-0000000001")` — 读出 task 快照
2. `createEphemeral("/tasks/claimed/tom-01-task-0000000001", ClaimRecord)` — 原子接管；失败说明并发抢占 → 返回 null
3. `delete("/tasks/pending/task-0000000001")` — 移除 pending
4. 返回 status=claimed 的 Task 对象

**因此 ZK 状态**：
- 处理 plan 时：`/tasks/claimed/tom-01-task-0000000001` 出现（EPHEMERAL，Tom 断线自删）；`/tasks/pending/task-0000000001` 被删
- 主任务 + commit + 自评估 + 完成报告 完成后 5.8 段：`task_queue.complete(task_id, resultPath, instance_id, name, duration)` 把节点搬到 `/tasks/completed/task-0000000001` (PERSISTENT) 并删除 claimed 节点。
- `task_queue.claim(claimer, role)` 仍存在，主要被 TaskRecovery / CLI 使用，本工作流不走它。

⚠️ Edge case：若 task_id 对应的 pending 节点已不存在（重启重发、leader 自处理 decompose 后回退创建新 task 等），`claimById` 返回 null，Worker 仍继续处理（仅记一条 warn log），保证不阻塞消息处理。

## 5.2 选择模板

`packages/worker/src/watcher.ts:73-100` `processMessage()`：

```typescript
const link = (msg.link ?? null) as TaskLink | "decompose" | null;
//   "plan"
const taskId = (msg.task_id as TaskId | null) ?? asTaskId(`adhoc-${msg.id || ...}`);
//   "task-0000000001"
const resultPath = cachePaths.taskResultPath(this.opts.cache_paths, taskId);
//   ~/.claude-orchestrator/cache/leader-01/results/task-0000000001.md
//   ✅ issue #8 修复后，cachePaths 不再额外拼 "task-" 前缀（taskId 自带）。
const logPath = cachePaths.taskLogPath(this.opts.cache_paths, taskId, new Date().toISOString());
//   ~/.claude-orchestrator/cache/leader-01/logs/task-0000000001-2026-05-14T03:00:03.000Z.log

const tplName = LINK_TO_TEMPLATE[link];      // "worker-plan.md"
```

✅ **issue #8 修复**：`cachePaths.taskLogPath/taskResultPath/evalLogPath/commitLogPath` 不再额外拼 `task-` 前缀，因为 task_queue 生成的 id 本身就是 `task-NNNNNNNNNN`。修复前路径形如 `logs/task-0000000001-...log`，修复后回到 `logs/task-0000000001-...log`。锁定行为见 `packages/contracts/tests/core/unit/paths.test.ts`。

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
    CO_LOG_PATH:    "~/.../cache/leader-01/logs/task-0000000001-...log",
    CO_RESULT_PATH: "~/.../cache/leader-01/results/task-0000000001.md",
  },
});
```

`HookEngine`（`packages/runtime/src/hook-engine.ts`）按配置触发 shell 脚本，环境变量按上表注入。

## 5.4 模板渲染

`packages/worker/src/watcher.ts:88-99`：

```typescript
prompt = this.opts.template_engine.render(tplName /* worker-plan.md */, {
  name:             this.opts.worker_name,                           // "Tom"
  role:             this.opts.worker_role,                           // "planner"
  task_title:       msg.task_title ?? "",                            // "设计 /api/users 分页接口蓝图"
  task_description: msg.task_description ?? msg.content,             // ✅ #9 修复后 msg.task_description 携带 ChainDef.description
  task_criteria:    msg.task_criteria ?? "",                         // ✅ #9 修复后 msg.task_criteria 携带 ChainDef.criteria
  task_doc_path:    msg.task_doc_path ?? "",                         // ""（task_doc 生成仍未实现）
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

1. Write blueprint to **~/.claude-orchestrator/cache/leader-01/results/task-0000000001.md** (for Leader evaluation)
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
  > ~/.claude-orchestrator/cache/leader-01/logs/task-0000000001-<ts>.log
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
| `~/.claude-orchestrator/cache/leader-01/logs/task-0000000001-<ts>.log` | claude-cli stream-json | 完整流（system/init, assistant_message, tool_use 等） |
| `~/.claude-orchestrator/cache/leader-01/results/task-0000000001.md` | markdown | Tom 写入的 blueprint（即"Outputs #1"） |
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
   - log 路径：`~/.claude-orchestrator/cache/leader-01/commits/task-0000000001.log`
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
- `evalLogPath = cachePaths.evalLogPath(cache_paths, taskId, N)` → `~/.../cache/leader-01/evals/task-0000000001-attempt-{N}.log`
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

### 5.7.x ✅ issue #3 修复：模板字段名与 Schema 已对齐

原现状下 `templates/agents/worker-evaluate.md` 输出 `nextLink / suggestedWorker / feedback`（camelCase），与 `EvalDecisionSchema`（`packages/contracts/src/schemas/eval.ts`）期待的 `next_link / suggested_worker / feedback_to_worker`（snake_case）冲突，且模板缺 `reject` 选项；`safeParse` 几乎必失败，最终走 SelfEvaluator fallback 自动推进。

修复后模板：
- 字段命名统一为 snake_case：`next_link / suggested_worker / feedback_to_worker / feedback_target`；
- 决策枚举补齐 4 个：`activate_next / feedback / reject / close_chain`；
- 输出按 discriminated union 分四个分支列出，禁止跨分支污染字段；
- `worker-evaluate-format-hint.md` 同步更新，并显式列出禁用的旧字段名（`nextLink / feedback / suggestedWorker`）。

`EvalDecisionSchema` 不变（仍在 `packages/contracts/src/schemas/eval.ts:5-34`），现在 claude 严格按模板输出可直接通过 schema 校验，fallback 路径仅在 claude 偏离模板时启用。

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
  result_path: resultPath,                        // results/task-0000000001.md
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
  "result_path": "~/.claude-orchestrator/cache/leader-01/results/task-0000000001.md",
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

### 5.9.4 ✅ issue #4 修复：activate_next 复用初始 pending task

原现状下 `activate_next` 每次都新建任务，初始 5 个 pending 任务永远沉积；整链跑完后 `/tasks/pending` 会沉积 5+4=9 个。

修复后引入 `findOrCreatePendingTask(chain_id, link)`（`packages/leader/src/chain-router.ts`）：
- 先 `task_queue.listPending()` 扫描，找匹配 chain_id + link 的 pending 任务复用；
- 找到则直接 dispatch 该 task（task_id / description / criteria / task_doc_path 都从已存在的 task 取）；
- 找不到才回退到 `task_queue.push`（覆盖 decompose 跳过、recovery 后清空等场景）。

正常链路推进不再产生重复 task：贯穿样例中 build 阶段 dispatch 的是初始的 `task-0000000002`（非新建的 `task-0000000006`）。pending 任务在 #1 落地前依然不会被 claim / complete，但至少不再无限堆积。⚠️ 残留：task 完成时仍不会从 pending 移到 completed，这部分由 #1 解决。

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
| `~/.../cache/leader-01/logs/task-0000000001-<ts>.log` | claude-cli 主执行 |
| `~/.../cache/leader-01/results/task-0000000001.md` | blueprint.md（Leader 视角） |
| `~/.../cache/leader-01/commits/task-0000000001.log` | commit message claude 调用日志 |
| `~/.../cache/leader-01/evals/task-0000000001-attempt-{0,1,2}.log` | self-eval claude 调用日志（重试视情况） |
| `~/.../cache/leader-01/evals/task-0000000001-attempt-{N}.log.result.md` | self-eval JSON 输出 |

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
