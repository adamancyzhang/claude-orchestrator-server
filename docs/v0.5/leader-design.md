# Leader 工作流程与子系统设计

## 1. Leader 定位

Leader 是责任链的协调者，不直接执行任务。其核心工作是：**将需求转化为可执行的任务链，并推动任务走完 Plan → Build → Verify → Review → Accept 闭环。**

```
                     ┌─────────────┐
                     │   需求输入   │
                     └──────┬──────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                              Leader                                    │
│                                                                      │
│   ┌──────────┐   ┌──────────┐   ┌──────────────────┐                 │
│   │ 任务生成  │──▶│ 调度分发  │──▶│ 进度跟踪 & 闭环   │                 │
│   │ Claude   │   │ 权重匹配  │   │ 合并验证          │                 │
│   │ 拆解需求  │   │ 瓶颈疏解  │   │ 反馈协调          │                 │
│   └──────────┘   └──────────┘   └──────────────────┘                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┬───────────────────┐
        ▼                   ▼                   ▼                   ▼
    Planner             Builder             Verifier         Reviewer/Accepter
```

Leader 在三个时机调用 claude-cli：

1. **任务拆解**：用户输入需求时，由 `ChainRouter` 调用 `worker-decompose.md` 模板，拆解为 ChainDef JSON。当 Leader 自身已加载 decompose 模板时**自处理**，否则**转发**给 Planner Worker
2. **合并决策**：Worker 完成报告携带 commit 信息时，`MergeValidator` 用 `worker-merge-decision.md` 模板决策 merge / skip / review_first
3. **回退执行**：当模板未加载且 `ChainRouter` 无可识别意图时，回退到直接 claude-cli 处理

Leader 不重新评估 Worker 的完成度 —— 评估由 Worker 自身的 `SelfEvaluator` 完成，Leader 仅机械执行 EvalDecision JSON。

## 2. Leader 启动与事件循环

### 2.1 启动时序

由 [src/leader/index.ts](../../src/leader/index.ts) 装配，详见 [`architecture.md`](architecture.md) §2.11。要点：

```
startLeader(config, worktreeConfigs)
  ├─ ZK 连接 + 创建 /leader EPHEMERAL（声明领导权，create 失败则退出）
  ├─ InstanceRegistry.register(role=leader)
  ├─ 确保 cache_dir/{leader_instance_id}/ 存在
  ├─ TemplateEngine.loadAll(.claude-orchestrator/agents/)
  ├─ LeaderEventBus + LeaderState 初始化（注入 worktreeConfigs）
  ├─ 启动 5 个子系统:
  │   ├─ WorkerMonitor    — watch /instances
  │   ├─ TaskOrchestrator — watch /tasks/pending + /tasks/claimed
  │   ├─ LeaderWatcher    — watch /messages/{leader_id}
  │   ├─ ChainRouter      — 机械路由（无独立循环，由 LeaderWatcher 调用）
  │   └─ Recovery.scanOrphans() — 启动时一次性孤儿扫描
  ├─ MergeValidator 装配（依赖 projectRoot、runner、eventBus）
  ├─ LeaderTui.render() + onInput 回调
  └─ 阻塞等待 SIGINT
```

### 2.2 事件循环

Leader 启动后进入阻塞式事件循环，所有行为由 ZK 事件驱动：

```
                    ┌──────────────┐
                    │  ZK 事件触发  │
                    └──────┬───────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
    ┌───────────┐  ┌───────────┐  ┌───────────┐
    │Worker 变化 │  │ Task 变化 │  │ Message   │
    │/instances │  │/tasks/*   │  │/messages/ │
    │           │  │           │  │{leader_id}│
    └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
          │              │              │
          ▼              ▼              ▼
    WorkerMonitor   TaskOrchestrator   LeaderWatcher
          │              │              │
          └──────────────┼──────────────┘
                         │ emit event
                         ▼
                  LeaderEventBus
                         │
                         ▼
                  LeaderState.apply(event)
                         │
                         ▼
                  LeaderTui.render(state)

  + TUI 键盘输入 → write to /messages/{leader_id} → LeaderWatcher 自捕获
  + SIGINT → shutdown
```

### 2.3 三个 Monitor

| Monitor | 监听路径 | 触发事件 | 处理逻辑 |
|---------|---------|---------|---------|
| **WorkerMonitor** ([monitor.ts](../../src/leader/monitor.ts)) | `/instances` | Worker 上线/下线/状态变更 | `worker_joined` / `worker_left` / `worker_status_changed` 事件 |
| **TaskOrchestrator** ([orchestrator.ts](../../src/leader/orchestrator.ts)) | `/tasks/pending` / `/tasks/claimed` | 任务新增/认领/完成/阻塞 | `task_created` / `task_claimed` / `task_completed` 等事件 |
| **LeaderWatcher** ([watcher.ts](../../src/leader/watcher.ts)) | `/messages/{leader_id}` | Worker 完成报告 / TUI 用户输入 | 调用 `ChainRouter.route(msg)` |

## 3. TUI 设计

[src/leader/tui.ts](../../src/leader/tui.ts) 使用终端 ANSI 转义序列直接渲染，分 6 个面板。

### 3.1 布局

```
┌─ TEAM ────────────────────────────────────────────────────────────────────┐
│   Name    Preset    Current Role    Worktree  Branch                  PID │
│ > Tom     planner   Planner         Tom       claude-or…om-workspace  48291│
│   Jerry   builder   Builder         Jerry     claude-or…ry-workspace  48292│
│   Lucy    verifier  Builder ◀←      Lucy      claude-or…cy-workspace  48293│
│   Thomas  reviewer  (idle)          Thomas    claude-or…s-workspace   48294│
│   Jack    accepter  (idle)          Jack      claude-or…k-workspace   48295│
└────────────────────────────────────────────────────────────────────────────┘

┌─ PENDING ────────────────────────────┐ ┌─ IN PROGRESS ──────────────────────┐
│ [Plan]   高 chain-01: 认证模块蓝图     │ │ Tom: task-001 (Plan)               │
│ [Build]  普 chain-01: 实现认证模块     │ │ Jerry: task-002 (Build)            │
│ [Verify] 高 chain-01: 认证验证        │ │                                    │
└──────────────────────────────────────┘ └────────────────────────────────────┘

┌─ WORKER MESSAGES — Tom (planner)          [Tab/Shift+Tab 切换 Worker]      ┐
│ ─────────────────────────────────────────────────────────────────────────  │
│ ◆ 当前任务 (12:03:45)  [decompose]                                          │
│   "Decompose user authentication module into actionable chain tasks.        │
│    The requirements include login, registration, password reset..."         │
│                                                                             │
│ 历史消息:                                                                    │
│   12:01:22 [decompose]  "Analyze project structure and identify core..."    │
│   11:58:05 [decompose]  "Review initial requirements for the auth..."       │
└─────────────────────────────────────────────────────────────────────────────┘

┌─ EVENT LOG ─────────────────────────────────────────────────────────────────┐
│ [10:00:00] Leader started (instance: a1b2c3...)                             │
│ [10:00:05] ✓ Tom joined (planner)                                            │
│ [10:01:00] 📋 Chain chain-001 created: 用户认证模块 (5 tasks)                 │
│ [10:01:05] 📨 Tom ← Plan task task-001 assigned                              │
│ [10:05:30] 📨 Tom → Leader: task-001 completed                               │
│ [10:05:40] ✅ task-001 passed. Activating Build tasks.                       │
└─────────────────────────────────────────────────────────────────────────────┘

┌─ Input ─────────────────────────────────────────────────────────────────────┐
│ > 实现用户登录功能█                                                           │
└─────────────────────────────────────────────────────────────────────────────┘

Leader: Tom | Instance: a1b2c3... | CACHE_DIR: ... | Ctrl+C to stop
```

### 3.2 键盘交互

`LeaderTui` 通过 raw mode stdin 捕获按键：

| 按键 | 行为 |
|------|------|
| 可打印字符 (`>= " "`) | 追加到输入缓冲 `inputBuffer` |
| Enter (`\r` / `\n`) | 发送消息：`zk.createMessage(leader_id, {from: leader, to: leader, content: buf})` → LeaderWatcher 捕获 → ChainRouter |
| Backspace (`\x7f` / `\x08`) | 删除最后一个字符 |
| Escape (`\x1b`) | 清空输入缓冲 |
| Tab (`\t`) | `selectedWorkerIndex = (selectedWorkerIndex + 1) % workers.length` |
| Shift+Tab (`\x1b[Z`) | `selectedWorkerIndex = (selectedWorkerIndex - 1 + len) % len` |
| `1`–`9` | 直接跳转 `selectedWorkerIndex = parseInt(key) - 1` |
| Ctrl+C (`\x03`) | `process.kill(process.pid, "SIGINT")` |

每次按键变更后调用 `rerender()`。

### 3.3 面板高度自适应

```typescript
const teamH = Math.min(state.workers.length, 8) + 2;
const taskH = Math.min(Math.max(pendLines.length, progLines.length), 10) + 2;
const msgH = 12;  // 固定 12 行（当前任务 + 5 条历史）
const inputH = 4;
const logH = Math.max(3, rows - teamH - taskH - msgH - inputH - 5);
```

WORKER MESSAGES 面板固定 12 行，不随 Worker 数量增长，保证 20 个 Worker 时也不会挤占其他面板。

### 3.4 Worker Messages 面板

只展示当前选中 Worker 的消息详情：

- **当前任务段**：消息全文（自动换行），link 标签，时间戳；空闲时显示 `(idle)`
- **历史消息段**：该 Worker 最近 5 条消息（一行摘要：时间戳 + link + 截断内容）

数据来源 `WorkerInfo.messageHistory`，最多保留 20 条。新消息事件流：

```
Worker 收到消息 → LeaderWatcher / TUI 链路 emit worker_message_received
                → LeaderState.apply():
                    worker.currentMessage = content
                    worker.messageHistory.push(entry)
                    worker.messageHistory.slice(-20)
                    worker.status = "busy"
Worker 完成任务 → emit task_completed
                → LeaderState.apply():
                    worker.lastCompletedTask = task.title
                    worker.currentMessage = null
```

### 3.5 StreamTailer 实时尾随

[stream-tailer.ts](../../src/leader/stream-tailer.ts) 监视各 Worker 的 `.log` 文件，按行尾随并 emit `stream_chunk` 事件。EVENT LOG 中实时显示 Worker 的 claude-cli stdout，便于排查长任务的进展。

### 3.6 日志前缀规范

| 前缀 | 含义 | 来源 |
|------|------|------|
| `[Exec]` | Shell 命令执行 | [src/utils/exec.ts](../../src/utils/exec.ts) |
| `[Watcher]` | 消息接收与处理 | [src/leader/watcher.ts](../../src/leader/watcher.ts) / [src/worker/watcher.ts](../../src/worker/watcher.ts) |

## 4. LeaderWatcher 与三类消息

[src/leader/watcher.ts](../../src/leader/watcher.ts) 监听 `/messages/{leader_id}/*`，每条新消息交给 `ChainRouter.route(msg)`。`ChainRouter` 按消息内容判定三类处理路径：

```
ChainRouter.route(msg)
    │
    ▼
┌─────────────────────────────────────────────┐
│ 1. 读取消息内容，解析 MessageSchema          │
│    [Watcher] 日志记录消息来源和内容           │
└────────────────────┬────────────────────────┘
                     │
                     ▼
        ┌────────────┴────────────┐
        │ 消息内容是 JSON？        │
        └────────────┬────────────┘
                     │
       ┌─────────────┼─────────────┐
       │ 是          │             │ 否
       ▼             ▼             ▼
  ┌──────────┐  ┌──────────┐  ┌──────────────┐
  │EvalDecision│ │ ChainDef │  │ 用户输入文本   │
  └─────┬────┘  └─────┬────┘  └──────┬───────┘
        │             │              │
        ▼             ▼              ▼
   activate_next  push 5个任务   decompose:
   feedback                       自处理 or
   reject                         转发 Planner
   close_chain                    or 回退执行
        │             │              │
        ▼             ▼              ▼
   消息可携带 commit → MergeValidator.validate()
```

详细处理流程见 §5。

## 5. ChainRouter 机械路由

[src/leader/chain-router.ts](../../src/leader/chain-router.ts) 是 Leader 的核心路由：

### 5.1 EvalDecision JSON（Worker 完成报告）

消息 `content` 是 EvalDecision JSON：

```json
{
  "decision": "activate_next",
  "reason": "Plan blueprint approved, all build steps clear.",
  "nextLink": "build",
  "feedback_to_worker": null,
  "commit": {
    "sha": "a1b2c3d",
    "message": "Implement auth blueprint",
    "branch": "claude-orchestrator/Tom-workspace",
    "changed_files": ["docs/auth-blueprint.md"],
    "untracked_files": []
  }
}
```

处理：

1. 若携带 `commit` → 调用 `MergeValidator.validate(commitInfo)`
2. 根据 `decision` 字段：
   - `activate_next` → 从当前 chain 中找到 `nextLink` 对应任务，发送任务消息给该 link 的 Worker
   - `feedback` → `send-message` 反馈给原 Worker，附 `feedback_to_worker` 内容
   - `reject` → 同 feedback，但标记任务 failed
   - `close_chain` → emit `chain_activated` 事件，记录链关闭

### 5.2 ChainDef JSON（decompose 输出）

消息 `content` 是 ChainDef JSON：

```json
{
  "chain_id": "chain-001",
  "chain_title": "用户认证模块",
  "tasks": {
    "plan":   { "title": "...", "description": "...", "criteria": "...", "priority": 1 },
    "build":  { "title": "...", "description": "...", "criteria": "...", "priority": 1 },
    "verify": { "title": "...", "description": "...", "criteria": "...", "priority": 1 },
    "review": { "title": "...", "description": "...", "criteria": "...", "priority": 1 },
    "accept": { "title": "...", "description": "...", "criteria": "...", "priority": 1 }
  }
}
```

`plan` 可为 `null`，表示需求足够清晰可直接从 Build 开始。其他四个 link 必须存在。

处理：

1. 为每个非空任务调用 `TaskQueue.push()` 创建 `/tasks/pending/task-{seq}` 节点
2. 设置 `chain_id` 和依赖：`build.depends_on = [plan?.id]`，`verify.depends_on = [build.id]`，依此类推
3. 同时为每个任务在 `cache_dir/{leader_id}/tasks/task-{id}.md` 写入任务文档骨架（使用 `worker-task-doc.md` 模板）

### 5.3 用户输入（TUI 文本）

消息内容非 JSON。判定为用户输入需求：

```
ChainRouter.handleRequirement(content):
  if (TemplateEngine 已加载 worker-decompose.md):
    # 自处理 — Leader 直接 claude-cli 拆解
    prompt = templateEngine.render(worker-decompose.md, {requirement: content})
    runner.run(prompt, logPath, {systemPrompt: leaderIdentity})
    解析输出 → ChainDef JSON → push 任务（同 §5.2）
  else:
    # 转发 — 发送 decompose 消息给 Planner Worker
    planner = workers.find(w => w.role === "planner")
    zk.sendMessage(planner.id, {
      type: "direct",
      link: "decompose",
      content: content,
      ...
    })
```

### 5.4 回退执行

`ChainRouter` 无法识别意图时，回退到直接 `runner.run()`：

```typescript
const logPath = path.join(cacheDir, leaderId, `${uniqueKey}.log`);
await runner.run(msg.content, logPath, {
  systemPrompt: leaderIdentity,
});
```

仅用于 ad-hoc 场景，正常运转下应总是命中 §5.1–§5.3 之一。

## 6. MergeValidator 合并验证

[src/leader/merge-validator.ts](../../src/leader/merge-validator.ts) 负责将 Worker 分支合并回主分支。

### 6.1 决策接口

```typescript
class MergeValidator {
  async validate(commitInfo: {
    sha: string; message: string; branch: string;
    taskTitle: string; taskLink: string;
  }): Promise<MergeDecision>;
}

type MergeDecision = {
  decision: "merge" | "skip" | "review_first";
  reason: string;
};
```

### 6.2 流程

```
validate(commitInfo):
  ├─ 1. 获取 main 分支名 (默认 main 或 master)
  ├─ 2. 检查 sha 是否已在 main 中 (git merge-base --is-ancestor)
  │     └─ 已合并 → 返回 {decision: "skip", reason: "已合并"}
  ├─ 3. askMergeDecision(commit, mainBranch):
  │     └─ 调用 worker-merge-decision.md 模板，runner.run() 输出 JSON 决策
  ├─ 4. 若 decision == "merge":
  │     ├─ git checkout {mainBranch}
  │     ├─ git merge {commitInfo.branch} --no-ff -m "Merge ...: {commitInfo.message}"
  │     ├─ 成功 → emit debug_info "合并成功"
  │     └─ 冲突 → git merge --abort + 返回 {decision: "review_first", reason: "合并冲突"}
  └─ 5. 返回 decision
```

### 6.3 合并策略

- 始终 `--no-ff` 保留合并提交，便于回溯
- 始终先 `checkout` 到 main 再 merge，不修改 Worker 分支
- 冲突自动 abort，决策回退为 `review_first` 标记给用户处理
- claude-cli 调用失败时默认 `review_first`（保守策略）

### 6.4 与 ChainRouter 集成

```typescript
// chain-router.ts handleCompletionReport()
const parsed = extractJson(msg.content);
if (parsed.commit?.sha) {
  const mergeDecision = await this.mergeValidator.validate({
    sha: parsed.commit.sha,
    message: parsed.commit.message,
    branch: parsed.commit.branch,
    taskTitle: msg.task_title ?? "unknown",
    taskLink: msg.link ?? "unknown",
  });
  // 决策日志计入 EVENT LOG
}
// 继续处理 EvalDecision 段（activate_next / feedback / ...）
```

合并验证与 EvalDecision 解耦：即使决策为 `skip` 或 `review_first`，链条仍按 EvalDecision 继续推进。冲突的分支保留在 Worker worktree，用户手动 merge。

## 7. TaskOrchestrator 任务监控

[src/leader/orchestrator.ts](../../src/leader/orchestrator.ts) 持续监听 `/tasks/pending` 和 `/tasks/claimed`：

```typescript
class TaskOrchestrator {
  async start(): Promise<void> {
    this.zk.getChildrenWithWatch(paths.TASKS_PENDING, (children) => {
      for (const id of diff(children, this.knownPending)) {
        const task = await this.zk.getPendingTask(id);
        this.eventBus.emit({ type: "task_created", task });
      }
      // 重建 Watch
    });

    this.zk.getChildrenWithWatch(paths.TASKS_CLAIMED, (children) => {
      // 检测 claimed 子节点删除（实例断开）
      for (const id of diff(this.knownClaimed, children)) {
        const [insId, taskId] = parseClaimedNodeName(id);
        const instExists = await this.zk.exists(paths.instancePath(insId));
        if (!instExists) {
          await this.recoverOrphanedTask(insId, taskId);
        }
      }
    });
  }
}
```

`recoverOrphanedTask` 与 `Recovery.scanOrphans()` 共享回收逻辑：

- 保留: `title`、`description`、`priority`、`link`、`chain_id`、`assigned_to`、`created_by`
- 设置: `status = "pending"`、`retry_count += 1`
- 若 `retry_count > 3` → 创建 `/tasks/completed/{taskId}` 标记为 `failed`
- 否则 → 创建 `/tasks/pending/task-{newSeq}`（重新分配 sequential 编号）

## 8. Recovery 启动孤儿扫描

[src/leader/recovery.ts](../../src/leader/recovery.ts) 在 Leader 启动时执行一次性 `scanOrphans()`：

```
scanOrphans():
  for each (instId, taskId) in /tasks/claimed:
    若 /instances/{instId} 不存在:
      recoverOrphanedTask(instId, taskId)
```

这弥补了 Leader 启动间隙期 Worker 断开的情况：Leader 不在时 Worker 断开 → claimed 节点删除 → 没有 Watch 触发回收 → 启动时扫描兜底。

## 9. 提示词模板

Leader 调用 claude-cli 时使用的模板：

| 模板文件 | 调用方 | 用途 |
|---------|--------|------|
| `templates/agents/worker-decompose.md` | ChainRouter（自处理时）| 需求 → ChainDef JSON |
| `templates/agents/worker-merge-decision.md` | MergeValidator | commit + 任务上下文 → MergeDecision JSON |
| `templates/agents/worker-task-doc.md` | ChainRouter | ChainDef → 任务文档骨架 |

身份注入由 [`ClaudeRunner.buildIdentityPrompt()`](../../src/executor/runner.ts) 生成 Leader 身份卡片，通过 `--append-system-prompt` 注入。详见 [`execution-runtime.md`](execution-runtime.md) §1。
