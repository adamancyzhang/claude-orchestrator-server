# 架构细节

本文档描述 Leader、Worker、Orchestrator 三大组件的内部架构，包括事件总线、状态机、Watch 策略、错误恢复矩阵。是 [`leader-design.md`](leader-design.md) 和 [`worker-design.md`](worker-design.md) 的底层参考。

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
│   │  worker_joined/_left/_status_*      │       1. 完成报告 → 解析            │
│   │  task_created/_claimed/_completed/  │          EvalDecision/commit         │
│   │   _failed/_recovered                 │       2. 用户输入 → decompose        │
│   │  message_received/_processed         │          (自处理 or 转发 Planner)    │
│   │  worker_message_received             │       3. 任务定义 → push tasks       │
│   │  chain_activated                     │                                       │
│   └────────────────────────────────────┘     MergeValidator                    │
│                  │                            ◀── 验证 commit 是否需合并       │
│                  ▼                                                              │
│           LeaderState.apply()                                                  │
│          (workers, tasks, events,                                              │
│           selectedWorkerIndex)                                                 │
│                  │                                                             │
│                  ▼                                                             │
│           LeaderTui.render()                                                   │
│          (ANSI 渲染 + 键盘输入 + Tab 切换 Worker)                              │
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
│   ├─ TemplateEngine.loadAll() ← .claude-orchestrator/agents/                  │
│   ├─ ClaudeRunner(command, cacheDir, instanceId, workDir)                     │
│   ├─ SelfEvaluator / CommitChecker / HookEngine                               │
│   ├─ WorkerWatcher(...).start()                                               │
│   └─ startParentAliveCheck() — 父进程消失则主动退出                            │
│                                                                                │
│  WorkerWatcher.processMessage(msg):                                           │
│   1. TemplateEngine.render(template, vars)                                    │
│   2. HookEngine.fire("worker_message_start")                                  │
│   3. ClaudeRunner.run(prompt, {systemPrompt}) → {code, sessionId}             │
│   4. CommitChecker.check({link, taskTitle, ...}, sessionId)                   │
│   5. SelfEvaluator.evaluate(link, vars, resultPath, key, sessionId)           │
│   6. HookEngine.fire("worker_message_end")                                    │
│   7. sendCompletionReport(link, EvalDecision + commitInfo)                    │
│                                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 2. Leader 内部架构

Leader 主进程由 [src/leader/index.ts](../../src/leader/index.ts) 装配，启动 11 个文件协同工作。

### 2.1 LeaderEventBus

[src/leader/event-bus.ts](../../src/leader/event-bus.ts) 提供类型化的发布订阅，17 个事件类型：

```typescript
type LeaderEvent =
  | { type: "worker_joined"; instance: Instance }
  | { type: "worker_left"; instanceId: string; name: string }
  | { type: "worker_status_changed"; instanceId: string; status: string }
  | { type: "worker_message_received"; instanceId: string; content: string;
      link: string | null; timestamp: string; messageId: string }
  | { type: "task_created"; task: Task }
  | { type: "task_claimed"; taskId: string; instanceId: string }
  | { type: "task_completed"; taskId: string; instanceId: string;
      task?: Record<string, unknown> }
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

`LeaderState.apply(event)` 是唯一的状态变更入口，TUI 通过订阅 EventBus 在每个事件后重绘。

### 2.2 LeaderState

[src/leader/state.ts](../../src/leader/state.ts) 维护内存中的视图模型：

```typescript
class LeaderState {
  workers: WorkerInfo[];           // 每个 Worker 的 name/role/worktree/pid/messageHistory
  pending: Task[];                 // pending 任务
  inProgress: Task[];              // claimed 任务
  events: EventLogEntry[];         // 事件日志（截尾保留最新 100 条）
  selectedWorkerIndex: number;     // TUI 当前选中的 Worker（Tab 切换）
  leader: { instanceId; name; cacheDir };

  apply(event: LeaderEvent): void {
    // 大型 switch 块，每个事件类型驱动状态变更
  }
}
```

`WorkerInfo` 包含 worktree 字段和消息历史：

```typescript
interface WorkerInfo {
  id: string; name: string;
  presetRole: string; currentRole: string | null;
  status: "idle" | "busy"; currentTaskId: string | null;
  worktreeName: string | null; worktreePath: string | null;
  worktreeBranch: string | null; pid: number | null;
  // 用于 TUI Worker Messages 面板
  currentMessage: string | null;
  currentMessageLink: string | null;
  currentMessageTime: string | null;
  messageHistory: WorkerMessageEntry[];   // 最多保留 20 条
  lastCompletedTask: string | null;
}
```

### 2.3 WorkerMonitor

[src/leader/monitor.ts](../../src/leader/monitor.ts) 监听 `/instances`：

```typescript
class WorkerMonitor {
  async start(): Promise<void> {
    const children = await this.zk.getChildrenWithWatch(
      paths.INSTANCES, (newChildren) => this.onChildrenChanged(newChildren),
    );
    for (const id of children) this.watchWorkerData(id);
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

### 2.4 TaskOrchestrator

[src/leader/orchestrator.ts](../../src/leader/orchestrator.ts) 监听 `/tasks/pending` 与 `/tasks/claimed`，emit `task_created` / `task_claimed` / `task_completed` 事件，同时承担孤儿任务初步检测（实例不存在但 claimed 节点未自动清理的边缘情况，由 [Recovery](../../src/leader/recovery.ts) 处理）。

### 2.5 LeaderWatcher

[src/leader/watcher.ts](../../src/leader/watcher.ts) 监听 `/messages/{leader_id}/*`，每条新消息交给 `ChainRouter`：

```typescript
class LeaderWatcher {
  private async processMessage(msgId: string): Promise<void> {
    if (this.inFlight.has(msgId)) return;
    const data = await this.zk.getMessage(this.leaderInstanceId, msgId);
    if (!data) return;
    const msg = MessageSchema.parse({ ...data, id: msgId });
    if (msg.read) return;
    this.inFlight.add(msgId);

    this.eventBus.emit({ type: "message_received", from, content: msg.content, msgId });

    await this.chainRouter.route(msg);   // 机械路由 — 见 leader-design.md §5

    msg.read = true;
    await this.zk.updateMessage(this.leaderInstanceId, msgId, msg);
    this.inFlight.delete(msgId);
    this.eventBus.emit({ type: "message_processed", msgId, logPath });
  }
}
```

### 2.6 ChainRouter

[src/leader/chain-router.ts](../../src/leader/chain-router.ts) 是 Leader 的机械路由：

- 若消息内容是 EvalDecision JSON（Worker 完成报告） → 解析、激活下一环节、必要时调用 `MergeValidator`
- 若消息是 ChainDef JSON（decompose 输出） → push 5 个任务到队列
- 若是用户输入（来自 TUI 键盘） → 检查 decompose 模板是否已加载：已加载则 Leader 自处理 claude-cli 拆解，否则转发 decompose 消息给 Planner Worker
- 都不是 → 回退 `runner.run()` 直接执行

详见 [`leader-design.md`](leader-design.md) §5。

### 2.7 MergeValidator

[src/leader/merge-validator.ts](../../src/leader/merge-validator.ts) 接收 commit 信息，决策 `merge` / `skip` / `review_first`，并在 merge 决策下执行 `git checkout main && git merge --no-ff`。冲突时 `git merge --abort` 并返回 `review_first`。详见 [`leader-design.md`](leader-design.md) §6。

### 2.8 Recovery

[src/leader/recovery.ts](../../src/leader/recovery.ts) 在 Leader 启动时扫描 `/tasks/claimed`：

```
scanOrphans():
  对每个 claimed 节点 (instId, taskId):
    若 /instances/{instId} 不存在:
      taskData.status = "pending"
      taskData.retry_count += 1
      若 retry_count > 3 → 创建 /tasks/completed/{taskId} 标记为 failed
      否则               → 创建 /tasks/pending/{newSeq}
      删除原 claimed 节点
```

运行时孤儿处理由 `WorkerMonitor` + `TaskOrchestrator` 联动：Worker 断开 → EPHEMERAL `/instances/{id}` 删除 → claimed 节点失效 → 触发同样的回收流程。

### 2.9 LeaderTui

[src/leader/tui.ts](../../src/leader/tui.ts) 使用 ANSI 转义序列直接渲染，分 6 个面板：

1. **TEAM** — Name / Preset Role / Current Role / Worktree / Branch / PID / Status，选中行高亮 `>`
2. **PENDING** — 待认领任务列表
3. **IN PROGRESS** — 已认领任务列表
4. **WORKER MESSAGES** — 当前选中 Worker 的消息全文 + 5 条历史（固定 ~12 行）
5. **EVENT LOG** — 滚动日志（剩余空间）
6. **INPUT** — 键盘输入框（4 行）

键盘交互：

| 按键 | 行为 |
|------|------|
| 可打印字符 | 追加到输入缓冲 |
| Enter | 发送消息到 `/messages/{leader_id}` |
| Backspace | 删除最后一个字符 |
| Escape | 清空输入缓冲 |
| Tab | 选中下一个 Worker（循环） |
| Shift+Tab (`\x1b[Z`) | 选中上一个 Worker（循环） |
| `1`-`9` | 直接跳转到第 N 个 Worker |
| Ctrl+C | SIGINT 关停 |

### 2.10 StreamTailer

[src/leader/stream-tailer.ts](../../src/leader/stream-tailer.ts) 监视各 Worker 的 `.log` 文件，按行尾随并 emit `stream_chunk` 事件，TUI 可在 EVENT LOG 中实时显示 Worker 的 claude-cli 输出。

### 2.11 Leader 启动时序

由 [src/leader/index.ts](../../src/leader/index.ts) 编排：

```
startLeader(config, worktreeConfigs)
  ├─ 1. zk.connect()                        — _ensurePaths() 创建 ZK 节点树
  ├─ 2. zk.create("/leader", EPHEMERAL)     — 失败 → "Another leader is already running" → 退出
  ├─ 3. InstanceRegistry.register(role=leader) → 获得 leader_instance_id
  ├─ 4. 确保 cacheDir/{leader_instance_id}/ 存在
  ├─ 5. TemplateEngine.loadAll(.claude-orchestrator/agents/)
  ├─ 6. new LeaderEventBus()
  ├─ 7. new LeaderState() + 注入 worktreeConfigs
  ├─ 8. eventBus.on("*") → state.apply() + tui.render()
  ├─ 9. WorkerMonitor.start() + TaskOrchestrator.start()
  ├─ 10. ChainRouter / MergeValidator 装配
  ├─ 11. LeaderWatcher.start()    — watch /messages/{leader_id}
  ├─ 12. Recovery.scanOrphans()   — 启动时一次性孤儿扫描
  ├─ 13. LeaderTui.render() + tui.onInput((text) => zk.createMessage(leader_id, ...))
  └─ 14. 阻塞等待 SIGINT
```

## 3. Worker 内部架构

Worker 由 [src/worker/child.ts](../../src/worker/child.ts) 作为子进程入口，[src/worker/child-runner.ts](../../src/worker/child-runner.ts) 完成完整装配。

### 3.1 子进程入口与配置

```typescript
// src/worker/child.ts
#!/usr/bin/env node
import { startWorkerChild } from "./child-runner.js";
const config = JSON.parse(process.argv[2]);
startWorkerChild(config).catch((err) => {
  console.error("Worker child fatal error:", err);
  process.exit(1);
});

// ChildConfig 字段
interface ChildConfig {
  worktreePath: string;     // 绝对路径
  name: string;             // "Tom"
  role: string;             // "planner"
  instanceId: string;       // 预生成 UUID
  branch: string;           // claude-orchestrator/Tom-workspace
  zkHosts: string;
  debug: boolean;
  cliCommand: string;       // claude --dangerously-skip-permissions ...
  cacheDir: string;
}
```

### 3.2 startWorkerChild 启动时序

```
startWorkerChild(config)
  ├─ 1. process.chdir(config.worktreePath)
  ├─ 2. ZkClient.connect()
  ├─ 3. InstanceRegistry.register(name, role, instanceId, {worktreePath, branch, pid})
  ├─ 4. TemplateEngine.loadAll(<worktree>/.claude-orchestrator/agents/)
  ├─ 5. new ClaudeRunner(cliCommand, cacheDir, instanceId, worktreePath, identity)
  ├─ 6. new SelfEvaluator(templateEngine, runner, name, role)
  ├─ 7. new CommitChecker(worktreePath, runner)
  ├─ 8. new HookEngine()
  ├─ 9. new WorkerWatcher(zk, instanceId, leaderInstanceId,
  │                        hooks, templateEngine, runner,
  │                        evaluator, commitChecker,
  │                        worktreePath, worktreeBranch)
  ├─ 10. startParentAliveCheck() — 每秒 process.kill(ppid, 0)
  ├─ 11. watcher.start()
  └─ 12. 阻塞等待 SIGINT → 清理 → 退出
```

### 3.3 WorkerWatcher 消息处理管线

[src/worker/watcher.ts](../../src/worker/watcher.ts)：

```
processMessage(msgId):
  msg = zk.getMessage(instanceId, msgId)
  若 msg.read or in-flight → 返回

  link = msg.link || "_generic"
  template = templateEngine.get(`worker-${link}.md`)
  vars = { task_title, task_description, task_criteria,
           task_doc_path, result_path, work_dir, time,
           content, ... }

  hooks.fire("worker_message_start", {CO_WORKER_NAME, CO_TASK_ID, ...})

  prompt = templateEngine.render(template, vars)
  {code, sessionId} = runner.run(prompt, logPath, {
    systemPrompt: runner.buildIdentityPrompt(),
  })

  commitResult = (link !== "_generic") &&
                 commitChecker.check({link, taskTitle, taskDescription}, sessionId)

  reportContent = evaluator.evaluate(link, vars, resultPath, key, sessionId)

  hooks.fire("worker_message_end")

  sendCompletionReport(link, msg, resultPath, key, commitResult, reportContent)
  zk.markMessageRead(instanceId, msgId)
```

### 3.4 SelfEvaluator

[src/worker/evaluator.ts](../../src/worker/evaluator.ts) 加载 `worker-evaluate.md`，使用 `--resume <mainSessionId> --fork-session` 调用 claude-cli，重试时每次重新 fork 干净分支，最多 3 次。输出 EvalDecision JSON：

```json
{
  "decision": "activate_next" | "feedback" | "reject" | "close_chain",
  "reason": "...",
  "nextLink": "build" | "verify" | "review" | "accept" | null,
  "feedback_to_worker": "..."
}
```

格式错误时使用 `worker-evaluate-format-hint.md` 重试。

### 3.5 CommitChecker

[src/worker/commit-checker.ts](../../src/worker/commit-checker.ts) 流程：

```
check(taskContext, mainSessionId):
  1. git status --porcelain
  2. 若无变更 → 返回 null
  3. 解析变更文件列表（changed + untracked）
  4. runner.run(worker-commit-message.md prompt, logPath, {resumeSessionId: mainSessionId})
  5. 解析输出，截断到 72 字符
  6. git add -A
  7. git commit -m "..."
  8. 返回 {sha, message, changedFiles, untrackedFiles}
```

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

### 4.1 转换规则

| 从 | 到 | 触发 | 条件 |
|----|----|------|------|
| (none) | `pending` | `push-task` 或 ChainRouter 由 ChainDef 推任务 | — |
| `pending` | `claimed` | `claim-task` 或 Worker 收到带 task_id 的消息后自动 claim | ZK EPHEMERAL create 成功（保证单一认领） |
| `claimed` | `completed` | `complete-task` 或 Worker 完成报告 | claimed 节点归属校验通过 |
| `claimed` | `blocked` | `task-block` | Worker 声明阻塞 |
| `claimed` | `failed` | `task-fail` | Worker 声明失败 |
| `failed` | `pending` | `task-retry` | 重新入队，retry_count++ |
| `claimed` | `pending` | Worker 断开 → ZK Session 超时 | Recovery 回收孤儿，max 3 次后归档为 failed |

### 4.2 角色权重认领

`TaskQueue.claim()` 按下列复合键排序候选 pending 任务：

1. 显式 `assigned_to` 匹配当前实例 → 最高优先
2. `link` 匹配当前实例 `role` → 次优（planner→plan、builder→build 等）
3. `priority` 数值越小越优先（HIGH=0）
4. ID FIFO

由于 ZK 自身的 EPHEMERAL create 原子性，并发认领时只有一个 Worker 会成功。

## 5. 错误处理与恢复

> **形式化规范**：本节的错误码、状态机、孤儿回收策略已统一收纳到 [`error-and-recovery.md`](error-and-recovery.md)。本节作为散文背景保留；任何代码实现以 `error-and-recovery.md` 为准。

### 5.1 ZK 层

| 场景 | 处理 |
|------|------|
| ZK 临时断开 | `ZkClient` 自动重连，指数退避，最多 10 次，2s spin delay |
| ZK Session 超时 | Leader → `/leader` 删除 → 进程退出。Worker → `/instances/{id}` 删除 → 子进程退出，由主进程检测 `exit` 后自动重启（最多 3 次） |
| ZK 集群不可用 | 阻塞等待重连，`claude -p` 调用本身不受影响 |

### 5.2 Leader 崩溃

```
Leader 退出 → /leader EPHEMERAL 自动删除（ZK session 关闭或超时）
            → Worker 进程不受影响，继续在本地处理已收到的消息
            → 新 Leader 启动（重新执行 run 命令）:
              - 创建新的 /leader 节点
              - Recovery.scanOrphans() 检查 /tasks/claimed
              - WorkerMonitor 重建 /instances 视图
              - 开始正常监控
```

### 5.3 Worker 子进程崩溃

```
Worker child 退出 (code != 0):
  ├─ /instances/{id} EPHEMERAL 自动删除
  ├─ 已 claimed 但未完成的任务 /tasks/claimed/{id}-* 自动删除
  ├─ Leader WorkerMonitor 触发 worker_left
  ├─ Leader TaskOrchestrator 检测孤儿 claimed → retry_count++ → 重入 pending
  └─ 主进程 child.on("exit") 触发自动重启:
        重启次数 < 3 → spawnChild(cfg)
        重启次数 >= 3 → logger.error，放弃
```

### 5.4 父进程崩溃 / kill -9

```
父进程意外终止 → 子进程检测 process.kill(ppid, 0) 抛错（每秒一次）
                  → 子进程主动退出: watcher.stop() + zk.disconnect() + process.exit(0)

正常退出时 process.on("exit") / SIGINT / SIGTERM / uncaughtException
                  → 主进程逐一 child.kill("SIGTERM")
```

### 5.5 任务级错误矩阵

| 场景 | 位置 | 处理 |
|------|------|------|
| InitChecker 缺失文件 | run.ts Phase 1 | 自动写入默认；Danger 操作交互确认或遵循 `init_status` 历史 |
| worktree 路径已存在 | worktree-initializer | 跳过 `git worktree add`，复用 |
| branch 已存在 | worktree-initializer | 跳过 `-b`，checkout 已有分支 |
| Worker 名称冲突 | worktree-initializer | 三级唯一性检查：扫描已有 worktree 目录 + 分支 + config.json |
| ZK 注册 ID 冲突 | InstanceRegistry | 重新生成 instance ID 重试 |
| git status 失败 | CommitChecker | 返回 null，不阻塞任务 |
| claude-cli 生成 commit msg 失败 | CommitChecker | 使用 fallback `"chore: auto-commit from {name}"` |
| MergeValidator claude-cli 失败 | MergeValidator | 默认 `review_first` |
| 合并冲突 | MergeValidator | `git merge --abort` + 返回 `review_first` |
| session_id 提取失败 | exec.ts | `sessionId` 为 `undefined`，`--resume` 不追加，退化到冷启动 |
| Evaluator 输出格式错误 | SelfEvaluator | 加 format-hint 再 fork-session 重试，最多 3 次 |

## 6. 共享 cache_dir

```
<project>/.claude-orchestrator/sessions/{leader_instance_id}/
├── tasks/
│   ├── task-0000000001.md           # decompose 生成的任务文档
│   └── task-0000000002.md
├── task-0000000001-{ts}.log         # ClaudeRunner.execWithStreaming 双写日志
├── task-0000000001-{ts}-result.md   # Worker 完成产出
├── task-0000000001-eval-{ts}.log    # 自评估日志
├── task-0000000001-commit-{ts}.log  # 生成 commit message 日志
└── msg-{msgId}-{ts}.log             # Leader 处理消息的日志
```

- 共享目录由 Leader 启动时创建（`.claude-orchestrator/sessions/{leader_id}/`）
- Worker `chdir` 到 worktree 后，仍能通过绝对路径访问该目录（与主仓库共享文件系统）
- 路径前缀来自 `cacheDir` 配置（默认 `.claude-orchestrator/sessions`，可绝对路径）
- Leader 与 Worker 必须使用相同的 `cacheDir` 配置

## 7. CLI 命令执行流程

短期命令（除 `run` 外的 12 个）执行模式相同：

```
claude-orchestrator push-task --title "..." --link build
  → withZk(hosts, async ({ taskQueue }) => taskQueue.push(...))
  → ZK 创建 /tasks/pending/task-NNNNN PERSISTENT_SEQUENTIAL
  → output.json({...})
  → ZK disconnect → process.exit(0)
```

`withZk()` 是一个简化的 ZK 会话包装器，每次创建短连接、执行、释放。
