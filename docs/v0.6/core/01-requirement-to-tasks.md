# Core Chain 1 — 用户输入 → 需求拆解 → 任务入队

> **链路定位**：用户通过 TUI 输入需求到最终产生 5 个 Pending 任务的全过程。这是整个编排系统的入口链路。

## 1. 链路总览

```
TUI 键盘输入
    │
    ▼
/messages/{leader_id}/msg-{seq}    ← PERSISTENT_SEQUENTIAL
    │
    ▼
LeaderWatcher 捕获 (ChildWatch)
    │
    ▼
ChainRouter.route(msg)
    │
    ├── 模板已加载 → Leader 自处理 decompose
    │     └─ claude-cli + worker-decompose.md → ChainDef JSON
    │
    └── 模板未加载 → 转发 decompose 消息给 Planner Worker
          └─ Planner processMessage() + worker-decompose.md → 完成报告 → Leader
    │
    ▼
ChainRouter 解析 ChainDef → push 4-5 个任务
    │
    ▼
/tasks/pending/task-{seq} × N     ← PERSISTENT_SEQUENTIAL
```

## 2. Step 1 — TUI 输入

用户在 TUI INPUT 面板键入需求文本，按 Enter 发送：

```
LeaderTui.onInput(text)
  → zk.createMessage(leaderInstanceId, {
      type: "user_input",
      from_instance: leaderId,
      from_name: "Leader",
      to_instance: leaderId,   // 发送给自己
      content: text,
    })
  → /messages/{leader_id}/msg-NNNNN
```

消息写入后，LeaderWatcher 的 ZK ChildWatch 触发。

## 3. Step 2 — LeaderWatcher 捕获

```typescript
// LeaderWatcher.processMessage(msgId)
const data = await zk.getMessage(leaderInstanceId, msgId);
const msg = MessageSchema.parse({ ...data, id: msgId });

if (msg.read) return;           // 防止重复处理
this.inFlight.add(msgId);

eventBus.emit({ type: "message_received", from, content: msg.content, msgId });

await chainRouter.route(msg);   // 进入路由

msg.read = true;
await zk.updateMessage(leaderInstanceId, msgId, msg);
this.inFlight.delete(msgId);
```

## 4. Step 3 — ChainRouter 路由判定

ChainRouter 按优先级判定消息类别：

```typescript
async route(msg: Message): Promise<void> {
  // 优先级 1: EvalDecision JSON（Worker 完成报告）
  const evalResult = tryParseEvalDecision(msg.content);
  if (evalResult) return this.handleCompletionReport(msg, evalResult);

  // 优先级 2: ChainDef JSON（decompose 输出）
  const chainResult = tryParseChainDef(msg.content);
  if (chainResult) return this.handleChainDef(chainResult);

  // 优先级 3: 自由文本 → 需求输入
  return this.handleRequirement(msg.content);
}
```

## 5. Step 4a — Leader 自处理 Decompose

当 `TemplateEngine` 已加载 `worker-decompose.md` 时，Leader 自身调用 claude-cli：

```typescript
async handleRequirement(content: string): Promise<void> {
  if (templateEngine.get("worker-decompose.md")) {
    // 自处理
    const prompt = templateEngine.render("worker-decompose.md", {
      requirement: content,
      time: new Date().toISOString(),
    });
    const logPath = path.join(cacheDir, leaderId, `msg-${msgId}-${ts}.log`);
    const { code } = await runner.run(prompt, logPath, {
      systemPrompt: leaderIdentity,
    });

    // 从日志中提取 ChainDef JSON
    const output = await fs.readFile(logPath, "utf-8");
    const chainDef = extractJson(output) as ChainDef;
    return this.handleChainDef(chainDef);
  }

  // 转发给 Planner Worker
  const planner = workers.find(w => w.role === "planner");
  await zk.sendMessage(planner.id, {
    type: "task_dispatch",
    link: "decompose",
    content: content,
    ...
  });
}
```

## 6. Step 4b — Planner Worker 处理 Decompose

当模板未加载或 Leader 选择转发时，Planner Worker 接收 decompose 消息：

```
WorkerWatcher.processMessage(msg):
  link = "decompose"
  template = worker-decompose.md
  prompt = templateEngine.render(template, { requirement: msg.content, ... })
  runner.run(prompt, logPath, { systemPrompt })
  → 输出 ChainDef JSON
  → 发送 completion_report 回 Leader
```

## 7. Step 5 — 解析 ChainDef → Push Tasks

ChainDef JSON 格式：

```json
{
  "chain_id": "chain-001",
  "chain_title": "用户认证模块",
  "tasks": {
    "plan":   { "title": "认证蓝图", "description": "...", "criteria": "...", "priority": 0 },
    "build":  { "title": "实现认证", "description": "...", "criteria": "...", "priority": 1 },
    "verify": { "title": "验证认证", "description": "...", "criteria": "...", "priority": 1 },
    "review": { "title": "审查认证", "description": "...", "criteria": "...", "priority": 1 },
    "accept": { "title": "验收认证", "description": "...", "criteria": "...", "priority": 2 }
  }
}
```

`plan` 可为 `null`，表示跳过 Plan 直接从 Build 开始。

```typescript
async handleChainDef(chainDef: ChainDef): Promise<void> {
  const taskIds: Record<string, TaskId> = {};

  const links = ["plan", "build", "verify", "review", "accept"] as const;
  for (const link of links) {
    const taskDef = chainDef.tasks[link];
    if (!taskDef) continue;  // plan 可能为 null

    const task = await taskQueue.push({
      title: taskDef.title,
      description: taskDef.description,
      priority: taskDef.priority,
      link: link,
      chain_id: chainDef.chain_id,
      depends_on: link === "plan" ? [] : [taskIds[prevLink(link)]],
    });

    taskIds[link] = task.id;

    // 生成任务文档
    const docPath = path.join(cacheDir, leaderId, "tasks", `${task.id}.md`);
    const docContent = templateEngine.render("worker-task-doc.md", {
      task_title: taskDef.title,
      task_description: taskDef.description,
      task_criteria: taskDef.criteria,
      chain_id: chainDef.chain_id,
      link: link,
    });
    await fs.writeFile(docPath, docContent);

    // 更新任务 doc_path
    await taskQueue.update(task.id, { task_doc_path: docPath });
  }

  eventBus.emit({ type: "chain_activated", chainId: chainDef.chain_id });
}
```

## 8. 依赖映射规则

```
plan   → depends_on: []
build  → depends_on: [plan.id]      // plan 为 null 时 depends_on: []
verify → depends_on: [build.id]
review → depends_on: [verify.id]
accept → depends_on: [review.id]
```

`task_dependency_resolved` 事件在前置任务 `completed` 时触发。

## 9. 链路产出

| 产出 | 位置 | 说明 |
|------|------|------|
| 4-5 个 Task | `/tasks/pending/task-{seq}` | ZK PERSISTENT_SEQUENTIAL 节点 |
| 任务文档 | `cache_dir/{leader_id}/tasks/task-{seq}.md` | Markdown 任务描述文件 |
| chain_activated 事件 | LeaderEventBus → TUI | TUI EVENT LOG 显示链创建 |

## 10. 错误处理

| 场景 | 处理 |
|------|------|
| ChainDef JSON 解析失败 | 回退到自由文本分支（转发 Planner） |
| taskQueue.push 失败 | ZK 写入错误，重试 1 次后抛 `MESSAGE_DELIVERY_FAILED` |
| decompose 模板缺失 | 必须转发 Planner Worker |
| claude-cli decompose 失败 | 以 `debug_info` 事件通知 TUI，不创建任务 |
