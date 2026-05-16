# Architecture — v0.6 架构总览

> **文档定位**：描述 Leader、Worker、Orchestrator 三大组件的内部架构，包括组件交互、事件总线、状态机、Watch 策略。
> 核心链路的数据流详见 `core/` 目录；ZK 节点定义详见 `zk-schema.md`；类型定义详见 `contracts.md`。

## 1. 组件交互图

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                                   ZooKeeper                                     │
│                                                                                 │
│ /leader [EPH]    /instances/* [EPH]    /tasks/{pending,claimed,completed}      │
│                                            /messages/{instance_id}/msg-* [SEQ]  │
└───┬─────────────────────┬───────────────────────┬───────────────────────────────┘
    │ Watch               │ Watch                 │ Watch
    ▼                     ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Leader 主进程                                                                  │
│                                                                                │
│  WorkerMonitor      TaskOrchestrator      LeaderWatcher       Recovery        │
│  /instances Watch   /tasks/{pending,      /messages/{leader_  启动时扫描       │
│                      claimed} Watch        id} Watch          孤儿 /tasks/    │
│       │                  │                      │              claimed         │
│       ▼                  ▼                      ▼                              │
│   ┌────────────────────────────────────┐     ChainRouter                       │
│   │       LeaderEventBus (17 类型)      │  ◀── routes:                          │
│   │  worker_joined / worker_left       │       1. 完成报告 → 解析            │
│   │  task_created / task_claimed       │          EvalDecision                │
│   │  task_completed / task_failed      │       2. 用户输入 → decompose        │
│   │  message_received / processed      │          (自处理 or 转发 Planner)    │
│   │  chain_activated                   │       3. ChainDef → push tasks       │
│   │  stream_chunk                      │                                       │
│   └────────────────────────────────────┘     MergeValidator                    │
│                  │                            ◀── 验证 commit 是否需合并       │
│                  ▼                                                              │
│           LeaderState.apply()                                                  │
│          (workers, tasks, events,                                              │
│           selectedWorkerIndex)                                                 │
│                  │                                                             │
│                  ▼                                                             │
│           LeaderTui.render()                                                   │
│          (ANSI 渲染 + 键盘输入)                                                 │
│                                                                                │
└───┬───────────────────────────────────────────────────────────────────────────┘
    │ fork() N 个子进程
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Worker 子进程 (N 个)                                                          │
│                                                                                │
│  child.ts → child-runner.ts                                                   │
│   ├─ process.chdir(worktreePath)                                              │
│   ├─ ZkClient.connect()                                                       │
│   ├─ InstanceRegistry.register(name, role, instanceId)                        │
│   ├─ TemplateEngine.loadAll()                                                 │
│   ├─ ClaudeRunner / SelfEvaluator / CommitChecker / HookEngine                │
│   ├─ WorkerWatcher(...).start()                                               │
│   └─ startParentAliveCheck()                                                  │
│                                                                                │
│  WorkerWatcher.processMessage(msg):                                           │
│   1. TemplateEngine.render(template, vars)                                    │
│   2. HookEngine.fire("worker_message_start")                                  │
│   3. ClaudeRunner.run(prompt, {systemPrompt}) → {code, sessionId}             │
│   4. CommitChecker.check({link, ...}, sessionId)                              │
│   5. SelfEvaluator.evaluate(link, vars, resultPath, key, sessionId)           │
│   6. HookEngine.fire("worker_message_end")                                    │
│   7. sendCompletionReport(link, EvalDecision + commitInfo)                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 2. Leader 内部架构

### 2.1 LeaderEventBus

类型化发布订阅，17 个事件类型，`LeaderState.apply(event)` 是唯一的状态变更入口。

```typescript
type LeaderEvent =
  | { type: "worker_joined"; instance: Instance }
  | { type: "worker_left"; instanceId: string; name: string }
  | { type: "worker_status_changed"; instanceId: string; status: string }
  | { type: "worker_message_received"; instanceId: string; content: string;
      link: string | null; timestamp: string; messageId: string }
  | { type: "task_created"; task: Task }
  | { type: "task_claimed"; taskId: string; instanceId: string }
  | { type: "task_completed"; taskId: string; instanceId: string }
  | { type: "task_blocked"; taskId: string; reason: string }
  | { type: "task_failed"; taskId: string; reason: string }
  | { type: "task_recovered"; taskId: string }
  | { type: "message_sent"; from: string; to: string; type: MessageType }
  | { type: "message_received"; from: string; content: string; msgId: string }
  | { type: "message_processed"; msgId: string; logPath: string }
  | { type: "chain_activated"; chainId: string }
  | { type: "task_dependency_resolved"; taskId: string }
  | { type: "debug_info"; message: string }
  | { type: "stream_chunk"; instanceId: string; chunk: string };
```

### 2.2 LeaderState

内存中的视图模型，TUI 通过订阅 EventBus 在每个事件后重绘：

```typescript
class LeaderState {
  workers: WorkerInfo[];
  pending: Task[];
  inProgress: Task[];
  events: EventLogEntry[];         // 保留最新 100 条
  selectedWorkerIndex: number;
  leader: { instanceId; name; cacheDir };

  apply(event: LeaderEvent): void;
}
```

### 2.3 子系统一览

| 子系统 | 监听路径 | 触发事件 |
|--------|---------|---------|
| **WorkerMonitor** | `/instances` | `worker_joined` / `worker_left` |
| **TaskOrchestrator** | `/tasks/pending` + `/tasks/claimed` | `task_created` / `task_claimed` / `task_completed` |
| **LeaderWatcher** | `/messages/{leader_id}` | 调用 `ChainRouter.route(msg)` |
| **ChainRouter** | —（由 LeaderWatcher 调用） | 机械路由：EvalDecision / ChainDef / 用户输入 |
| **MergeValidator** | —（由 ChainRouter 调用） | 决策 merge / skip / review_first |
| **Recovery** | `/tasks/claimed`（启动时扫描） | 孤儿任务回收 |
| **StreamTailer** | Worker `.log` 文件（轮询） | `stream_chunk` |

### 2.4 Leader 启动时序

```
startLeader(config, worktreeConfigs)
  ├─ ZkClient.connect() + mkdirp
  ├─ create /leader EPHEMERAL（失败 → 退出）
  ├─ InstanceRegistry.register(role=leader)
  ├─ 确保 cacheDir/{leader_instance_id}/ 存在
  ├─ TemplateEngine.loadAll()
  ├─ LeaderEventBus + LeaderState（注入 worktreeConfigs）
  ├─ WorkerMonitor.start() + TaskOrchestrator.start()
  ├─ ChainRouter / MergeValidator 装配
  ├─ LeaderWatcher.start()
  ├─ Recovery.scanOrphans()
  ├─ LeaderTui.render() + onInput 回调
  └─ 阻塞等待 SIGINT
```

### 2.5 TUI 设计

6 个面板：TEAM / PENDING / IN PROGRESS / WORKER MESSAGES / EVENT LOG / INPUT

键盘交互：

| 按键 | 行为 |
|------|------|
| 可打印字符 | 追加到输入缓冲 |
| Enter | 发送消息到 `/messages/{leader_id}` |
| Backspace | 删除最后一个字符 |
| Escape | 清空输入缓冲 |
| Tab / Shift+Tab | 切换选中 Worker |
| `1`-`9` | 直接跳转到第 N 个 Worker |
| Ctrl+C | SIGINT 关停 |

## 3. Worker 内部架构

### 3.1 子进程模型

Worker 由主进程通过 `child_process.fork()` 启动，通过 `argv[2]` 传递 JSON 序列化的 `ChildConfig`：

```typescript
interface ChildConfig {
  worktreePath: string;
  name: string;             // "Tom"
  role: string;             // "planner"
  instanceId: string;
  branch: string;
  zkHosts: string;
  debug: boolean;
  cliCommand: string;
  cacheDir: string;
}
```

### 3.2 Worker 启动时序

```
startWorkerChild(config)
  ├─ process.chdir(config.worktreePath)
  ├─ ZkClient.connect()
  ├─ InstanceRegistry.register(name, role, instanceId)
  ├─ TemplateEngine.loadAll()
  ├─ new ClaudeRunner(...)
  ├─ new SelfEvaluator(...)
  ├─ new CommitChecker(...)
  ├─ new HookEngine()
  ├─ new WorkerWatcher(...)
  ├─ startParentAliveCheck()
  ├─ watcher.start()
  └─ 阻塞等待 SIGINT
```

### 3.3 消息处理管线（8 步）

1. 解析 Message → 提取 `link`
2. 选择模板 `worker-{link}.md`
3. Hook: `worker_message_start`
4. TemplateEngine.render() → 生成 prompt
5. ClaudeRunner.run() → claude-cli 执行
6. CommitChecker.check() → 自动 commit
7. SelfEvaluator.evaluate() → 输出 EvalDecision
8. sendCompletionReport() → 写回 Leader

## 4. 任务状态机

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
                    │         │ task-retry
                    │         ▼
                    │      pending (retry_count++)
                    │
              (人工解除阻塞)
```

转换规则：

| 从 | 到 | 触发 | 条件 |
|----|----|------|------|
| (none) | `pending` | `push-task` 或 ChainRouter | — |
| `pending` | `claimed` | `claim-task` | ZK EPHEMERAL create 成功 |
| `claimed` | `completed` | `complete-task` | claimed 节点归属校验 |
| `claimed` | `blocked` | `task-block` | Worker 声明阻塞 |
| `claimed` | `failed` | `task-fail` | Worker 声明失败 |
| `failed` | `pending` | `task-retry` | retry_count++ |
| `claimed` | `pending` | Worker 断开 → ZK Session 超时 | Recovery 回收，max 3 次 |

### 角色权重认领

`TaskQueue.claim()` 按复合键排序：
1. 显式 `assigned_to` 匹配 → 最高优先
2. `link` 匹配实例 `role` → 次优
3. `priority` 数值越小越优先
4. ID FIFO

## 5. 错误处理

详见 `error-and-recovery.md`。要点：

| 场景 | 处理 |
|------|------|
| ZK 临时断开 | 自动重连（指数退避，最多 10 次） |
| Leader 崩溃 | `/leader` EPHEMERAL 自动删除 → Worker 继续运行 → 新 Leader 重启后 scanOrphans |
| Worker 子进程崩溃 | 主进程自动重启（最多 3 次） |
| 父进程崩溃 | 子进程检测 `process.kill(ppid, 0)` 失败后主动退出 |
| 合并冲突 | `git merge --abort` + 返回 `review_first` |
| 孤儿任务 | Recovery 检测 → retry_count++ → 重入 pending（max 3 次后归档 failed） |

## 6. 共享 cache_dir

```
{cache_dir}/{leader_instance_id}/
├── tasks/
│   └── task-{seq}.md           # 任务文档
├── task-{id}-{ts}.log          # 主任务日志
├── task-{id}-{ts}-result.md    # Worker 产出
├── task-{id}-eval-{ts}.log     # 自评估日志
├── task-{id}-commit-{ts}.log   # commit message 日志
└── msg-{msgId}-{ts}.log        # Leader 消息处理日志
```

Leader 与所有 Worker 共享同一 `cache_dir`，Worker 通过绝对路径访问。
