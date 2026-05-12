# v0.3.0 架构细节

## 组件交互图

```
┌──────────────────────────────────────────────────────────────────────┐
│                          ZooKeeper                                   │
│  /leader [EPH]    /instances/* [EPH]   /tasks/*    /messages/*      │
└──────┬──────────────────┬──────────────────┬────────────────────────┘
       │                  │                  │
  ┌────┴────────┐   ┌─────┴─────┐   ┌───────┴──────────┐
  │ Leader Node │   │ Worker A  │   │ CLI (message     │
  │             │   │           │   │   entry point)   │
  │ TUI (read-  │   │ watcher   │   │                  │
  │  only)      │   │ $COMMAND  │   │ push-task        │
  │             │   │ -p | tee  │   │ claim-task       │
  │ watcher     │   │           │   │ send-message     │
  │ $COMMAND    │   │ per-link  │   │   → Worker       │
  │ -p | tee    │   │ template  │   │   → Leader       │
  │             │   │           │   │ complete-task    │
  │ leader.md   │   │           │   │ ...              │
  │ templates   │   │           │   │                  │
  └─────┬───────┘   └─────┬─────┘   └──────────────────┘
        │                 │
        └────────┬────────┘
                 │
        ┌────────┴────────┐
        │   $CACHE_DIR    │
        │  (共享文件系统)   │
        │  sessions/{id}/ │
        │  ├── tasks/*.md │
        │  └── *.log      │
        └─────────────────┘
```

## Leader 内部架构

### Event Bus

Leader 内部使用轻量级 EventEmitter 实现事件驱动：

```typescript
type LeaderEvent =
  | { type: "worker_joined"; instance: Instance }
  | { type: "worker_left"; instanceId: string; name: string }
  | { type: "worker_status_changed"; instanceId: string; status: string }
  | { type: "task_created"; task: Task }
  | { type: "task_claimed"; taskId: string; instanceId: string }
  | { type: "task_completed"; taskId: string; instanceId: string }
  | { type: "task_blocked"; taskId: string; reason: string }
  | { type: "task_failed"; taskId: string; reason: string }
  | { type: "task_recovered"; taskId: string }
  | { type: "message_sent"; from: string; to: string; type: MessageType }
  | { type: "message_received"; from: string; content: string }
  | { type: "message_processed"; msgId: string; logPath: string }
  | { type: "chain_activated"; chainId: string }
  | { type: "task_dependency_resolved"; taskId: string };
```

TUI 订阅 EventBus 以更新显示。

### Worker Monitor

```typescript
class WorkerMonitor {
  async start(): Promise<void> {
    const children = await this.zk.getChildrenWithWatch(
      paths.INSTANCES,
      (newChildren) => this.onChildrenChanged(newChildren)
    );
    for (const id of children) {
      this.watchWorkerData(id);
    }
  }

  private async onChildrenChanged(children: string[]): Promise<void> {
    const prev = this.knownInstances;
    const curr = new Set(children);
    for (const id of curr) {
      if (!prev.has(id)) {
        const inst = await this.zk.getInstance(id);
        this.eventBus.emit({ type: "worker_joined", instance: inst });
        this.watchWorkerData(id);
      }
    }
    for (const id of prev) {
      if (!curr.has(id)) {
        const name = this.instanceNames.get(id) ?? id.slice(0, 8);
        this.eventBus.emit({ type: "worker_left", instanceId: id, name });
      }
    }
    this.knownInstances = curr;
  }
}
```

### Task Orchestrator

```typescript
class TaskOrchestrator {
  async start(): Promise<void> {
    this.zk.getChildrenWithWatch(paths.TASKS_PENDING, (children) => {
      for (const id of diff(children, this.knownPending)) {
        const task = await this.zk.getPendingTask(id);
        this.eventBus.emit({ type: "task_created", task });
      }
    });

    this.zk.getChildrenWithWatch(paths.TASKS_CLAIMED, (children) => {
      for (const id of diff(this.knownClaimed, children)) {
        const [insId, taskId] = parseClaimedNodeName(id);
        const instExists = await this.zk.exists(paths.instancePath(insId));
        if (!instExists) {
          await this.recoverOrphanedTask(insId, taskId);
        }
      }
    });
  }

  private async recoverOrphanedTask(instanceId: string, taskId: string): Promise<void> {
    const taskData = await this.zk.getClaimedTask(instanceId, taskId);
    taskData.status = "pending";
    taskData.retry_count = (taskData.retry_count ?? 0) + 1;
    await this.zk.createPendingTask(taskData);
    this.eventBus.emit({ type: "task_recovered", taskId });
  }
}
```

### Leader 消息收发

发送通过 CLI，接收通过 watcher：

**接收 (Leader Watcher):**

```typescript
class LeaderWatcher {
  async start(): Promise<void> {
    await this.zk.mkdirp(paths.messageDirPath(this.leaderInstanceId));
    this.watchLoop();
  }

  private async watchLoop(): Promise<void> {
    if (this.stopped) return;
    const children = await this.zk.watchMessageDir(
      this.leaderInstanceId,
      (newChildren) => {
        for (const cid of newChildren) this.processMessage(cid);
        this.watchLoop();
      }
    );
    for (const cid of children) await this.processMessage(cid);
  }

  private async processMessage(msgId: string): Promise<void> {
    if (this.inFlight.has(msgId)) return;
    const data = await this.zk.getMessage(this.leaderInstanceId, msgId);
    if (!data) return;
    const msg = MessageSchema.parse({ ...data, id: msgId });
    if (msg.read) return;

    this.inFlight.add(msgId);
    const fromLabel = msg.from_name || msg.from_instance?.slice(0, 8) || "unknown";
    const uniqueKey = `msg-${msgId}-${Date.now().toString(36)}`;

    this.eventBus.emit({ type: "message_received", from: fromLabel, content: msg.content });

    const logPath = path.join(this.cacheDir, this.leaderInstanceId, `${uniqueKey}.log`);
    const cmd = `${this.command} -p ${escapeShell(msg.content)}`;
    const { code } = await this.execWithTee(cmd, logPath);

    if (code === 0) {
      this.eventBus.emit({ type: "message_processed", msgId, logPath });
    }

    await this.zk.updateMessage(this.leaderInstanceId, msgId, {
      ...msg as unknown as Record<string, unknown>, read: true,
    });
    this.inFlight.delete(msgId);
  }
}
```

### TUI 架构 (只读显示)

Leader TUI 纯只读显示，无命令输入。使用 Node.js 内置 ANSI 转义序列。

```typescript
class LeaderTui {
  render(state: LeaderState): void {
    process.stdout.write("\x1b[2J\x1b[0;0H"); // 清屏
    this.renderTeamPanel(state.workers);        // 团队面板
    this.renderTaskPanels(state.tasks);          // 任务队列
    this.renderEventLog(state.events.slice(-20)); // 事件日志
    this.renderFooter(state.leader);             // 页脚
  }
}
```

### Leader 事件循环

Leader 无交互输入，仅监听 ZK 事件和 SIGINT：

```typescript
async function leaderLoop(leader: Leader, tui: LeaderTui): Promise<void> {
  leader.eventBus.on("*", (event) => {
    leader.state.apply(event);
    tui.render(leader.state);
  });

  tui.render(leader.state);
  await leader.startWatcher();

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  await leader.shutdown();
}
```

### Leader 启动时序

```
startLeader(config)
  ├─ 1. zk.connect()
  │     └─ _ensurePaths() 创建 ZK 节点树
  ├─ 2. zk.create("/leader", EPHEMERAL)
  │     └─ 失败 → "Another leader is already running" → 退出
  ├─ 3. 注册自身 Instance (role=leader)，获得 instance_id
  ├─ 4. 初始化 CACHE_DIR/{instance_id}/
  ├─ 5. 加载 leader-decompose.md 和 leader-decide.md 模板
  ├─ 6. 初始化 EventBus
  ├─ 7. 启动 LeaderWatcher (watch /messages/{leader_id})
  ├─ 8. 启动 WorkerMonitor (watch /instances)
  ├─ 9. 启动 TaskOrchestrator (watch /tasks)
  ├─ 10. 初始化 TUI (只读: team panel + task panel + event log + footer)
  └─ 11. 阻塞等待 SIGINT (所有交互通过外部 CLI 完成)
```

## Worker Watcher 架构

```typescript
class WorkerWatcher {
  private zk: ZkClient;
  private instance: Instance;
  private workDir: string;
  private command: string;
  private cacheDir: string;
  private leaderInstanceId: string;
  private inFlight: Set<string> = new Set();
  private stopped = false;
  private templates: Record<string, string> = {};

  async start(instance: Instance, workDir: string): Promise<void> {
    this.instance = instance;
    this.workDir = workDir;
    this.command = config.command;
    this.cacheDir = config.cache_dir;
    this.leaderInstanceId = await this.resolveLeaderInstanceId();

    // 加载五个 link 模板
    this.templates = {
      plan:   await this.loadTemplate("worker-plan.md"),
      build:  await this.loadTemplate("worker-build.md"),
      verify: await this.loadTemplate("worker-verify.md"),
      review: await this.loadTemplate("worker-review.md"),
      accept: await this.loadTemplate("worker-accept.md"),
    };

    await this.zk.mkdirp(paths.messageDirPath(instance.id));
    this.watchLoop();
  }

  private async watchLoop(): Promise<void> {
    if (this.stopped) return;
    const children = await this.zk.watchMessageDir(
      this.instance.id,
      (newChildren) => {
        for (const cid of newChildren) this.processMessage(cid);
        this.watchLoop();
      }
    );
    for (const cid of children) await this.processMessage(cid);
  }

  private async processMessage(msgId: string): Promise<void> {
    if (this.inFlight.has(msgId)) return;
    const msg = await this.zk.getMessage(this.instance.id, msgId);
    if (!msg || msg.read) return;

    this.inFlight.add(msgId);

    const link = msg.link || "build";
    const template = this.templates[link];
    if (!template) {
      console.error(`Unknown link: ${link}, skipping message`);
      await this.zk.markMessageRead(this.instance.id, msgId);
      this.inFlight.delete(msgId);
      return;
    }

    const uniqueKey = `task-${msg.task_id || msgId}-${Date.now().toString(36)}`;
    const logPath = path.join(this.cacheDir, this.leaderInstanceId, `${uniqueKey}.log`);
    const resultPath = path.join(this.cacheDir, this.leaderInstanceId, `${uniqueKey}-result.md`);

    // 读取任务文档
    const taskDoc = msg.task_doc_path
      ? await fs.readFile(path.join(this.cacheDir, this.leaderInstanceId, msg.task_doc_path), "utf-8")
      : msg.content;

    // 读取上游产出
    const upstreamContext = await this.readUpstreamOutputs(msg);

    // 构建执行 prompt
    const prompt = template
      .replace("{{name}}", this.instance.name)
      .replace("{{preset_role}}", this.instance.role)
      .replace("{{task_title}}", msg.task_title || "")
      .replace("{{task_description}}", msg.task_description || taskDoc)
      .replace("{{task_criteria}}", msg.task_criteria || "")
      .replace("{{task_doc_path}}", msg.task_doc_path || "")
      .replace("{{result_path}}", resultPath)
      .replace("{{work_dir}}", this.workDir)
      .replace("{{time}}", new Date().toISOString());

    // 执行
    console.log(`[${new Date().toLocaleTimeString()}] Executing as ${link}: ${msg.task_title}`);
    const { code } = await this.execWithTee(
      `${this.command} -p ${escapeShell(prompt)}`,
      logPath
    );

    // 发送完成报告给 Leader
    if (code === 0) {
      await this.zk.sendMessage(this.instance.id, this.instance.name,
        [
          `Link: ${link}`,
          `Status: completed`,
          `Result Path: ${resultPath}`,
          `Task completed. Leader, please review and decide next step.`,
        ].join("\n"),
        this.leaderInstanceId);
      console.log(`Done. Report sent to Leader.`);
    }

    await this.zk.markMessageRead(this.instance.id, msgId);
    this.inFlight.delete(msgId);
  }

  private async execWithTee(cmd: string, logPath: string): Promise<ExecResult> {
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    const logStream = fs.createWriteStream(logPath);

    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", cmd], {
        cwd: this.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "", stderr = "";
      child.stdout?.on("data", (d: Buffer) => {
        const s = d.toString();
        stdout += s;
        process.stdout.write(s);
        logStream.write(s);
      });
      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        process.stderr.write(s);
        logStream.write(s);
      });
      child.on("exit", (code) => {
        logStream.end();
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.on("error", (err) => {
        logStream.end();
        resolve({ code: -1, stdout, stderr: err.message });
      });
    });
  }

  async stop(): Promise<void> { this.stopped = true; }
}
```

## 任务状态机

### 状态转换

```
                  push_task
                     │
              ┌──────▼──────┐
              │   pending    │
              └──────┬──────┘
                     │ claim_task (原子 EPHEMERAL create)
              ┌──────▼──────┐
              │   claimed    │
              └──────┬──────┘
          ┌──────────┼──────────┐
          │          │          │
   ┌──────▼───┐ ┌───▼────┐ ┌──▼──────┐
   │ completed │ │blocked │ │ failed  │
   └──────────┘ └───┬────┘ └──┬──────┘
                    │         │
                    └────┬────┘
                         │ task-retry → pending (retry_count++)
                    ┌────▼────┐
                    │ pending  │
                    └─────────┘
```

### 转换规则

| 从 | 到 | 触发方式 | 条件 |
|----|----|---------|------|
| (none) | `pending` | `push_task` | — |
| `pending` | `claimed` | `claim_task` | EPHEMERAL create 成功 |
| `claimed` | `completed` | `complete_task` | claimed 节点归属校验通过 |
| `claimed` | `blocked` | `task-block` | Worker 声明阻塞 |
| `claimed` | `failed` | `task-fail` | Worker 声明失败 |
| `failed` | `pending` | `task-retry` | 重新入队，retry_count++ |
| `claimed` | `pending` | Worker 断开 (ZK session timeout) | Leader 回收孤儿任务 |

### 孤儿任务回收

```
recoverOrphanedTask(workerId, taskId):
  1. 从 claimed 节点提取 task_data
  2. 保留: title, description, priority, link, chain_id, assigned_to, created_by
  3. status = "pending", retry_count += 1
  4. 若 retry_count > MAX_RETRIES (默认 3):
     → 创建 /tasks/completed/{taskId} 标记为 failed
  5. 否则:
     → 创建 /tasks/pending/{taskId} (新 sequential 编号)
```

## CLI 命令执行流程

所有 CLI 命令（除 `leader` 和 `register`）都是短期进程：

```
claude-orchestrator push-task --title "..." --assignee Jerry
  → withZk(hosts, async ({ taskQueue }) => taskQueue.push(...))
  → 创建 ZK 节点 /tasks/pending/task-{seq}
  → 输出 JSON → disconnect → exit
```

## 错误处理与恢复

### ZK 连接断开

| 场景 | Leader 行为 | Worker 行为 |
|------|-----------|------------|
| ZK 临时断开 | `ZkClient` 自动重连，恢复后重建 Watch | 同 Leader |
| ZK Session 超时 | `/leader` 节点丢失 → 进程退出 | `/instances/{id}` 丢失 → watcher 重新注册 |
| ZK 集群不可用 | 阻塞等待重连 | `$COMMAND -p` 调用失败但不崩溃 |

### Leader 崩溃

```
Leader 退出 → /leader EPHEMERAL 删除 → Worker 不受影响
新 Leader 启动 → 扫描 /instances, /tasks → 回收孤儿任务 → 正常监控
```

### Worker 崩溃

```
Worker 退出 → /instances/{id} 超时删除 → /tasks/claimed/{id}-* 自动删除
Leader Watch 触发 → 回收孤儿任务 → 其他 Worker 不受影响
```

## CACHE_DIR 共享目录

### 目录结构

```
~/.claude-orchestrator/sessions/        ← config.cache_dir 默认值
├── {leader_instance_id}/               ← Leader 实例 ID
│   ├── tasks/                          ← 任务文档
│   │   └── task-0000000001.md
│   ├── msg-abc123-20260511T103000.log  ← 消息处理日志
│   ├── task-0000000001-xxx.log         ← Worker 执行日志
│   ├── task-0000000001-result.md       ← Worker 产出
│   └── reply-def456-xxx.log
```

### 路径约定

- Leader 写入任务文档到 `sessions/{id}/tasks/{task_id}.md`，消息中使用相对路径 `./tasks/{task_id}.md`
- Worker 执行日志写入 `sessions/{id}/{uniqueKey}.log`
- Worker 回复消息中的 `result_path` 使用相对路径引用日志文件
