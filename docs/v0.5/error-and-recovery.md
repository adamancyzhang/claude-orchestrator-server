# Error & Recovery — v0.5 错误模型与恢复状态机

> **文档定位**：本文是 v0.5 中**错误如何分类、在哪里抛、在哪里捕、出错后系统如何自愈**的权威说明。它形式化了 [`architecture.md`](architecture.md) §5 的散文叙述。
>
> 错误类的类型定义见 [`contracts.md`](contracts.md) §8；ZK 节点的写入语义见 [`protocol.md`](protocol.md)；包归属见 [`package-layout.md`](package-layout.md)。

---

## 1. 错误类层级与稳定错误码

### 1.1 类层级

```
CoError                              // 根类，全部错误的祖先
├── ZkError                          // ZK 相关
│   ├── ZkSessionExpiredError
│   ├── ZkNodeExistsError
│   └── ZkNodeNotFoundError
├── ValidationError                  // 协议校验失败，包 ZodError
├── ProtocolVersionMismatchError     // 版本不兼容
├── ClaudeRunnerError                // claude-cli 执行失败
├── TemplateNotFoundError            // 模板缺失
├── HookError                        // Hook 执行失败（不冒泡到主流程）
├── MergeConflictError               // git merge 冲突
├── WorktreeError                    // git worktree 创建 / 状态异常
└── OrphanRetryExhaustedError        // 任务重试达上限
```

### 1.2 稳定错误码（`code` 字段）

> **稳定性承诺**：错误码字符串一旦发布，不允许在 minor 版本中删改；只允许新增。日志聚合、监控规则可以直接引用。

| 错误码 | 类 | 含义 |
|--------|----|------|
| `ZK_SESSION_EXPIRED` | `ZkSessionExpiredError` | ZK 会话过期，需重连并恢复 watch |
| `ZK_NODE_EXISTS` | `ZkNodeExistsError` | 创建节点时已存在（多见于 leader 互斥、claim 抢锁） |
| `ZK_NODE_NOT_FOUND` | `ZkNodeNotFoundError` | 读 / setData / delete 一个不存在的节点 |
| `ZK_UNKNOWN` | `ZkError` | 其他 ZK 错误 |
| `VALIDATION_FAILED` | `ValidationError` | Zod schema 校验失败 |
| `PROTOCOL_VERSION_MISMATCH` | `ProtocolVersionMismatchError` | Leader / Worker 协议版本不一致 |
| `CLAUDE_RUNNER_EXIT_NON_ZERO` | `ClaudeRunnerError` | `claude -p` 进程退出码非 0 |
| `CLAUDE_RUNNER_SESSION_PARSE_FAILED` | `ClaudeRunnerError` | 无法从输出中提取 session_id |
| `TEMPLATE_NOT_FOUND` | `TemplateNotFoundError` | `TemplateEngine.load(name)` 找不到模板 |
| `HOOK_EXIT_NON_ZERO` | `HookError` | Hook 子进程退出码非 0（仅日志，不抛主流程） |
| `MERGE_CONFLICT` | `MergeConflictError` | `git merge` 冲突，已 abort |
| `WORKTREE_BUSY` | `WorktreeError` | 目标 worktree 路径已被占用且非本仓库管理 |
| `WORKTREE_CREATE_FAILED` | `WorktreeError` | `git worktree add` 失败 |
| `ORPHAN_RETRY_EXHAUSTED` | `OrphanRetryExhaustedError` | 任务重试已达 3 次 |
| `EVAL_DECISION_PARSE_FAILED` | `ValidationError` | Worker 输出的 EvalDecision JSON 不符合 schema |
| `CHAIN_DEF_PARSE_FAILED` | `ValidationError` | decompose 输出的 ChainDef JSON 不符合 schema |
| `MESSAGE_DELIVERY_FAILED` | `CoError`（`code: "MESSAGE_DELIVERY_FAILED"`) | 消息写入 ZK 失败（非 ZkError，可重试） |

新增错误码时**必须**在本表追加一行；用 `grep -r "code:" packages/` 自检。

---

## 2. 错误边界（捕获位置）

错误以**抛出**为默认；在每个组件的**外缘**统一捕获。

### 2.1 三个核心边界

| 边界 | 包 | 行为 |
|------|----|------|
| `LeaderWatcher.processMessage(msg)` | `@co/leader` | 单条消息处理失败 → 记 `debug_info` 事件 + 不影响其他消息 |
| `WorkerWatcher.processMessage(msg)` | `@co/worker` | 单条消息处理失败 → 发 completion_report(decision="reject") 给 Leader + 释放当前任务 |
| CLI 子命令 `handler(args)` | `@co/cli` | 命令失败 → 打印 `{ code, message }` + 退出码非 0 |

### 2.2 边界外的"重抛"原则

下层模块**只**抛标准 `CoError`；不允许：

- 抛字符串、抛 `Error` 基类（必须有 `code`）；
- 在下层 try-catch 后吞错（除非是 Hook 的 fire-and-forget，详见 §5）。

### 2.3 边界内的处理流程

```
catch (err: unknown) {
  if (err instanceof ProtocolVersionMismatchError) {
    logger.error("协议版本不匹配，进程退出", { code: err.code, cause: err.message });
    process.exit(2);
  }
  if (err instanceof ZkSessionExpiredError) {
    // 由 @co/infra 内部的 ZK 重连机制处理；这里仅记录
    logger.warn("ZK 会话过期，等待重连", { code: err.code });
    return; // 不向上传播
  }
  if (err instanceof CoError) {
    logger.error(err.message, { code: err.code, cause: err.cause });
    eventBus.emit({ type: "debug_info", message: `${err.code}: ${err.message}` });
    return;
  }
  // 未知错误：包装后向上传
  logger.error("未捕获异常", { cause: err });
  throw new CoError("UNKNOWN", String(err), err);
}
```

---

## 3. 任务生命周期与 `retry_count` 转换

```
                  push                claim
   ── (none) ──────────► pending ───────────► claimed ────────► completed
                            ▲                    │
                            │                    ├──► fail (retry_count < 3) ──► pending (retry_count++)
                            │                    │                 │
                            │                    │                 ▼
                            │                    │           retry_count >= 3 ──► failed (archived)
                            │                    │
                            │                    └──► instance lost (EPHEMERAL 删除) ──► Recovery 检测
                            │                                                                 │
                            │                                                        retry_count < 3
                            └─────────────────── 重新入 pending（retry_count++） ◄───────────
                                                                                              │
                                                                                       retry_count >= 3
                                                                                              ▼
                                                                                       failed (archived)
```

### 3.1 状态转换的触发与节点变更

| 当前状态 | 事件 | 目标状态 | ZK 操作 | retry 变化 |
|----------|------|----------|---------|-----------|
| (无) | `ITaskQueue.push` | `pending` | `createPersistentSequential(/tasks/pending/...)` | = 0 |
| `pending` | `ITaskQueue.claim` 成功 | `claimed` | 删 `/tasks/pending/{id}` + 创建 `/tasks/claimed/{ins}-{id}` EPHEMERAL | 不变 |
| `claimed` | `ITaskQueue.complete` | `completed` | 删 `/tasks/claimed/{ins}-{id}` + 创建 `/tasks/completed/{id}` | 不变 |
| `claimed` | `ITaskQueue.fail` | `pending` 或 `failed` | 删 claimed；retry < 3 时重新 push 到 pending（retry++）；否则归档 failed | +1 或归档 |
| `claimed` | Worker EPHEMERAL 节点消失（`/instances/{id}` 不再存在） | `pending` 或 `failed` | `Recovery` 删 claimed、判断 retry++，重新入 pending 或归档 failed | +1 或归档 |
| `pending` | `ITaskQueue.block` | `blocked` | setData with `blocked_reason` | 不变 |
| `blocked` | 依赖完成（`task_dependency_resolved`） | `pending` | setData blocked_reason=null | 不变 |

### 3.2 `OrphanRetryExhaustedError` 触发

`Recovery` 检测到孤儿且 `retry_count >= 3` 时：

```
throw new OrphanRetryExhaustedError(
  "ORPHAN_RETRY_EXHAUSTED",
  `task ${taskId} 重试已达上限 ${MAX_RETRY}，归档为 failed`,
);
```

这是一个**软**错误：被 `Recovery` 本身捕获，转换为 `/tasks/completed/{id}` 写入（status=`failed`）+ 发 `task_failed` 事件。**不**让 Leader 崩溃。

---

## 4. 进程级恢复状态机

### 4.1 Worker 子进程崩溃 → 父进程重启（最多 3 次）

```
                       fork(child.js)
       parent ────────────────────────► child
                                          │
                                          │ 运行中
                                          ▼
                                       crash (exit code != 0)
                                          │
                                          ▼
       parent <─────── 'exit' 事件 ───────┘
       │
       │ restart_count[name]++
       ▼
   restart_count <= 3 ?
       │
       ├── yes ──► fork 重启 (返回顶部)
       │
       └── no  ──► 标记 worker.status = "failed"
                   发 worker_left 事件
                   不再重启
                   /instances/{id} 由 ZK 会话过期自动清理
```

约束：

- `restart_count` 在 parent 进程内存中维护，**不**持久化（重启 orchestrator 后归零）。
- crash 触发的 cleanup：
  - `/instances/{instance_id}` 通过 ZK 会话过期自动消失；
  - `/tasks/claimed/{ins}-{task}` 同理；
  - `Recovery` 自动接管孤儿。

### 4.2 Worker 检测父进程死亡 → 子进程自杀

```
child:
  setInterval(() => {
    try {
      process.kill(process.ppid, 0); // 探测父进程是否存在
    } catch {
      logger.warn("父进程已退出，子进程自杀");
      process.exit(1);
    }
  }, 1000);
```

避免 orphaned child 继续抢任务。

### 4.3 Leader 崩溃 → 整体重启

- Leader 进程异常退出 → `/leader` EPHEMERAL 自动消失；
- 其他 Worker 检测到 `/leader` 消失 → 进入 idle 等待（不退出）；
- 操作员重新执行 `claude-orchestrator run --worker N` →
  - InitChecker 跳过已完成步骤；
  - WorktreeInitializer 检测到 worktree 已存在 → 跳过；
  - `Leader.start()` 创建新的 `/leader` 节点；
  - `Recovery.scanOrphans()` 扫描 `/tasks/claimed` 中 instance 不存在的项 → 重新入 pending；
  - 现存 Worker 继续工作（消息流自然续接）。

> 关键点：v0.5 不实现 Leader 热备。Leader 重启窗口期 Worker 处于"已分派任务可继续执行，新任务进 pending 等待"的状态。

### 4.4 孤儿 claimed → pending 自动回收

由 `Recovery` 在以下时机执行：

1. **Leader 启动时**：`scanOrphans()` 一次性扫描。
2. **运行时持续监测**：`TaskOrchestrator` 监听 `/tasks/claimed` child watch；某条 claimed 节点被删除（EPHEMERAL ZK 会话过期），且 `task_snapshot` 中 `instance_id` 对应的 `/instances/{id}` 也不存在 → 视为孤儿。

孤儿处理伪代码：

```ts
async function reclaim(taskSnapshot: Task) {
  if (taskSnapshot.retry_count >= MAX_RETRY) {
    await taskQueue.fail(taskSnapshot.id, "ORPHAN_RETRY_EXHAUSTED");
    eventBus.emit({ type: "task_failed", task_id: taskSnapshot.id,
                    reason: "重试次数超限" });
    return;
  }
  const next = { ...taskSnapshot,
                 retry_count: taskSnapshot.retry_count + 1,
                 status: "pending",
                 claimed_by: null, claimed_at: null };
  await taskQueue.push(toCreateInput(next));
  eventBus.emit({ type: "task_recovered", task_id: taskSnapshot.id,
                  retry_count: next.retry_count });
}
```

`MAX_RETRY = 3` 是协议常量；不通过配置开放（避免不同实例策略漂移）。

---

## 5. Hook 失败隔离原则

**铁律**：Hook 错误**绝不**破坏触发它的主流程。

实现要求：

```ts
async function fire(event: HookEvent): Promise<void> {
  for (const hook of this.matchingHooks(event.type)) {
    try {
      const child = spawn(hook.command, { env: { ...process.env, ...event.env } });
      await waitForExit(child, { timeoutMs: 5000 });
      if (child.exitCode !== 0) {
        this.logger.warn("Hook 退出码非 0", {
          code: "HOOK_EXIT_NON_ZERO",
          hook: hook.command,
          event: event.type,
          exit_code: child.exitCode,
        });
      }
    } catch (err) {
      // 吞掉一切，记日志，不重抛
      this.logger.warn("Hook 抛错", { code: "HOOK_EXIT_NON_ZERO", cause: err });
    }
  }
}
```

特殊性：

- Hook 是唯一允许"下层吞错不向上传"的位置；
- Hook 超时 5s 后强制 kill；
- 多个 hook 顺序执行；某条失败不影响后续。

---

## 6. ZK 会话事件响应矩阵

`IZkClient` 暴露三个事件：`disconnected`、`reconnected`、`expired`。各组件响应：

| 组件 | `disconnected` | `reconnected` | `expired` |
|------|---------------|---------------|-----------|
| `@co/infra` ZkClient | 内部计时，进入"等待恢复"状态 | 重新挂所有 watch；触发 `reconnected` | 抛 `ZkSessionExpiredError` 给所有上层消费者；重建 client；从注册节点开始 |
| Leader `WorkerMonitor` | 暂停发 `worker_*` 事件 | 重新拉一遍 `/instances` 列表，diff，补发缺失事件 | 重新 `register` Leader instance；重新挂 child watch |
| Leader `TaskOrchestrator` | 暂停 task 事件 | 重新拉 `/tasks/pending` 和 `/tasks/claimed` 列表；补发 task_created；触发 Recovery 复扫 | 同上 + 重发 `chain_activated` for 活动 chain |
| Leader `Recovery` | 不动 | 触发一次 `scanOrphans()` | 同 reconnected |
| Worker `Watcher` | 暂停消息处理 | 重新挂 `/messages/{my_id}` watch；处理积压消息 | 重新 `register` instance；重新挂 watch；当前 in-flight 任务**继续**（已 claim 状态本地保留） |
| TUI | 状态栏标红"ZK 断开" | 恢复状态栏 | 同 reconnected + 提示用户重连成功 |

### 6.1 关键设计：Worker `expired` 时的 in-flight 任务

Worker 在 ZK session expired 时**不**杀掉当前 `claude -p` 子进程：

- `/tasks/claimed/{ins}-{task}` EPHEMERAL 已消失 → Leader Recovery 视为孤儿；
- 旧 Worker 完成任务后尝试发 completion_report，但目标 message 队列已被 Recovery 视为重派的新任务接管 —— 这是**可能的双重提交**。
- 缓解：completion_report 在 `Message.content` 里携带 `task_id`，Leader `ChainRouter` 收到时校验 `Task` 当前 status 是否仍为 `claimed by this instance`；不是则丢弃 + 警告。

代价：极端场景下 Worker 做了无用功；收益：避免一次断网就杀掉昂贵的 LLM 调用。本协议接受此折中。

---

## 7. ClaudeRunner 错误处理

### 7.1 退出码

| 退出码 | 含义 | 处理 |
|--------|------|------|
| 0 | 成功 | 提取 session_id，返回 RunResult |
| 1-127 | 业务失败 | 抛 `ClaudeRunnerError(code="CLAUDE_RUNNER_EXIT_NON_ZERO")` |
| 130 (SIGINT) | 用户取消 | 抛 `ClaudeRunnerError(code="CLAUDE_RUNNER_CANCELLED")` |
| 137 (OOM) / 143 (SIGTERM) | 进程被杀 | 抛 `ClaudeRunnerError(code="CLAUDE_RUNNER_KILLED")` |

### 7.2 Session ID 提取失败

- 输入：最后一条 stream-json 应该包含 `{"type":"result","subtype":"final","session_id":"..."}`；
- 提取失败（流为空 / JSON 格式错） → 抛 `ClaudeRunnerError(code="CLAUDE_RUNNER_SESSION_PARSE_FAILED")`；
- 调用方（`WorkerWatcher` / `SelfEvaluator` / `CommitChecker`）catch 后：
  - 如果是主任务 → completion_report(decision="reject", reason="claude-cli session 提取失败")；
  - 如果是 CommitChecker → 回退到固定 commit message（`"chore: auto-commit from {Name}"`），不阻断主流程；
  - 如果是 SelfEvaluator → 视为评估失败，按 §8 处理。

---

## 8. SelfEvaluator 与 CommitChecker 容错

### 8.1 SelfEvaluator 格式错误重试

```
最多 3 次尝试：
  Attempt 1: claude -p --resume <main_session> --fork-session  worker-evaluate.md
  Attempt 2: claude -p --resume <main_session> --fork-session  worker-evaluate.md + worker-evaluate-format-hint.md
  Attempt 3: 同 Attempt 2
  ──────────────────────
  仍失败 → 发 reject completion_report
```

每次都 `--fork-session` 是为了避免上一次格式错误的输出污染下次评估上下文。

### 8.2 CommitChecker 失败回退

```
1. claude -p --resume <main_session>  worker-commit-message.md
   ── 期望输出: 合规的 commit message
2. 若 git commit 失败 / claude 输出空 → 回退:
   git commit -m "chore: auto-commit from {Name} (task {task_id})"
3. 若 git commit 仍失败（无变更）→ 跳过 commit，commit 字段为 null
```

CommitChecker 错误**不**抛给主流程；记 warn 日志即可。

---

## 9. MergeValidator 冲突处理

```
1. git checkout main
2. git merge --no-ff {worker_branch}
   ── 若冲突:
   3. git merge --abort
   4. 返回 MergeDecision { decision: "review_first", reason: "...", conflict_files: [...] }
   ── 若成功:
   3'. 调用 claude-cli + worker-merge-decision.md 让 LLM 二次判断（"是否真的应该合并？"）
   4'. 若 LLM 也说 merge → keep；否则 git reset --hard HEAD~1
```

`MergeConflictError` 仅在内部抛出；MergeValidator 一定返回 `MergeDecision`（不向上抛错）。

---

## 10. InitChecker 故障模式

InitChecker 的 6 步若任一步失败：

- **Safe 级别失败**：自动重试 1 次；仍失败 → 终止 orchestrator 启动，CLI 退出码 3。
- **Caution 级别失败**：交互模式询问用户；`-y` 模式跳过该步并标记 `init_status` 为 `skipped`。
- **Danger 级别失败**：必须人工确认，`-y` 模式也会阻塞。

`init_status` 中记录每步决策（`approved / skipped / auto`），下次启动跳过 `approved` 步骤。

---

## 11. 错误码 → 边界处理对照表

| 错误码 | 抛出点 | 捕获点 | 副作用 |
|--------|--------|--------|--------|
| `ZK_SESSION_EXPIRED` | `@co/infra` ZkClient | 各组件的 ZK 事件监听 | 重新 register + 重挂 watch |
| `ZK_NODE_EXISTS` | `IZkClient.createEphemeral` | TaskQueue.claim、Leader.start | 视为"被他人抢占" / "Leader 已存在"，CLI 提示 |
| `ZK_NODE_NOT_FOUND` | `IZkClient.getData/setData` | 调用方 | 通常作为"已被回收"信号，跳过 |
| `VALIDATION_FAILED` | Zod parse | 边界 catch | 记 `debug_info` 事件 + 拒绝消息 |
| `PROTOCOL_VERSION_MISMATCH` | Worker 启动校验 | Worker `main` | `process.exit(2)` |
| `CLAUDE_RUNNER_EXIT_NON_ZERO` | `ClaudeRunner.run` | WorkerWatcher.processMessage | 发 reject completion_report |
| `CLAUDE_RUNNER_SESSION_PARSE_FAILED` | `ClaudeRunner.run` | 同上 | 同上（CommitChecker 例外，回退） |
| `TEMPLATE_NOT_FOUND` | `TemplateEngine.load` | WorkerWatcher.processMessage | 发 reject + 致命日志 |
| `HOOK_EXIT_NON_ZERO` | `HookEngine.fire` | HookEngine 内部 | 仅日志 |
| `MERGE_CONFLICT` | `MergeValidator` 内部 | `MergeValidator.validate` | 返回 review_first |
| `WORKTREE_BUSY` / `WORKTREE_CREATE_FAILED` | `WorktreeInitializer` | `runOrchestrator` Phase 2 | 终止启动，CLI 退出 3 |
| `ORPHAN_RETRY_EXHAUSTED` | `Recovery.reclaim` | Recovery 自身 | 归档 failed + 发 task_failed |
| `EVAL_DECISION_PARSE_FAILED` | ChainRouter / SelfEvaluator | 自身 | SelfEvaluator 重试 / ChainRouter 视为 reject |
| `CHAIN_DEF_PARSE_FAILED` | ChainRouter | ChainRouter | 回退到自由文本分支 |
| `MESSAGE_DELIVERY_FAILED` | MessageRouter.send | 调用方 | 重试 1 次；再失败抛上去 |

---

## 12. 实现侧校验清单

实现完成后用本清单自检：

- [ ] 所有抛出的错误都是 `CoError` 子类（不抛 string / 不抛 plain Error）。
- [ ] 每个错误都有稳定 `code` 字段，且 `code` 出现在 §1.2 表中。
- [ ] 三个边界（`LeaderWatcher.processMessage` / `WorkerWatcher.processMessage` / CLI handler）实现了完整的 catch + 错误分流。
- [ ] `Recovery` 在 Leader 启动时执行一次 `scanOrphans()`。
- [ ] `TaskOrchestrator` 对 `/tasks/claimed` 的 child watch 触发时校验 instance 存在性。
- [ ] Worker 子进程崩溃由 parent 重启，restart_count 限制 3。
- [ ] Worker 检测 `process.ppid` 死亡 → 自杀。
- [ ] HookEngine 永远不向上抛错；超时 5s kill。
- [ ] SelfEvaluator 重试 ≤ 3，每次 `--fork-session`。
- [ ] CommitChecker 失败回退到固定文案。
- [ ] MergeValidator 冲突时 `git merge --abort`。
- [ ] `ZK_SESSION_EXPIRED` 后各组件能恢复 watch（用临时 ZK 重启场景测试，但本次只设计不实测）。

---

## 13. 与其他文档的关系

| 文档 | 关系 |
|------|------|
| [`contracts.md`](contracts.md) §8 | 错误类的 TS 类型定义在那里；本文写"何时抛、何时捕、副作用" |
| [`protocol.md`](protocol.md) | 本文 §3 引用其节点状态机；ZK 写入失败如何归类成错误码 |
| [`architecture.md`](architecture.md) §5 | 本文是其形式化版本；旧文档作为散文背景保留 |
| [`orchestration.md`](orchestration.md) §10 | 子进程重启策略与本文 §4 应保持一致；本文为协议来源 |
| [`package-layout.md`](package-layout.md) | 本文不规定包归属；具体错误类位于 `@co/contracts` |
