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
  │ $COMMAND    │   │ worker.md │   │   → Worker       │
  │ -p | tee    │   │ template  │   │   → Leader       │
  │             │   │           │   │ complete-task    │
  │ leader.md   │   │           │   │ ...              │
  │ template    │   │           │   │                  │
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
// src/leader/event-bus.ts
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
  | { type: "message_sent"; from: string; to: string; type: MessageType };
```

TUI 订阅 Event Bus 以更新显示。

### Worker Monitor

```typescript
// src/leader/monitor.ts
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
// src/leader/orchestrator.ts
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

### Leader 消息收发 (全部通过 CLI + watcher)

Leader 不通过 TUI 发送消息。发送通过 CLI，接收通过 watcher：

**发送 (CLI send-message):**

```bash
# Leader (或其他任何人) 通过 CLI 向 Worker 发送消息
claude-orchestrator send-message --to-name Jerry --content \
  "请实现 POST /api/items 接口，任务文档: ./tasks/task-xxx.md"
```

**接收 (Leader Watcher):**

```typescript
// src/leader/watcher.ts — Leader watcher 与 Worker watcher 相同结构
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

    // 通知 TUI
    this.eventBus.emit({ type: "message_received", from: fromLabel, content: msg.content });

    // 执行处理
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
// src/leader/tui.ts
class LeaderTui {
  render(state: LeaderState): void {
    process.stdout.write("\x1b[2J\x1b[0;0H"); // 清屏
    this.renderTeamPanel(state.workers);        // 团队面板
    this.renderTaskPanels(state.tasks);          // 任务队列
    this.renderEventLog(state.events.slice(-20)); // 事件日志
    this.renderFooter(state.leader);             // 页脚 (ID, CACHE_DIR, Ctrl+C)
  }
}
```

### Leader 事件循环

Leader 无交互输入，仅监听 ZK 事件和 SIGINT：

```typescript
async function leaderLoop(leader: Leader, tui: LeaderTui): Promise<void> {
  // 订阅 EventBus，ZK 事件驱动 TUI 重绘
  leader.eventBus.on("*", (event) => {
    leader.state.apply(event);
    tui.render(leader.state);
  });

  // 初始渲染
  tui.render(leader.state);

  // 启动 watcher 监听 Leader 消息目录
  await leader.startWatcher();

  // 阻塞等待 SIGINT
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  await leader.shutdown();
}
```

### ZK Watch 生命周期

ZK Watch 是一次性的，每次触发后必须重建：

```typescript
async function persistentWatch<T>(
  zk: ZkClient,
  setupWatch: (callback: (data: T) => void) => Promise<T>,
  handler: (data: T) => Promise<void>
): Promise<void> {
  const callback = async (data: T) => {
    try { await handler(data); }
    finally { await setupWatch(callback); }
  };
  const initialData = await setupWatch(callback);
  await handler(initialData);
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
  ├─ 5. 加载 leader.md 模板
  ├─ 6. 初始化 EventBus
  ├─ 7. 启动 LeaderWatcher (watch /messages/{leader_id})
  ├─ 8. 启动 WorkerMonitor (watch /instances)
  ├─ 9. 启动 TaskOrchestrator (watch /tasks)
  ├─ 10. 初始化 TUI (只读: team panel + task panel + event log + footer)
  └─ 11. 阻塞等待 SIGINT (所有交互通过外部 CLI 完成)
```

## Worker Watcher 架构

```typescript
// src/worker/watcher.ts
class WorkerWatcher {
  private zk: ZkClient;
  private instance: Instance;
  private workDir: string;
  private command: string;      // 来自 config.command
  private cacheDir: string;     // 来自 config.cache_dir
  private leaderInstanceId: string;
  private inFlight: Set<string> = new Set();
  private stopped = false;

  async start(instance: Instance, workDir: string): Promise<void> {
    this.instance = instance;
    this.workDir = workDir;
    this.command = config.command;
    this.cacheDir = config.cache_dir;
    this.leaderInstanceId = await this.resolveLeaderInstanceId();

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
    const data = await this.zk.getMessage(this.instance.id, msgId);
    if (!data) return;
    const msg = MessageSchema.parse({ ...data, id: msgId });
    if (msg.read) return;

    this.inFlight.add(msgId);
    const fromLabel = msg.from_name || msg.from_instance?.slice(0, 8) || "unknown";

    // 生成唯一 key
    const uniqueKey = `${msg.type}-${msgId}-${Date.now().toString(36)}`;

    // 构建消息 (包含模板信息)
    const fullMessage = msg.content;

    console.log(`[${new Date().toLocaleTimeString()}] 📨 Message from ${fromLabel} (${msg.type})`);

    // 执行: $COMMAND -p "$MESSAGE" | tee $CACHE_DIR/{id}/{key}.log
    const cmd = `${this.command} -p ${escapeShell(fullMessage)}`;
    const logPath = path.join(this.cacheDir, this.leaderInstanceId, `${uniqueKey}.log`);

    console.log(`🔄 Executing: ${cmd}`);
    const { code, stdout, stderr } = await this.execWithTee(cmd, logPath);

    if (code === 0) {
      console.log(`✅ Done. Log: ${logPath}`);
    } else {
      console.error(`❌ Exited ${code}. Log: ${logPath}`);
    }

    // 标记已读
    await this.zk.updateMessage(this.instance.id, msgId, {
      ...msg as unknown as Record<string, unknown>, read: true,
    });
    this.inFlight.delete(msgId);
  }

  // 执行命令并同时写入终端和文件
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
        process.stdout.write(s);  // 终端输出
        logStream.write(s);       // 文件写入
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

### Worker 消息发送 (worker.md 模板)

Worker 发送消息时使用 `worker.md` 模板：

```typescript
async function sendWorkerMessage(targetName: string, content: string): Promise<void> {
  const template = await loadTemplate("worker.md");
  const uniqueKey = `reply-${Date.now().toString(36)}`;
  const resultPath = path.join(cacheDir, leaderInstanceId, `${uniqueKey}.log`);

  const message = template
    .replace("{{name}}", workerName)
    .replace("{{role}}", workerRole)
    .replace("{{time}}", new Date().toISOString())
    .replace("{{content}}", content)
    .replace("{{result_path}}", resultPath);

  // 可选: 通过 Claude 增强回复质量
  // const cmd = `${config.command} -p "Format this worker report: ${escapeShell(message)}"`;
  // const enhanced = await execAndCapture(cmd);

  await messageRouter.send(workerInstanceId, workerName, message, undefined, false, targetName);
}
```

## 任务状态机详细

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
                     │ heartbeat(current_task=...)
              ┌──────▼──────┐
              │ in_progress  │
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
| `claimed` | `in_progress` | `heartbeat(current_task=...)` | Worker 声明正在处理 |
| `in_progress` | `completed` | `complete_task` | claimed 节点归属校验通过 |
| `in_progress` | `blocked` | `task-block` | Worker 声明阻塞 |
| `in_progress` | `failed` | `task-fail` | Worker 声明失败 |
| `blocked` | `in_progress` | `heartbeat` 自动恢复 | 阻塞解除 |
| `blocked` | `pending` | `task-retry` | 重新入队 |
| `failed` | `pending` | `task-retry` | 重新入队，retry_count++ |
| `claimed` | `pending` | Worker 断开 (ZK session timeout) | Leader 回收孤儿任务 |
| `in_progress` | `pending` | Worker 断开 | Leader 回收孤儿任务 |

### 孤儿任务回收

```
recoverOrphanedTask(workerId, taskId):
  1. 从 claimed 节点提取 task_data
  2. 保留: title, description, priority, assigned_to, created_by
  3. status = "pending", retry_count += 1
  4. 若 retry_count > MAX_RETRIES (默认 3):
     → 创建 /tasks/completed/{taskId} 标记为 failed
  5. 否则:
     → 创建 /tasks/pending/{taskId} (新 sequential 编号)
```

## CLI 命令执行流程

所有 CLI 命令（除 `leader` 和 `register --work-dir`）都是短期进程：

```
claude-orchestrator push-task --title "..." --assignee Jerry
  → withZk(hosts, async ({ taskQueue }) => taskQueue.push(...))
  → 创建 ZK 节点 /tasks/pending/task-{seq}
  → 输出 JSON → disconnect → exit
```

### setup 命令

```
claude-orchestrator setup --leader --name Tom
  → 创建 .claude-orchestrator/agents/leader.md
  → 创建 .claude-orchestrator/agents/worker.md
  → 写入 .claude-orchestrator/config.json: {"name":"Tom","role":"leader"}
  → 写入 ~/.claude-orchestrator/config.json: {"command":"...","cache_dir":"..."}
  → exit

claude-orchestrator setup --name Jerry --role developer
  → 创建 .claude-orchestrator/agents/leader.md
  → 创建 .claude-orchestrator/agents/worker.md
  → 写入 .claude-orchestrator/config.json: {"name":"Jerry","role":"developer"}
  → exit
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

## CACHE_DIR 共享目录设计

### 目录结构

```
~/.claude-orchestrator/sessions/        ← config.cache_dir 默认值
├── {leader_instance_id}/               ← Leader 实例 ID
│   ├── tasks/                          ← 任务文档 (leader.md 生成的 .md)
│   │   └── task-0000000001.md          ← Worker 读取的任务详细说明
│   ├── msg-abc123-20260511T103000.log  ← 消息处理日志
│   ├── task-0000000001-xxx_result.log  ← Worker 执行结果日志
│   └── reply-def456-20260511T110000.log
```

### 路径约定

- Leader 写入任务文档到 `sessions/{id}/tasks/{task_id}.md`，消息中使用相对路径 `./tasks/{task_id}.md`
- Worker 执行日志写入 `sessions/{id}/{uniqueKey}.log`
- Worker 回复消息中的 `result_path` 使用相对路径引用日志文件
