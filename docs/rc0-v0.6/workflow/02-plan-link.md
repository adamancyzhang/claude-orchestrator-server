# 02 — Step 6：Plan 链环节全状态（Tom 处理 task-0000000001）

> 入口状态：Tom 收件箱有 `msg-0000000001`（task_dispatch, link=plan, task_id=task-0000000001, assigned_to=tom-01），`/tasks/pending/task-0000000001` 仍在但已经被 leader 在 §5.4 push 时标记 `assigned_to=tom-01`。
>
> 出口状态：Tom 已发完成报告给 Leader，Leader 复用初始的 `task-0000000002`（build link），更新 manifest.link_workers，并派发给 Jerry。

## 概览图（Plan 子流程 5.1–5.9）

```
WorkerWatcher (Tom) ← msg-0000000001
    │ 5.1 registry.heartbeat(busy)
    │     task_queue.claimById → /tasks/claimed/tom-01-task-0000000001
    │     hooks.fire("task_claimed")
    ▼
5.2 LINK_TO_TASK_TEMPLATE → "worker-planner-task.md"
    │   (system prompt = identity + personal-claude-planner.md + worker-planner.md)
    ▼
5.3 HookEngine.fire("worker_message_start")
    │
    ▼
5.4 TemplateEngine.render → user-message prompt
    │
    ▼
5.5 ClaudeRunner.run({prompt, system_prompt=identity, cwd=worktree})
    │  ├─ log: projects/leader-01/tasks/task-0000000001/exec-<ts>.log
    │  └─ result: projects/leader-01/tasks/task-0000000001/result.md
    │             (Tom 同时写 local_doc_path = projects/leader-01/docs/Tom/<date>/plan-<chain_id>.md)
    ▼
5.6 hooks.fire("worker_message_end")
    │
    ▼
5.7 CommitChecker.check (git status → commit message → git commit)
    │  └─ commit log: projects/leader-01/tasks/task-0000000001/commit.log
    ▼
5.8 SelfEvaluator.evaluate (worker-evaluate.md, fork_session, ≤3 次重试)
    │  └─ eval log: projects/leader-01/tasks/task-0000000001/eval-<N>.log
    │
    sendCompletionReport → /messages/leader-01/msg-0000000002
    task_queue.complete → /tasks/completed/task-0000000001
    hooks.fire("task_completed")
    registry.heartbeat(idle)（try/finally）
    message_router.dismiss(/messages/tom-01/msg-0000000001)
    │
    ▼
5.9 Leader LeaderWatcher ← msg-0000000002
    ChainRouter.handleCompletionReport
      → chain_audit.record('completion_report')
      → activate_next → findOrCreatePendingTask("chain-pagination-001", "build")
                                              → 复用 task-0000000002
      → task_queue.assign(task-0000000002, jerry-01)
      → chain_audit.setLinkTask("build", task-0000000002)
      → chain_audit.setLinkWorker("build", jerry-01)
      → MessageRouter.send → /messages/jerry-01/msg-0000000001
```

## 5.1 任务认领 + busy 心跳 + task_claimed hook

`WorkerWatcher.processMessage`（`packages/worker/src/watcher.ts`）的入口：

```typescript
await this.opts.registry.heartbeat(this.opts.instance_id, {
  status: "busy",
  current_task_id: realTaskId,
}).catch(...);    // 不阻塞主流程
try {
  await this.processTask({ msg, link, taskId, realTaskId, isChainLink });
} finally {
  await this.opts.registry.heartbeat(this.opts.instance_id, {
    status: "idle",
    current_task_id: null,
  }).catch(...);
}
```

`/claude-orchestrator/instances/tom-01` 在 ZK 端 status 字段先从 `idle` → `busy`（current_task_id="task-0000000001"），处理完后回到 `idle`（current_task_id=null）。`ChainRouter.findIdleWorkerByRole` 据此过滤。

进入 `processTask` 后第一件事是认领：

```typescript
const claimed = await this.opts.task_queue.claimById(
  realTaskId,                  // "task-0000000001"
  this.opts.instance_id,       // "tom-01"
);
if (claimed) {
  await this.opts.hooks.fire({
    type: "task_claimed",
    env: { CO_WORKER_NAME: "Tom", CO_WORKER_ID: "tom-01",
           CO_TASK_ID: "task-0000000001", CO_LINK: "plan",
           CO_CHAIN_ID: "chain-pagination-001" },
  });
}
```

`claimById` 实现（`packages/coordination/src/task-queue.ts`）：
1. `getData("/tasks/pending/task-0000000001")` —— 读出 task 快照
2. `createEphemeral("/tasks/claimed/tom-01-task-0000000001", ClaimRecord)` —— 原子接管；失败（已被并发认领）返回 null
3. `delete("/tasks/pending/task-0000000001")` —— 移除 pending
4. 返回 status=claimed 的 Task 对象

**ZK 状态切换**：
- 进入 plan 处理：`/tasks/claimed/tom-01-task-0000000001` 出现（EPHEMERAL，Tom 断线自删）；`/tasks/pending/task-0000000001` 被删
- §5.8 末尾：`task_queue.complete(task_id, resultPath, instance_id, name, duration)` 把节点搬到 `/tasks/completed/task-0000000001` (PERSISTENT)，删除 claimed，并 fire `task_completed` hook（含 `duration_seconds`）
- `task_queue.claim(claimer, role)` 仍存在，主要被 TaskRecovery / CLI 使用，本工作流不走它

Edge case：若 task_id 对应的 pending 节点已不存在（重启重发、recovery 时清空 pending 后又收到旧消息等），`claimById` 返回 null，Worker 仍继续处理（仅记一条 warn log），不阻塞消息处理。

## 5.2 选择模板

`packages/worker/src/watcher.ts` `processTask()`：

```typescript
const taskId = msg.task_id ?? asTaskId(`adhoc-${msg.id || ...}`);
//   "task-0000000001"
const resultPath = cachePaths.taskResultPath(this.opts.cache_paths, taskId);
//   ~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/result.md
const logPath = cachePaths.taskLogPath(this.opts.cache_paths, taskId, new Date().toISOString().replace(/[:.]/g, "-"));
//   ~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/exec-2026-05-14T03-00-03-000Z.log

const tplName = LINK_TO_TASK_TEMPLATE[link];      // "worker-planner-task.md"
```

`cachePaths.taskLogPath/taskResultPath/evalLogPath/commitLogPath` 不额外拼 `task-` 前缀，因为 task_queue 生成的 id 本身就是 `task-NNNNNNNNNN`。每条 task 拥有独立子目录 `tasks/<task_id>/`，目录下放 `definition.md`（暂未生成）、`exec-<ts>.log`、`eval-<N>.log`、`commit.log`、`result.md`。锁定行为见 `packages/contracts/tests/core/unit/paths.test.ts`。

`LINK_TO_TASK_TEMPLATE` 在 `packages/worker/src/watcher.ts:30-37` 把每条 link 映射到 `worker-{role}-task.md`（5 个 role）+ `worker-decompose.md`。Tom 的 system prompt 是 boot 时一次性载入的 `worker-planner.md` + `personal-claude-planner.md`（已渲染 `{{name}}`/`{{role}}`），每次任务额外渲染 per-task wrapper 作为 user message。

## 5.3 Hook: worker_message_start

```typescript
await this.opts.hooks.fire({
  type: "worker_message_start",
  env: {
    CO_WORKER_NAME: "Tom",
    CO_WORKER_ID:   "tom-01",
    CO_TASK_ID:     "task-0000000001",
    CO_LINK:        "plan",
    CO_CHAIN_ID:    "chain-pagination-001",
    CO_LOG_PATH:    "~/.../projects/leader-01/tasks/task-0000000001/exec-...log",
    CO_RESULT_PATH: "~/.../projects/leader-01/tasks/task-0000000001/result.md",
  },
});
```

`HookEngine`（`packages/runtime/src/hook-engine.ts`）按配置触发 shell 脚本，环境变量按上表注入。同样的 env shape 用于 `task_claimed` / `task_completed`，外加 `duration_seconds`（仅 task_completed）。

## 5.4 模板渲染

`packages/worker/src/watcher.ts` 的 `renderPrompt(retryHint)`：

```typescript
prompt = this.opts.template_engine.render(tplName /* worker-planner-task.md */, {
  name:             this.opts.worker_name,                           // "Tom"
  role:             this.opts.worker_role,                           // "planner"
  date:             dateStamp,
  unique_key:       uniqueKey,                                       // chain_id 或 taskId
  task_title:       msg.task_title ?? "",                            // "设计 /api/users 分页接口蓝图"
  task_description: msg.task_description ?? msg.content,             // msg.task_description 携带 ChainDef.description
  task_criteria:    msg.task_criteria ?? "",                         // msg.task_criteria 携带 ChainDef.criteria
  result_path:      resultPath,                                      // 见 5.2
  local_doc_path:   localDocPath,                                    // projects/leader-01/docs/Tom/<date>/plan-<chain_id>.md
  work_dir:         this.opts.worktree_path,                         // "~/work/co-pagination/.worktrees/Tom"
  time:             new Date().toISOString(),
  content:          msg.content,                                     // "设计 /api/users 分页接口蓝图"
  original_requirement_path: msg.original_requirement_path ?? "",    // chains/<id>/requirement.md
  upstream_plan_artifact:   chainArtifacts.plan,                     // plan 阶段为空字符串
  upstream_build_artifact:  chainArtifacts.build,
  upstream_verify_artifact: chainArtifacts.verify,
  upstream_review_artifact: chainArtifacts.review,
  retry_hint:       retryHint,                                       // 主任务校验失败时携带
});
```

**渲染后 prompt 关键段**（template = `templates/agents/worker-planner-task.md`，附加在 system prompt 后作为 user message）：

```markdown
## Task to Execute

**Title**: 设计 /api/users 分页接口蓝图
**Description**: 定义 page/page_size 入参约束、默认值、分页响应结构（含 total/page/page_size/items）、数据库分页 SQL 形态、对错误参数的 4xx 响应、与现有 GET /api/users 的兼容性。产出可被 Builder 直接照着实现的蓝图。
**Acceptance Criteria**: blueprint.md 包含：(1) 接口签名 (2) 入参合法性规则与示例 (3) 响应 JSON Schema 与示例 (4) DB 层伪代码或具体语句 (5) 至少 5 条覆盖 happy/边界/错误的测试用例。

## Origin
The user's original requirement is preserved verbatim at `~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/requirement.md`. Read it first whenever the task description feels under-specified — the authoritative intent lives there, not in the description above.

## Intent
The Leader needs a blueprint that downstream Builder / Verifier / Reviewer / Accepter can execute in sequence. Produce a self-contained design document — architecture, interfaces, data flow, concrete Build steps with verifiable acceptance criteria — so each downstream link can ground its work in this one file.

## Required Output Files
You MUST write your blueprint to **exactly** these two paths in the shared cache:

- `result_path` (chain 共享 cache，下游 worker 唯一权威读取入口):
  `~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/result.md`
- `local_doc_path` (worker 自留备份，cache 下同一根):
  `~/.claude-orchestrator/projects/leader-01/docs/Tom/2026-05-14/plan-chain-pagination-001.md`

Use the **Write** tool for both. Both paths are non-negotiable. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty.

## Retry Context

```

description / criteria 来自初始 ChainDef，由 task_dispatch 消息携带。Tom 的 system prompt（`worker-planner.md` + `personal-claude-planner.md`）在 boot 时已渲染 `{{name}}/{{role}}`；本步 user-message 模板里的 `{{name}}` / `{{date}}` 由 watcher 的 `renderPrompt` 替换。下游 worker 需要的上游 artifact 路径在 §5.4 的 `upstream_*_artifact` 变量中显式传入。

## 5.5 主任务执行 claude-cli

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
       -p '<rendered worker-planner-task.md>' \
       --output-format stream-json --verbose \
  > ~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/exec-<ts>.log
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

### 5.5.1 结果文件校验 + 重试

`packages/worker/src/watcher.ts` `validateOutput()`：
- exit_code 非 0 → `{kind:"exit_code"}`
- 仅对 chain link 检查：`stat(resultPath)` 找文件、检查非空。
- 失败时下一次重试 prompt 前缀加 `retry_hint`（最多 `MAX_GENERATION_RETRIES=3` 次）。
- 三次都失败 → 直接发 fail 报告给 Leader 并 `task_queue.fail(taskId, detail)`。

### 5.5.2 生成文件

| 路径 | 类型 | 内容 |
|------|------|------|
| `~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/exec-<ts>.log` | claude-cli stream-json | 完整流（system/init, assistant_message, tool_use 等） |
| `~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/result.md` | markdown | Tom 写入的 blueprint（即"Outputs #1"） |
| `~/.claude-orchestrator/projects/leader-01/docs/Tom/2026-05-14/plan-chain-pagination-001.md` | markdown | local_doc_path：worker 自留备份，由 Tom 自己 Write |

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

## 5.6 Hook: worker_message_end

```typescript
await this.opts.hooks.fire({
  type: "worker_message_end",
  env: { /* same as start */, exit_code: result.exit_code /* 0 */ },
});
```

时序与现状：现状代码中 `worker_message_end` 在 `runner.run` 完成 + 校验之后、commit / evaluate / completion_report 之前触发。文档结构里写在 5.6 是为对应代码线性顺序。

## 5.7 自动 commit（CommitChecker）

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

`packages/worker/src/commit-checker.ts` `check()` 流程：

1. `git status --porcelain` （cwd=worktree_path）—— 收集 Tom 在 worktree 内做的源码改动（如 `src/...` / `tests/...`）。注：blueprint.md / local_doc_path 写在 cache 下，**不**在 worktree git 工作区，不会出现在 `git status` 输出。
2. `parseStatus()` → 拆分 `changed` / `untracked` 数组（worktree 内的实际改动文件）
3. `generateMessage()`：
   - 模板：`templates/agents/worker-commit-message.md`
   - vars: `changed_files / untracked_files / task_title / link`
   - 调 `ClaudeRunner.run({prompt, log_path: commitLogPath, resume_session_id: "sess-tom-plan-001", quiet: true})`
   - log 路径：`~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/commit.log`
   - 读 log 首行截 72 字符 → 假设 `feat(plan): blueprint for /api/users pagination`
4. `execFileSync("git", ["add", "-A"], …)` + `execFileSync("git", ["commit", "-m", message], …)`，message 作为单独 argv 元素传给 git，跳过 shell 解析（避免命令注入）。
5. `git rev-parse HEAD` → `7c4f3a2b...`
6. 返回 `CommitResult`：

```json
{
  "sha": "7c4f3a2b9d1e5f6a8b4c3d2e1f0987654321abcd",
  "message": "feat(plan): blueprint for /api/users pagination",
  "changed_files": [],
  "untracked_files": []
}
```

（Plan 环节 Tom 通常不改 worktree 内源码，changed/untracked 多为空；Build 环节 Jerry 会有实际改动。）

错误处理：`git commit` 失败 → 返回 null。`git status` 失败由 execFileSync 抛异常（外层未 catch，冒泡到 processTask 终止当前任务，但 try/finally 会保证 idle heartbeat 仍写回）。生成 commit message 失败 → fallback `chore: auto-commit from Tom`。

## 5.8 自评估 + 完成报告 + 收尾

### 5.8.1 自评估

```typescript
if (link && CHAIN_LINKS.includes(link as TaskLink)) {
  await this.sendCompletionReport(link as TaskLink, msg, resultPath, taskId, commit, result.session_id ?? undefined);
}
```

`sendCompletionReport` 第一步：

```typescript
const evalContent = await this.opts.evaluator.evaluate({
  link: "plan",
  task_id: "task-0000000001",
  task_result_path: resultPath,
  msg_vars: {
    task_title:       "设计 /api/users 分页接口蓝图",
    task_description: msg.task_description ?? "",       // ChainDef.description
    task_criteria:    msg.task_criteria ?? "",           // ChainDef.criteria
    content:          msg.content,
  },
  resume_session_id: "sess-tom-plan-001",
});
```

`packages/worker/src/evaluator.ts` `evaluate()` 流程，循环 ≤ `MAX_RETRIES=3` 次：

每次 attempt N：
- `evalLogPath = cachePaths.evalLogPath(cache_paths, taskId, N)` → `projects/leader-01/tasks/task-0000000001/eval-{N}.log`
- `evalResultPath = evalLogPath + ".result.md"`
- prompt = `template_engine.render("worker-evaluate.md", { ...baseVars, result_path: evalResultPath })`
  - baseVars: `link=plan, task_result_path=tasks/.../result.md, work_dir=worktree, time=...` + msg_vars
- attempt > 0 时追加 `worker-evaluate-format-hint.md` 内容
- `runner.run({prompt, log_path: evalLogPath, system_prompt: identity, resume_session_id, fork_session: true, quiet: true})`
  - `fork_session=true` → 每次重试从主任务 session 分叉出干净分支，避免错误锚定
- 读 `evalResultPath`，过 `extractJson` + `EvalDecisionSchema.safeParse`
- 成功 → return JSON.stringify(parsed.data)
- 失败 → 进入下一次重试

3 次全失败 → fallback：
```typescript
const next = NEXT_LINKS[input.link];           // "build"
if (next) return JSON.stringify({
  decision: "activate_next",
  reason: `auto-advance from plan after 3 eval failures`,
  next_link: "build",
});
```

### 5.8.2 模板字段名与 Schema 对齐

`templates/agents/worker-evaluate.md` 输出的字段命名与 `EvalDecisionSchema` 对齐：

- 字段命名为 snake_case：`next_link / suggested_worker / feedback_to_worker / feedback_target`；
- 决策枚举 4 个：`activate_next / feedback / reject / close_chain`；
- 输出按 discriminated union 分四个分支列出，禁止跨分支污染字段；
- `worker-evaluate-format-hint.md` 显式列出禁用的旧字段名（attempt > 0 时追加）。

`EvalDecisionSchema` 定义在 `packages/contracts/src/schemas/eval.ts`。claude 严格按模板输出可直接通过 schema 校验，fallback 路径仅在 claude 偏离模板时启用。

### 5.8.3 EvalDecision 最终内容

假设 claude 输出命中 schema（或走 fallback）：

```json
{
  "decision": "activate_next",
  "reason": "blueprint complete, all 5 criteria addressed",
  "next_link": "build"
}
```

返回给 `sendCompletionReport` 的 `evalContent` 是 `JSON.stringify(...)` 字符串。

### 5.8.4 完成报告 + commit envelope

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
  result_path: resultPath,                        // tasks/task-0000000001/result.md
});
```

### 5.8.5 完成报告消息体

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
  "result_path": "~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/result.md",
  "original_requirement_path": null,
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:01:30.000Z"
}
```

### 5.8.6 task_queue.complete + task_completed hook

```typescript
if (realTaskId) {
  const durationSeconds = (Date.now() - taskStart) / 1000;
  await this.opts.task_queue.complete(realTaskId, resultPath, instance_id, worker_name, durationSeconds);
  await this.opts.hooks.fire({
    type: "task_completed",
    env: { ..., duration_seconds: durationSeconds },
  });
}
```

`/tasks/claimed/tom-01-task-0000000001` 删除，`/tasks/completed/task-0000000001` 写入（PERSISTENT）。`task_completed` hook 在 env 里多了一个 `duration_seconds` 字段，shell 脚本可消费。

### 5.8.7 dismiss + idle heartbeat

```typescript
await this.opts.message_router.dismiss(this.opts.instance_id, msg.id);
//   delete("/claude-orchestrator/messages/tom-01/msg-0000000001")
```

然后 `processMessage` 的 `finally` 块回写 `status: "idle"` 心跳。

## 5.9 Leader 处理完成报告 → 激活 Build

### 5.9.1 LeaderWatcher 捕获

`/messages/leader-01/` 子节点变更 → `waitForMessage` → `poll` → `LeaderWatcher.processMessage(msg-0000000002)` → `chain_router.route(msg)`。

### 5.9.2 ChainRouter 路由

`packages/leader/src/chain-router.ts` `route()`：
- `msg.link === "plan"` 且 `msg.type === "completion_report"` → `handleCompletionReport(msg)`

### 5.9.3 handleCompletionReport

```typescript
const parsed = EvalDecisionSchema.safeParse(JSON.parse(extractJson(msg.content)));
const decision: EvalDecision = parsed.data;
//   { decision: "activate_next", reason: "...", next_link: "build" }

// 1) commit envelope 抽取（落入 chainCommits 供 close_chain 时跑 MergeValidator）
if (msg.chain_id && msg.link && raw.commit) {
  this.recordCommit(msg.chain_id, msg.link, msg.task_title, raw.commit);
}

// 2) ChainAudit 记录 completion_report 事件
if (this.opts.chain_audit && msg.chain_id) {
  await this.opts.chain_audit.record(msg.chain_id, {
    event: "completion_report",
    link: msg.link,
    worker_id: msg.from_instance,
    worker_name: msg.from_name,
    task_id: msg.task_id,
    payload: { decision: decision.decision },
  });
}

// 3) decision 分流
switch (decision.decision) {
  case "activate_next": {
    const nextTask = await this.findOrCreatePendingTask(msg.chain_id, decision.next_link);
    const worker = await this.findIdleWorkerByRole(LINK_TO_ROLE[decision.next_link]);
    if (worker) {
      await this.opts.task_queue.assign(nextTask.id, worker.id, worker.name);
      if (this.opts.chain_audit) {
        await this.opts.chain_audit.setLinkTask(msg.chain_id, decision.next_link, nextTask.id);
        await this.opts.chain_audit.record(msg.chain_id, {
          event: "task_dispatch", link: decision.next_link,
          worker_id: worker.id, worker_name: worker.name, task_id: nextTask.id,
        });
      }
      await this.opts.message_router.send({
        type: "task_dispatch",
        from_instance: leader_id, from_name: "Leader", from_role: "leader",
        to_instance: worker.id,
        content: nextTask.title,
        link: decision.next_link,
        chain_id: msg.chain_id,
        task_id: nextTask.id,
        task_title: nextTask.title,
        task_description: nextTask.description,        // 从初始 push 的 task 取
        task_criteria: nextTask.criteria,
        original_requirement_path: requirementPath,
      });
      await this.rememberDispatch(msg.chain_id, decision.next_link, worker.id);
      //   → chain_audit.setLinkWorker(...)
    }
    break;
  }
  // ... 其余 case 见 04 / 05 / 06 文档
}
```

`rememberDispatch` 现在只调 `chain_audit.setLinkWorker(chainId, link, worker.id)` —— 旧版本的内存 `chainWorkers: Map<ChainId, Map<TaskLink, InstanceId>>` 已删除，feedback 路由的 prev-link 映射改从 `manifest.link_workers` 读，Leader 重启可恢复。

### 5.9.4 activate_next 复用初始 pending task

`findOrCreatePendingTask(chain_id, link)` 实现：
- `task_queue.listPending()` 扫描，找匹配 chain_id + link 的 pending 任务复用；
- 找到则直接 dispatch 该 task（description / criteria 都从已存在的 task 取）；
- 找不到才回退到 `task_queue.push`（覆盖 decompose 跳过、recovery 后清空等场景）。

正常链路推进不产生重复 task：贯穿样例中 build 阶段 dispatch 的是 §1 初始 push 的 `task-0000000002`，其 description / criteria 已包含完整 ChainDef 信息。配合 claim / complete 流转，链路收尾时 `/tasks/completed/` 里有 5 个完成态 task 完整审计。

### 5.9.5 复用的 task-0000000002（被 assign 后）

```json
{
  "id": "task-0000000002",
  "title": "实现 /api/users 分页查询",
  "description": "按 Plan 实现 controller / service / repository 三层修改，加入参数校验，保持现有未带 page 参数时的兼容行为，并补充单元 / 集成测试。",
  "criteria": "(1) curl -G /api/users -d 'page=2&page_size=5' 返回 200 且 items.length<=5，total 字段为整数 (2) 异常 page=0/page_size=-1 返回 400 (3) 不带参数时返回首页 page=1/page_size=20 (4) 新增测试全部通过：npx vitest run users.test 0 failed。",
  "priority": 1,
  "status": "pending",
  "link": "build",
  "chain_id": "chain-pagination-001",
  "result_path": null,
  "retry_count": 0,
  "fail_reason": null,
  "created_by": "leader-01",
  "created_by_name": "Leader",
  "assigned_to": "jerry-01",
  "assigned_to_name": "Jerry",
  "claimed_by": null,
  "completed_by_name": null,
  "created_at": "2026-05-14T03:00:01.000Z",
  "claimed_at": null,
  "completed_at": null,
  "duration_seconds": null,
  "leader_only": false,
  "result": null
}
```

`assigned_to` 由 `task_queue.assign(task_id, worker_id, worker_name)` 在 5.9.3 中刷新。

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
  "content": "实现 /api/users 分页查询",
  "link": "build",
  "task_id": "task-0000000002",
  "chain_id": "chain-pagination-001",
  "task_title": "实现 /api/users 分页查询",
  "task_description": "按 Plan 实现 controller / service / repository 三层修改...",
  "task_criteria": "(1) curl -G /api/users -d 'page=2&page_size=5' 返回 200...",
  "result_path": null,
  "original_requirement_path": "~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/requirement.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:01:32.000Z"
}
```

Jerry 读 Tom 的 blueprint 通过 chain-shared cache 路径，不依赖 worktree/git 同步。`WorkerWatcher.collectChainArtifacts` 在 Jerry 端读 chain manifest（`projects/leader-01/chains/chain-pagination-001/manifest.json`），`link_tasks.plan = "task-0000000001"`，得到上游 blueprint 路径 `projects/leader-01/tasks/task-0000000001/result.md`，渲染到 user-message prompt 的 `{{upstream_plan_artifact}}` 变量。Builder 模板直接读这个 chain-shared cache 路径。

## Plan 环节产物清单

### ZK 新增节点

| 路径 | 类型 | 备注 |
|------|------|------|
| `/tasks/claimed/tom-01-task-0000000001` | EPHEMERAL | 5.1 短暂出现 |
| `/tasks/completed/task-0000000001` | PERSISTENT | 5.8 写入，duration 实时记录 |
| `/messages/leader-01/msg-0000000002` | PERSISTENT_SEQUENTIAL | Tom 的 completion_report |
| `/messages/jerry-01/msg-0000000001` | PERSISTENT_SEQUENTIAL | Leader 发给 Jerry 的 task_dispatch |

### ZK 修改节点

| 路径 | 修改 |
|------|------|
| `/tasks/pending/task-0000000001` | 5.1 删除 |
| `/tasks/pending/task-0000000002` | 5.9 `assigned_to` 设为 `jerry-01` |
| `/messages/tom-01/msg-0000000001` | **删除**（Worker dismiss） |
| `/messages/leader-01/msg-0000000002` | `read=false` → `read=true`（LeaderWatcher poll） |
| `/instances/tom-01` | status: idle → busy → idle（5.1 try/finally） |

### Cache 文件（projects/leader-01/）

| 路径 | 来源 |
|------|------|
| `tasks/task-0000000001/exec-<ts>.log` | claude-cli 主执行 stream-json |
| `tasks/task-0000000001/result.md` | blueprint.md（chain 共享，下游 worker 读取入口） |
| `tasks/task-0000000001/commit.log` | commit message claude 调用日志 |
| `tasks/task-0000000001/eval-{0,1,2}.log` | self-eval claude 调用日志（重试视情况） |
| `tasks/task-0000000001/eval-{N}.log.result.md` | self-eval JSON 输出 |
| `docs/Tom/2026-05-14/plan-chain-pagination-001.md` | local_doc_path（worker 自留备份） |
| `chains/chain-pagination-001/audit.jsonl` | append 了 `completion_report` + `task_dispatch`（build）两条事件 |
| `chains/chain-pagination-001/manifest.json` | `link_tasks.build = task-0000000002`、`link_workers.build = jerry-01` 更新 |

### Git commit

| 分支 | SHA | message |
|------|-----|---------|
| `co/tom-01` | `7c4f3a2b...` | `feat(plan): blueprint for /api/users pagination` |

### Leader 事件总线

```
[03:00:03]  message_received  from=tom-01 msg=msg-0000000002
[03:01:32]  message_processed msg=msg-0000000002
```

ChainRouter 仅在 5.7（初始 push）emit `chain_activated`，以及 `close_chain` / `reject` 时 emit `chain_closed`；中间环节推进不发额外事件，进度细节通过 ChainAudit `audit.jsonl` 持久化。
