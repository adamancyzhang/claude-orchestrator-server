# v0.3.0 架构细节

## 组件交互图

```
┌─────────────────────────────────────────────────────────────────┐
│                        ZooKeeper                                │
│                                                                 │
│  /leader [EPH]    /instances/* [EPH]   /tasks/*    /messages/* │
│  /context/*                                                     │
└──────┬─────────────────┬─────────────────┬─────────────────────┘
       │                 │                 │
       │           ┌─────┴─────┐           │
       │           │  Member   │           │
       │           │  Watcher  │           │
       │           │           │           │
       │           │ - ZK Watch│           │
       │           │ - spawn   │           │
       │           │   claude  │           │
       │           │   -p ...  │           │
       │           └───────────┘           │
       │                                   │
  ┌────┴──────────────────────────────┐    │
  │            Leader Node            │    │
  │                                   │    │
  │  ┌─────────────────────────────┐  │    │
  │  │           TUI               │  │    │
  │  │  ┌─────────┐ ┌───────────┐  │  │    │
  │  │  │ Team    │ │ Task      │  │  │    │
  │  │  │ Panel   │ │ Panels    │  │  │    │
  │  │  ├─────────┤ └───────────┘  │  │    │
  │  │  │ Event   │                │  │    │
  │  │  │ Log     │                │  │    │
  │  │  ├─────────┤                │  │    │
  │  │  │ Command │                │  │    │
  │  │  │ Input   │                │  │    │
  │  │  └─────────┘                │  │    │
  │  └──────────────┬──────────────┘  │    │
  │                 │                  │    │
  │  ┌──────────────┴──────────────┐  │    │
  │  │     Event Bus               │  │    │
  │  │  (internal pub/sub)         │  │    │
  │  └──────┬──────────┬───────────┘  │    │
  │         │          │               │    │
  │  ┌──────┴──┐ ┌─────┴──────┐       │    │
  │  │ Member  │ │ Task       │       │    │
  │  │ Monitor │ │ Orchestr.  │       │    │
  │  └────┬────┘ └─────┬──────┘       │    │
  │       │            │               │    │
  │  ┌────┴────────────┴──────────┐   │    │
  │  │     ZK Watch Manager       │   │    │
  │  │  - watch registration      │   │    │
  │  │  - one-shot renewal        │   │    │
  │  │  - session handling        │   │    │
  │  └─────────────┬──────────────┘   │    │
  │                │                   │    │
  │  ┌─────────────┴──────────────┐   │    │
  │  │   ZK Client (persistent)   │   │    │
  │  │   - connection lifecycle   │   │    │
  │  │   - CRUD operations        │   │    │
  │  │   - auto-reconnect         │   │    │
  │  └────────────────────────────┘   │    │
  └───────────────────────────────────┘    │
                                           │
                              ┌────────────┴────────────┐
                              │   CLI (one-shot)        │
                              │                         │
                              │   push-task, send-msg,  │
                              │   set-context, etc.     │
                              │   (each creates temp    │
                              │    ZK connection)       │
                              └─────────────────────────┘
```

## Leader 内部架构

### Event Bus

Leader 内部使用轻量级 EventEmitter 实现事件驱动：

```typescript
// src/leader/event-bus.ts
type LeaderEvent =
  | { type: "member_joined"; instance: Instance }
  | { type: "member_left"; instanceId: string; name: string }
  | { type: "member_status_changed"; instanceId: string; status: string }
  | { type: "task_created"; task: Task }
  | { type: "task_claimed"; taskId: string; instanceId: string }
  | { type: "task_completed"; taskId: string; instanceId: string }
  | { type: "task_blocked"; taskId: string; reason: string }
  | { type: "task_failed"; taskId: string; reason: string }
  | { type: "task_recovered"; taskId: string }  // 孤儿任务回收
  | { type: "message_sent"; from: string; to: string; type: MessageType }
  | { type: "context_changed"; key: string };
```

TUI 订阅 Event Bus 以更新显示，Orchestrator 订阅以触发自动化逻辑。

### Member Monitor

```typescript
// src/leader/monitor.ts
class MemberMonitor {
  async start(): Promise<void> {
    // 1. 初始加载所有活跃成员
    const children = await this.zk.getChildrenWithWatch(
      paths.INSTANCES,
      (newChildren) => this.onChildrenChanged(newChildren)
    );

    // 2. 为每个成员设置 DataWatch 监听状态变化
    for (const id of children) {
      this.watchMemberData(id);
    }

    // 3. 通知 TUI
    this.emit("member_list_updated", children);
  }

  private async onChildrenChanged(children: string[]): Promise<void> {
    // 检测新加入和离开的成员
    const prev = this.knownInstances;
    const curr = new Set(children);

    for (const id of curr) {
      if (!prev.has(id)) {
        const inst = await this.zk.getInstance(id);
        this.eventBus.emit({ type: "member_joined", instance: inst });
        this.watchMemberData(id);
      }
    }

    for (const id of prev) {
      if (!curr.has(id)) {
        const name = this.instanceNames.get(id) ?? id.slice(0, 8);
        this.eventBus.emit({ type: "member_left", instanceId: id, name });
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
    // 1. 监听 pending 任务变化
    this.zk.getChildrenWithWatch(paths.TASKS_PENDING, (children) => {
      for (const id of diff(children, this.knownPending)) {
        const task = await this.zk.getPendingTask(id);
        this.eventBus.emit({ type: "task_created", task });
      }
    });

    // 2. 监听 claimed 任务变化 (含孤儿检测)
    this.zk.getChildrenWithWatch(paths.TASKS_CLAIMED, (children) => {
      for (const id of diff(this.knownClaimed, children)) {
        // 节点被删除 → 可能是任务完成或实例断连
        const [insId, taskId] = parseClaimedNodeName(id);
        const instExists = await this.zk.exists(paths.instancePath(insId));
        if (!instExists) {
          // 实例已离线 → 孤儿任务，重新入队
          await this.recoverOrphanedTask(insId, taskId);
        }
      }
    });
  }

  private async recoverOrphanedTask(
    instanceId: string,
    taskId: string
  ): Promise<void> {
    // 1. 读取 claimed 节点中的任务数据
    const taskData = await this.zk.getClaimedTask(instanceId, taskId);

    // 2. 重新写入 /tasks/pending，保留原始 priority 和 assigned_to
    taskData.status = "pending";
    taskData.retry_count = (taskData.retry_count ?? 0) + 1;
    await this.zk.createPendingTask(taskData);

    // 3. 通知 TUI
    this.eventBus.emit({ type: "task_recovered", taskId });
  }
}
```

### ZK Watch 生命周期

ZK Watch 是一次性的，每次触发后必须重建。Leader 使用统一的 Watch 管理策略：

```typescript
// 递归 Watch 模式
async function persistentWatch<T>(
  zk: ZkClient,
  setupWatch: (callback: (data: T) => void) => Promise<T>,
  handler: (data: T) => Promise<void>
): Promise<void> {
  const callback = async (data: T) => {
    try {
      await handler(data);
    } finally {
      // 重建 Watch (递归)
      await setupWatch(callback);
    }
  };

  // 初始设置
  const initialData = await setupWatch(callback);
  await handler(initialData);
}
```

### Leader 启动时序

```
startLeader(config)
  │
  ├─ 1. zk.connect()
  │     └─ _ensurePaths() 创建 ZK 节点树
  │
  ├─ 2. zk.create("/leader", EPHEMERAL)
  │     └─ 失败 → "Another leader is already running" → 退出
  │
  ├─ 3. 初始化 EventBus
  │
  ├─ 4. 启动 Monitor
  │     ├─ watch /instances (ChildWatch)
  │     └─ 对每个已有实例设置 DataWatch
  │
  ├─ 5. 启动 TaskOrchestrator
  │     ├─ watch /tasks/pending (ChildWatch)
  │     ├─ watch /tasks/claimed (ChildWatch)
  │     └─ 扫描已存在的孤儿任务
  │
  ├─ 6. 启动 MessageMonitor (可选)
  │     └─ watch 所有 /messages/* 目录 (仅计数，不读取内容)
  │
  ├─ 7. 初始化 TUI
  │     ├─ 渲染初始界面
  │     ├─ 订阅 EventBus
  │     └─ 启动 stdin 输入处理
  │
  └─ 8. 进入事件循环 (等待 SIGINT)
        └─ SIGINT → zk.remove("/leader") → zk.disconnect() → process.exit(0)
```

## Member Watcher 架构

```typescript
// src/member/watcher.ts
class MemberWatcher {
  private zk: ZkClient;
  private instance: Instance;
  private workDir: string;
  private inFlight: Set<string> = new Set();
  private stopped = false;

  async start(instance: Instance, workDir: string): Promise<void> {
    this.instance = instance;
    this.workDir = workDir;

    // 确保消息目录存在
    await this.zk.mkdirp(paths.messageDirPath(instance.id));

    // 启动消息监听循环
    this.watchLoop();
  }

  private async watchLoop(): Promise<void> {
    if (this.stopped) return;

    const children = await this.zk.watchMessageDir(
      this.instance.id,
      (newChildren) => {
        for (const cid of newChildren) {
          this.processMessage(cid);
        }
        this.watchLoop(); // 递归重建 Watch
      }
    );

    // 处理初始消息 (可能是在离线期间收到的)
    for (const cid of children) {
      await this.processMessage(cid);
    }
  }

  private async processMessage(msgId: string): Promise<void> {
    if (this.inFlight.has(msgId)) return;

    const data = await this.zk.getMessage(this.instance.id, msgId);
    if (!data) return;

    const msg = MessageSchema.parse({ ...data, id: msgId });
    if (msg.read) return;

    this.inFlight.add(msgId);

    const fromLabel = msg.from_name || msg.from_instance?.slice(0, 8) || "unknown";
    const timestamp = new Date().toLocaleTimeString();

    // 打印消息
    console.log(`[${timestamp}] 📨 Message from ${fromLabel} (${msg.type}):`);
    console.log(`  ${msg.content}\n`);

    // 调用 claude -p 处理
    const prompt = `[${msg.type} from ${fromLabel}] ${msg.content}`;
    console.log(`[${timestamp}] 🔄 Processing with claude -p...`);

    const { code, stdout, stderr } = await spawnClaude(
      this.instance.id,
      prompt,
      this.workDir
    );

    if (code === 0) {
      console.log(`[${timestamp}] ✅ Response:`);
      console.log(`  ${stdout.slice(0, 2000)}\n`);
    } else {
      console.error(`[${timestamp}] ❌ claude exited ${code}\n`);
      if (stderr) console.error(`  stderr: ${stderr.slice(0, 500)}\n`);
    }

    // 标记已读
    await this.zk.updateMessage(this.instance.id, msgId, {
      ...msg as unknown as Record<string, unknown>,
      read: true,
    });

    this.inFlight.delete(msgId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function spawnClaude(
  sessionId: string,
  prompt: string,
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--session-id", sessionId, "-p", prompt], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
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
                    │    task-retry (重新入队 pending)
                    │         │
                    └────┬────┘
                         │
                    ┌────▼────┐
                    │ pending  │ (retry_count++)
                    └─────────┘
```

### 转换规则

| 从 | 到 | 触发方式 | 条件 |
|----|----|---------|------|
| (none) | `pending` | `push_task` | — |
| `pending` | `claimed` | `claim_task` | EPHEMERAL create 成功 |
| `claimed` | `in_progress` | `heartbeat(current_task=...)` | 实例声明正在处理该任务 |
| `in_progress` | `completed` | `complete_task` | claimed 节点归属校验通过 |
| `in_progress` | `blocked` | `task-block` | 实例声明任务被阻塞 |
| `in_progress` | `failed` | `task-fail` | 实例声明任务失败 |
| `blocked` | `in_progress` | `heartbeat` 自动恢复 | 阻塞解除 |
| `blocked` | `pending` | `task-retry` | 重新入队 |
| `failed` | `pending` | `task-retry` | 重新入队，retry_count++ |
| `claimed` | `pending` | 实例断开 (ZK session timeout) | Leader 回收孤儿任务 |
| `in_progress` | `pending` | 实例断开 (ZK session timeout) | Leader 回收孤儿任务 |
| `blocked` | `pending` | 实例断开 (ZK session timeout) | Leader 回收孤儿任务 |

### 孤儿任务回收

当 Leader 检测到 `/tasks/claimed/{insId}-{taskId}` 节点被删除，但 `/instances/{insId}` 已不存在时：

```
recoverOrphanedTask(instanceId, taskId):
  1. 从 deleted claimed 节点中提取任务数据
  2. 保留原始: title, description, priority, assigned_to, created_by
  3. 设置 status = "pending"
  4. retry_count = (original.retry_count ?? 0) + 1
  5. 若 retry_count > MAX_RETRIES (默认 3):
     → 创建 /tasks/completed/{taskId} 标记为 failed (永不重试)
     → 通知 Leader TUI
  6. 否则:
     → 创建 /tasks/pending/{taskId} (新 sequential 编号)
     → 通知 Leader TUI
```

## CLI 命令执行流程

### 无 Leader 依赖的命令

大部分 CLI 命令都可以独立运行，不需要 Leader 在线：

```
claude-orchestrator push-task --title "..." --assignee Jerry
  → withZk(hosts, async ({ taskQueue }) => {
       return taskQueue.push(title, description, priority, createdBy, assignee);
     })
  → 创建 ZK 节点 /tasks/pending/task-{seq}
  → 输出 JSON → disconnect → exit
```

所有 CLI 命令（除 `leader` 和 `register --work-dir`）都是短期进程：
1. 连接 ZK (`ZkClient.connect()`)
2. 执行操作
3. 输出 JSON 结果
4. 断开 ZK
5. 退出

### register 的两种模式

```
Mode 1: register --work-dir <dir> (长期运行)
  → ZkClient.connect()  (保持连接)
  → registry.register(name, role)
  → saveInstanceId(id)
  → memberWatcher.start(instance, workDir)  (阻塞，有 ZK Watch)
  → SIGINT → registry.unregister() → zk.disconnect() → exit

Mode 2: register (单次)
  → withZk(hosts, async ({ registry }) => {
       return registry.register(name, role);
     })
  → saveInstanceId(id)
  → output(instance)
  → exit
  (不需要 workDir，仅注册身份)
```

### Leader 命令

```
claude-orchestrator leader
  → ZkClient.connect()  (保持连接)
  → create /leader EPHEMERAL
  → 启动所有 Monitor (长期 Watch)
  → 初始化 TUI
  → 事件循环 (阻塞)
  → SIGINT → 清理 /leader → zk.disconnect() → exit
```

## 错误处理与恢复

### ZK 连接断开

| 场景 | Leader 行为 | Member 行为 |
|------|-----------|------------|
| ZK 临时断开 (网络抖动) | `ZkClient` 自动重连，恢复后重建 Watch | 同 Leader |
| ZK Session 超时 | `/leader` 节点丢失 → 进程退出，需手动重启 | `/instances/{id}` 丢失 → watcher 检测后重新注册 |
| ZK 集群完全不可用 | 所有操作阻塞等待重连 | `claude -p` 调用失败但不崩溃 |

### Leader 崩溃

```
Leader 进程退出
  → /leader 临时节点自动删除
  → 所有 Member 不受影响 (各自直连 ZK)
  → 任务状态机正常运转
  → 唯一损失: 孤儿任务回收暂停 (直到 Leader 重启)

Leader 重启
  → 扫描 /instances 和 /tasks 重建状态
  → 回收孤儿任务
  → 继续正常监控
```

### Member 崩溃

```
Member 进程退出
  → /instances/{id} ZK Session 超时后自动删除
  → /tasks/claimed/{id}-* 自动删除
  → Leader Watch 触发 → 回收孤儿任务
  → 其他 Member 不受影响
```

## TUI 实现策略

使用 Node.js 内置 `readline` + ANSI 转义序列，无需额外依赖：

```typescript
// TUI 渲染核心
class LeaderTui {
  private screenHeight: number;
  private screenWidth: number;

  // 重绘整个屏幕
  render(state: LeaderState): void {
    // 清屏
    process.stdout.write("\x1b[2J\x1b[0;0H");

    // 渲染团队面板
    this.renderTeamPanel(state.instances);

    // 渲染任务面板 (左侧 pending, 右侧 claimed)
    this.renderTaskPanels(state.tasks);

    // 渲染事件日志 (最近 20 条)
    this.renderEventLog(state.events.slice(-20));

    // 渲染命令输入行
    this.renderCommandInput();
  }

  // 从 stdin 读取命令
  async readCommand(): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin });
    return new Promise((resolve) => {
      rl.question("> ", (cmd) => {
        rl.close();
        resolve(cmd);
      });
    });
  }
}
```

### TUI 事件循环

```typescript
async function tuiLoop(leader: Leader, tui: LeaderTui): Promise<void> {
  // 订阅 EventBus
  leader.eventBus.on("*", (event) => {
    leader.state.apply(event);  // 更新状态
    tui.render(leader.state);   // 重绘界面
  });

  // 初始渲染
  tui.render(leader.state);

  // 命令处理循环
  while (true) {
    const cmd = await tui.readCommand();
    if (cmd === "quit" || cmd === "exit") break;
    await leader.handleCommand(cmd);
    tui.render(leader.state);
  }
}
```
