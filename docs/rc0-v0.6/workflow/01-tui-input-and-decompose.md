# 01 — Step 1–5：TUI 输入 → 需求拆解 → 5 任务入队

> 本文档描述从用户在 TUI 键入需求到 Leader 自处理 decompose 后把 5 个任务推入 `/tasks/pending`、并把首任务派发给 Planner（Tom）为止的全过程。
>
> 贯穿样例需求：`为 REST API /api/users 增加分页支持，支持 page/page_size 参数，默认 page=1/page_size=20`
> 假设 `worker-decompose.md` 已加载到 Leader 的 `TemplateEngine`，走自处理分支（非转发 Planner）。

## 概览图

```
[Step 1]                                   [Step 4-5]
TUI 键入                                   Leader 自处理 decompose
   │                                          │
   ▼                                          ▼
MessageRouter.send()              TemplateEngine.render(worker-decompose.md)
   │                                          │
   ▼                                          ▼
ZK: /messages/leader-01/msg-0001  claude-cli (无 system prompt)
   │                                          │
   ▼                              ┌─── log:   messages/<msg-id>/inbound.log
LeaderWatcher.processMessage     │
   │                              └─── result: messages/<msg-id>/decompose.md
   ▼                                          │
ChainRouter.route()                           ▼
   │                                ChainDefSchema.parse()
   │ (link=null)                              │
   ▼                                          ▼
handleRequirement()                handleTaskDefinitions()
                                              │
                                  ┌─── persist chains/<chain_id>/requirement.md
                                  ├─── chain_audit.openChain()
                                  ├─── chain_audit.record('requirement_received')
                                  │
                                              ▼
                                   task_queue.push() × 5（首环已 assigned_to）
                                              │
                                              ▼
                                   ZK: /tasks/pending/task-0001..0005
                                              │
                                              ▼
                                   chain_audit.setLinkTask(chain, "plan", firstTaskId)
                                   chain_audit.setLinkWorker(chain, "plan", tom.id)
                                              │
                                              ▼
                                   MessageRouter.send(task_dispatch → Tom)
                                              │
                                              ▼
                                   ZK: /messages/tom-01/msg-0001
```

## Step 1 — TUI 输入与消息写入

### 1.1 用户行为

在 TUI INPUT 面板输入：
```
为 REST API /api/users 增加分页支持，支持 page/page_size 参数，默认 page=1/page_size=20
```
按 `Enter`。

### 1.2 代码路径

`packages/leader/src/tui/controller.ts` 的 `handleInput()` 收到 `{type: "enter"}` → 调用 `dispatchUserInput(text)`，后者通过 `message_router.send()` 发一条 `user_input` 类型消息给 Leader 自己：

```typescript
await this.opts.message_router.send({
  type: "user_input",
  from_instance: this.opts.leader_id,       // "leader-01"
  from_name: this.opts.leader_name,         // "Leader"
  from_role: "leader",
  to_instance: this.opts.leader_id,         // 发给自己
  content,
});
```

### 1.3 ZK 写入

`packages/coordination/src/message-router.ts` `MessageRouter.send()`：

- `mkdirp("/claude-orchestrator/messages/leader-01")`
- `createPersistentSequential("/claude-orchestrator/messages/leader-01", "msg-", encode(payload))`
- 返回路径形如 `/claude-orchestrator/messages/leader-01/msg-0000000001`

### 1.4 写入后的 ZK 节点

**路径**：`/claude-orchestrator/messages/leader-01/msg-0000000001`
**类型**：`PERSISTENT_SEQUENTIAL`
**数据**（按 `MessageSchema`，`packages/contracts/src/schemas/message.ts`）：

```json
{
  "type": "user_input",
  "from_instance": "leader-01",
  "from_name": "Leader",
  "from_role": "leader",
  "to_instance": "leader-01",
  "to_name": null,
  "content": "为 REST API /api/users 增加分页支持，支持 page/page_size 参数，默认 page=1/page_size=20",
  "link": null,
  "task_id": null,
  "chain_id": null,
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "result_path": null,
  "original_requirement_path": null,
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:00:00.000Z"
}
```

### 1.5 此刻 ZK 全景

```
/claude-orchestrator/
├── leader                                   [EPHEMERAL] Leader 元数据
├── instances/                               [PERSISTENT, children EPHEMERAL]
│   ├── leader-01                            [EPHEMERAL] {status:"idle"}
│   ├── tom-01, jerry-01, lucy-01, mia-01, leo-01   [EPHEMERAL] {status:"idle"}
├── tasks/
│   ├── pending/                             [PERSISTENT, empty]
│   ├── claimed/                             [PERSISTENT, empty]
│   └── completed/                           [PERSISTENT, empty]
└── messages/
    ├── leader-01/
    │   └── msg-0000000001                   [PERSISTENT_SEQUENTIAL, read=false] ← 用户输入
    ├── tom-01/, jerry-01/, lucy-01/, mia-01/, leo-01/   (空)
```

### 1.6 生成文件

无（TUI 输入阶段不产生 cache 文件）。

## Step 2 — LeaderWatcher 捕获消息

### 2.1 触发

`/messages/leader-01/` 子节点变更触发 ZK ChildWatch。

### 2.2 代码路径

`packages/coordination/src/message-router.ts` `waitForMessage()`：

- ChildWatch 触发 → 调用 `poll(leader-01)`
- `poll()` 读取所有子节点，反序列化，按 schema 校验，**把 `read=false` 的节点回写为 `read=true`**
- 返回新解析的 messages（去重靠 `seen` Set）→ 回调 LeaderWatcher 的 cb

`packages/leader/src/watcher.ts` `LeaderWatcher.start()` 注册的 cb：

```typescript
if (this.inFlight.has(msg.id)) return;
this.inFlight.add(msg.id);
void this.processMessage(msg).finally(() => this.inFlight.delete(msg.id));
```

`packages/leader/src/watcher.ts` `processMessage()`：
- emit `message_received` 事件 → 触发 TUI 重渲染
- `await this.chain_router.route(msg as Parameters<ChainRouter["route"]>[0])`
- emit `message_processed` 事件
- 没有 dismiss，消息留在 ZK，仅 `read=true`

### 2.3 ZK 写回

`msg-0000000001` 的 `read` 字段被回写为 `true`。

## Step 3 — ChainRouter 路由判定

### 3.1 代码路径

`packages/leader/src/chain-router.ts` `route()`：

```typescript
async route(msg: Message): Promise<void> {
  if (!msg.link) {                                              // ← 本步走这里
    await this.handleRequirement(msg);
    return;
  }
  if (msg.link === "plan" && msg.type === "completion_report") {
    await this.handleCompletionReport(msg);
    return;
  }
  if (this.looksLikeChainDef(msg.content)) {
    await this.handleTaskDefinitions(msg, msg.content);
    return;
  }
  await this.handleCompletionReport(msg);
}
```

### 3.2 判定结果

`msg.link === null` → 走 `handleRequirement(msg)`。

> 现状判定与 `core/01` 早期"三优先级 EvalDecision→ChainDef→自由文本"描述不同：实际以 `msg.link` 为首要判别（null link 一律视为需求）。完成态消息（completion_report / ChainDef JSON）必有 link，因此 link 字段足以分流，不需要再嗅探内容。这是设计简化，已记录在 README §17 旁边。

## Step 4 — Leader 自处理 decompose

### 4.1 模板加载判定

`packages/leader/src/chain-router.ts` `if (this.opts.template_engine.has("worker-decompose.md"))`：
- 命中（本贯穿样例假设） → Leader 自处理（4.2–4.7）
- 未命中 → 转发 Planner（4.8 备选分支）

### 4.2 路径与变量准备

```typescript
const logPath = cachePaths.messageLogPath(this.opts.cache_paths, msg.id);
//   logPath = ~/.claude-orchestrator/projects/leader-01/messages/msg-0000000001/inbound.log
const resultPath = cachePaths.decomposeResultPath(
  this.opts.cache_paths,
  msg.id,
);
//   resultPath = ~/.claude-orchestrator/projects/leader-01/messages/msg-0000000001/decompose.md
await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
```

每条入站消息拥有独立子目录 `messages/<message_id>/`：inbound stream-json 落 `inbound.log`、decompose 产物落 `decompose.md`，不复用 task results 路径。路径函数集中在 `packages/contracts/src/paths/cachePaths.ts`，锁定行为见 `packages/contracts/tests/core/unit/paths.test.ts`。

### 4.3 模板渲染

```typescript
const prompt = this.opts.template_engine.render("worker-decompose.md", {
  name: this.opts.leader_name,                  // "Leader"
  role: "leader",                                // 字面 "leader"
  task_title: msg.task_title ?? "",            // ""
  task_description: msg.task_description ?? msg.content,
  //   "为 REST API /api/users 增加分页支持..."
  task_criteria: msg.task_criteria ?? "",      // ""
  result_path: resultPath,
  //   "~/.../messages/msg-0000000001/decompose.md"
  work_dir: process.cwd(),
  time: new Date().toISOString(),
  content: msg.content,
});
```

`worker-decompose.md` 用到 `{{task_description}}`、`{{result_path}}`、`{{name}}` 等变量。`name = leader_name`、`role = "leader"` 在渲染时被替换，prompt 中 `{{name}}` 显示为 `Leader`。

**渲染后 prompt（关键片段）**：

```markdown
Break down the requirement below into a chain of tasks following the Plan → Build → Verify → Review → Accept responsibility chain.

## Step 0: Restore Directory Memory

Read `~/.claude-orchestrator/projects/leader-01/docs/Leader/YYYY-MM-DD/CLAUDE.md` (use today's date) to restore session context. ...

## Requirement

为 REST API /api/users 增加分页支持，支持 page/page_size 参数，默认 page=1/page_size=20

## Instructions

1. Analyze the requirement. Identify how many independent delivery chains are needed.
2. For each chain, define five link tasks. Plan is optional ...
3. For each task, specify objectively verifiable completion criteria ...
4. Assign priority: 0 (urgent), 1 (high), 2 (normal).

## Output

Write the result to ~/.claude-orchestrator/projects/leader-01/messages/msg-0000000001/decompose.md.

```json
{ ... template skeleton ... }
```

Output ONLY the JSON. No explanation.
```

### 4.4 claude-cli 调用

`packages/leader/src/chain-router.ts` `await this.opts.runner.run({ prompt, log_path: logPath })`：

`packages/runtime/src/runner.ts` `ClaudeRunner.run()`：
- 调 `execWithStreaming` (`@co/infra`)
- 不注入 system_prompt：Leader 自处理 decompose 是 Leader 的本地 reasoning，不需要 worker 身份卡。
- 命令形态（简化）：
  ```bash
  claude -p '<rendered prompt>' \
         --output-format stream-json --verbose \
       | tee ~/.claude-orchestrator/projects/leader-01/messages/msg-0000000001/inbound.log
  ```
- 返回 `{exit_code, session_id, log_path}`

### 4.5 生成文件（this step）

| 路径 | 内容 |
|------|------|
| `~/.claude-orchestrator/projects/leader-01/messages/msg-0000000001/inbound.log` | claude-cli stream-json 完整流（system/init + assistant_message + result） |
| `~/.claude-orchestrator/projects/leader-01/messages/msg-0000000001/decompose.md` | claude 按 `worker-decompose.md` 指令写入的 ChainDef JSON |

### 4.6 claude-cli 出参 — ChainDef 完整 JSON

`result_path` 写入的内容（贯穿样例）：

```json
{
  "chain_id": "chain-pagination-001",
  "chain_title": "为 /api/users 增加分页支持",
  "tasks": {
    "plan": {
      "title": "设计 /api/users 分页接口蓝图",
      "description": "定义 page/page_size 入参约束、默认值、分页响应结构（含 total/page/page_size/items）、数据库分页 SQL 形态、对错误参数的 4xx 响应、与现有 GET /api/users 的兼容性。产出可被 Builder 直接照着实现的蓝图。",
      "criteria": "blueprint.md 包含：(1) 接口签名 (2) 入参合法性规则与示例 (3) 响应 JSON Schema 与示例 (4) DB 层伪代码或具体语句 (5) 至少 5 条覆盖 happy/边界/错误的测试用例。",
      "priority": 1
    },
    "build": {
      "title": "实现 /api/users 分页查询",
      "description": "按 Plan 实现 controller / service / repository 三层修改，加入参数校验，保持现有未带 page 参数时的兼容行为，并补充单元 / 集成测试。",
      "criteria": "(1) curl -G /api/users -d 'page=2&page_size=5' 返回 200 且 items.length<=5，total 字段为整数 (2) 异常 page=0/page_size=-1 返回 400 (3) 不带参数时返回首页 page=1/page_size=20 (4) 新增测试全部通过：npx vitest run users.test 0 failed。",
      "priority": 1
    },
    "verify": {
      "title": "独立验证分页实现与蓝图一致",
      "description": "对照 Plan 的 5 条以上测试用例逐项执行；逐字段比对响应 schema；运行集成测试套件；分类 PASS / GAP / FAILURE / DEVIATION。",
      "criteria": "verification-map.md 列出全部 Plan 条目的 PASS/GAP/FAILURE/DEVIATION 分类，evidence/ 下有每条实际 curl/test 输出。",
      "priority": 1
    },
    "review": {
      "title": "审查分页实现的设计一致性",
      "description": "判断实现是否未引入额外副作用、是否符合 Plan 意图、Verifier 的 FAILURE 是否真的需要修。",
      "criteria": "review-judgment.md 给出 ACCEPT/CONCERN/REJECT；若 CONCERN，指明责任 link 与具体改动建议。",
      "priority": 1
    },
    "accept": {
      "title": "验收分页接口业务交付",
      "description": "从外部调用方视角验收：默认行为是否变更、分页响应是否便于前端消费、错误信息是否对前端友好。",
      "criteria": "acceptance-report.md 给出 GO / NO-GO。GO 要求 Verifier FAILURE 0 / Reviewer CONCERN 0；NO-GO 必须列明缺失项与对应 link。",
      "priority": 1
    }
  }
}
```

### 4.7 ChainDef 抽取

```typescript
const resultContent = await fs.promises.readFile(resultPath, "utf-8");
const cleaned = extractJson(resultContent);    // 见 packages/runtime/src/json.ts
await this.handleTaskDefinitions(
  { ...msg, content: cleaned },
  originalRequirement,
);
```

`extractJson` 会剥掉 ```` ```json ``` ```` 围栏，匹配首个 `{...}` 块。返回纯 JSON 字符串。`originalRequirement` 是 4.3 之前保存的 `msg.content` 副本（在 decompose 覆盖前 capture），后续 §5.2 持久化到 `requirement.md`。

### 4.8 备选分支：转发 Planner

若 `template_engine.has("worker-decompose.md") === false`，走 `packages/leader/src/chain-router.ts`：

```typescript
const planner = await this.findIdleWorkerByRole("planner");
if (!planner) {
  this.opts.logger.warn("no planner available — requirement dropped");
  return;                                  // 需求丢弃，无任何回退
}
await this.opts.message_router.send({
  type: "task_dispatch",
  from_instance: leader_id, ...
  to_instance: planner.id,                 // 发给 Tom
  content: msg.content,
  link: "plan",                            // 注意 link="plan" 而非 "decompose"
  task_description: msg.content,
});
```

转发分支下 Planner 收到的是一条 `link="plan"` 的任务，Planner 会用 `worker-planner-task.md` 模板而非 `worker-decompose.md` —— 与自处理分支语义不同（不会生成 ChainDef）。本贯穿样例不走此分支，详情见 `02-plan-link.md`。

## Step 5 — handleTaskDefinitions → 入队 5 个任务

### 5.1 Schema 校验

```typescript
const parsed = ChainDefSchema.safeParse(JSON.parse(extractJson(msg.content)));
if (!parsed.success) {
  throw new ValidationError("invalid ChainDef in message", parsed.error);
}
const chainDef: ChainDef = parsed.data;
```

`ChainDefSchema` 见 `packages/contracts/src/schemas/chain.ts`：要求 `chain_id` (string) + `chain_title` + `tasks.{plan|build|verify|review|accept}`，plan 可为 null，其余必须。贯穿样例的 ChainDef 全部 5 个 link 都存在。

### 5.2 持久化 requirement.md + 打开 ChainAudit

```typescript
const requirementPath = cachePaths.chainRequirementPath(this.opts.cache_paths, chainDef.chain_id);
//   ~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/requirement.md
await fs.promises.mkdir(path.dirname(requirementPath), { recursive: true });
await fs.promises.writeFile(requirementPath, originalRequirement, "utf-8");

if (this.opts.chain_audit) {
  await this.opts.chain_audit.openChain(chainDef.chain_id, {
    created_at: new Date().toISOString(),
    leader_id: this.opts.leader_id,
    leader_name: this.opts.leader_name,
    requirement_path: requirementPath,
  });
  await this.opts.chain_audit.record(chainDef.chain_id, {
    event: "requirement_received",
    payload: { requirement_path: requirementPath },
  });
}
```

ChainAudit 是 c7abe11 引入的子系统，落到 `~/.claude-orchestrator/projects/<leader_id>/chains/<chain_id>/` 目录下，含两个文件：

- **`manifest.json`** —— link_tasks / link_workers 映射 + status + requirement_path + 时间戳。`openChain` 时写入初始版本（status=running，所有 link_tasks/link_workers 均 null），后续 `setLinkTask` / `setLinkWorker` / `closeChain` 增量更新。
- **`audit.jsonl`** —— append-only 事件流。每条 record 一行 JSON，含 `ts / chain_id / event / link / worker_id / worker_name / task_id / payload`。事件类型见 `packages/leader/src/chain-audit.ts:32-39` 的 `ChainAuditEventType`。

### 5.3 预解析首环 worker

```typescript
let firstLink: TaskLink | null = null;
for (const link of linkOrder) {
  if (chainDef.tasks[link]) { firstLink = link; break; }
}
const firstWorker = firstLink
  ? await this.findIdleWorkerByRole(LINK_TO_ROLE[firstLink])
  : null;
```

`findIdleWorkerByRole("planner")` 返回 Tom（`tom-01`）—— 按 `status === "idle"` 过滤（Worker 在处理消息时把自己心跳为 busy，详见 `02` §5.1）。

### 5.4 循环 push 5 个任务

```typescript
let firstTaskId: string | null = null;
let firstDef: ChainDef["tasks"][TaskLink] | null = null;
for (const link of linkOrder) {
  const def = chainDef.tasks[link];
  if (!def) continue;
  const isFirst = link === firstLink;
  const task = await this.opts.task_queue.push({
    title: def.title,
    description: def.description,
    criteria: def.criteria,
    priority: def.priority,
    link,
    chain_id: chainDef.chain_id,
    created_by: this.opts.leader_id,
    created_by_name: this.opts.leader_name,
    assigned_to: isFirst && firstWorker ? firstWorker.id : null,
    assigned_to_name: isFirst && firstWorker ? firstWorker.name : null,
  });
  if (isFirst) { firstTaskId = task.id; firstDef = def; }
}
```

`packages/coordination/src/task-queue.ts` `TaskQueue.push()`：
- 构造完整 payload（含默认值，`retry_count=0` 等）
- `createPersistentSequential("/claude-orchestrator/tasks/pending", "task-", encode(payload))`
- 返回带 id 的 Task

### 5.5 ZK 写入后的 5 个 task 节点

```
/claude-orchestrator/tasks/pending/
├── task-0000000001    ← link="plan",  assigned_to="tom-01"
├── task-0000000002    ← link="build", assigned_to=null
├── task-0000000003    ← link="verify", assigned_to=null
├── task-0000000004    ← link="review", assigned_to=null
└── task-0000000005    ← link="accept", assigned_to=null
```

**`task-0000000001` 完整 JSON**（其余 4 个结构相同，仅 title/description/criteria/link/assigned_to 不同）：

```json
{
  "id": "task-0000000001",
  "title": "设计 /api/users 分页接口蓝图",
  "description": "定义 page/page_size 入参约束、默认值、分页响应结构（含 total/page/page_size/items）、数据库分页 SQL 形态、对错误参数的 4xx 响应、与现有 GET /api/users 的兼容性。产出可被 Builder 直接照着实现的蓝图。",
  "criteria": "blueprint.md 包含：(1) 接口签名 (2) 入参合法性规则与示例 (3) 响应 JSON Schema 与示例 (4) DB 层伪代码或具体语句 (5) 至少 5 条覆盖 happy/边界/错误的测试用例。",
  "priority": 1,
  "status": "pending",
  "link": "plan",
  "chain_id": "chain-pagination-001",
  "result_path": null,
  "retry_count": 0,
  "fail_reason": null,
  "created_by": "leader-01",
  "created_by_name": "Leader",
  "assigned_to": "tom-01",
  "assigned_to_name": "Tom",
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

Task schema 中不包含 `task_doc_path` / `depends_on` / `blocked_by` / `blocked_reason` 字段；任务推进由 `handleCompletionReport.activate_next` 显式 push 新任务 + 派发消息驱动，无内建的线性依赖。

### 5.6 emit chain_activated

`this.opts.bus.emit({ type: "chain_activated", chain_id: chainDef.chain_id })` → TUI EVENT LOG 显示一条 "Chain activated: chain-pagination-001"。

### 5.7 派发首任务 + 更新 ChainAudit

```typescript
if (firstLink && firstTaskId && firstDef) {
  if (firstWorker) {
    if (this.opts.chain_audit) {
      await this.opts.chain_audit.setLinkTask(chainDef.chain_id, firstLink, asTaskId(firstTaskId));
      await this.opts.chain_audit.record(chainDef.chain_id, {
        event: "task_dispatch",
        link: firstLink,
        worker_id: firstWorker.id,
        worker_name: firstWorker.name,
        task_id: asTaskId(firstTaskId),
      });
    }
    await this.opts.message_router.send({
      type: "task_dispatch",
      from_instance: this.opts.leader_id,
      from_name: this.opts.leader_name,
      from_role: "leader",
      to_instance: firstWorker.id,                 // "tom-01"
      content: firstDef.title,                     // "设计 /api/users 分页接口蓝图"
      link: firstLink,                             // "plan"
      chain_id: chainDef.chain_id,
      task_id: firstTaskId as never,
      task_title: firstDef.title,
      task_description: firstDef.description,
      task_criteria: firstDef.criteria,
      original_requirement_path: requirementPath,
    });
    await this.rememberDispatch(chainDef.chain_id, firstLink, firstWorker.id);
  }
}
```

`rememberDispatch` 是 `ChainRouter` 内部包装，直接调 `chain_audit.setLinkWorker(chain_id, link, worker_id)`，把 link → worker_id 映射持久化到 manifest.json 的 `link_workers` 字段；Leader 进程重启后 `resolveFeedbackTarget` 可恢复（详见 `04` §7.9.1）。

task_dispatch 携带 `task_description / task_criteria / original_requirement_path`，由初始 ChainDef 转写。下游 worker 不依赖 worktree 内的上下文复原任务细节。

### 5.8 ZK 写入后的 task_dispatch 消息

**路径**：`/claude-orchestrator/messages/tom-01/msg-0000000001`
**完整 Message JSON**：

```json
{
  "id": "msg-0000000001",
  "type": "task_dispatch",
  "from_instance": "leader-01",
  "from_name": "Leader",
  "from_role": "leader",
  "to_instance": "tom-01",
  "to_name": null,
  "content": "设计 /api/users 分页接口蓝图",
  "link": "plan",
  "task_id": "task-0000000001",
  "chain_id": "chain-pagination-001",
  "task_title": "设计 /api/users 分页接口蓝图",
  "task_description": "定义 page/page_size 入参约束、默认值、分页响应结构...",
  "task_criteria": "blueprint.md 包含：(1) 接口签名 ...",
  "result_path": null,
  "original_requirement_path": "~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/requirement.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:00:02.000Z"
}
```

## Step 5 收尾时 ZK 全景

```
/claude-orchestrator/
├── leader, instances/...                                  (不变)
├── tasks/
│   ├── pending/
│   │   ├── task-0000000001  link=plan      assigned_to=tom-01
│   │   ├── task-0000000002  link=build     assigned_to=null
│   │   ├── task-0000000003  link=verify    assigned_to=null
│   │   ├── task-0000000004  link=review    assigned_to=null
│   │   └── task-0000000005  link=accept    assigned_to=null
│   ├── claimed/                                           (空，下一步 Tom 处理后会出现)
│   └── completed/                                         (空)
└── messages/
    ├── leader-01/
    │   └── msg-0000000001                  read=true       ← 用户输入，已读
    ├── tom-01/
    │   └── msg-0000000001                  read=false      ← task_dispatch，待处理
    ├── jerry-01/, lucy-01/, mia-01/, leo-01/              (空)
```

## Step 5 收尾时已生成的 cache 文件

| 路径 | 大小估计 | 内容 |
|------|---------|------|
| `~/.claude-orchestrator/projects/leader-01/messages/msg-0000000001/inbound.log` | 数 KB | decompose claude-cli stream-json 完整流 |
| `~/.claude-orchestrator/projects/leader-01/messages/msg-0000000001/decompose.md` | 数 KB | ChainDef JSON（§4.6） |
| `~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/requirement.md` | <1 KB | 原始 user requirement 文本（5.2 持久化） |
| `~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/manifest.json` | <2 KB | ChainManifest 初版，含 link_tasks 5×null（plan 已填）+ link_workers 5×null（plan 已填 tom-01）+ status=running |
| `~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/audit.jsonl` | <1 KB | 已 append `chain_opened` / `requirement_received` / `task_dispatch` 三行 |

**`manifest.json` 此刻内容（示意）**：

```json
{
  "chain_id": "chain-pagination-001",
  "created_at": "2026-05-14T03:00:01.000Z",
  "completed_at": null,
  "status": "running",
  "leader_id": "leader-01",
  "leader_name": "Leader",
  "requirement_path": "~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/requirement.md",
  "link_tasks": {
    "plan":   "task-0000000001",
    "build":  null,
    "verify": null,
    "review": null,
    "accept": null
  },
  "link_workers": {
    "plan":   "tom-01",
    "build":  null,
    "verify": null,
    "review": null,
    "accept": null
  }
}
```

后续每个 link 完成、新的 task_dispatch 时，会增量更新 `link_tasks[link]` 和 `link_workers[link]`；feedback 决策走 retry_count++ 时也会同步刷新（详见 `04` §7.9.1）。

## TUI EVENT LOG 状态

按 LeaderEventBus 发出的事件顺序：

```
[03:00:00] message_received  from=leader-01  "为 REST API /api/users..."
[03:00:01] chain_activated   chain=chain-pagination-001
[03:00:02] message_processed msg=msg-0000000001
```

## 衔接到 Step 6

Tom 的 `WorkerWatcher` 的 ZK ChildWatch 触发，开始处理 `msg-0000000001`。下一步流程在 [`02-plan-link.md`](./02-plan-link.md) 中详细展开（共 5.1–5.9 九个子步骤）。
