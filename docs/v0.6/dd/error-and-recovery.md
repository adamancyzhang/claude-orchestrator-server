# Error & Recovery — v0.6 错误模型与恢复状态机

> **文档定位**：错误如何分类、在哪里抛、在哪里捕、出错后系统如何自愈的权威说明。
> 错误类定义见 `contracts.md` §7；ZK 写入语义见 `protocol.md`；核心恢复链路见 `core/05-recovery.md`。

## 1. 错误类层级

```
CoError                              // 根类
├── ZkError                          // ZK 相关
│   ├── ZkSessionExpiredError
│   ├── ZkNodeExistsError
│   └── ZkNodeNotFoundError
├── ValidationError                  // 协议校验失败
├── ProtocolVersionMismatchError     // 版本不兼容
├── ClaudeRunnerError                // claude-cli 执行失败
├── TemplateNotFoundError            // 模板缺失
├── HookError                        // Hook 失败（不冒泡）
├── MergeConflictError               // git merge 冲突
├── WorktreeError                    // worktree 异常
└── OrphanRetryExhaustedError        // 重试达上限
```

## 2. 稳定错误码

| 错误码 | 类 | 含义 |
|--------|----|------|
| `ZK_SESSION_EXPIRED` | `ZkSessionExpiredError` | ZK 会话过期 |
| `ZK_NODE_EXISTS` | `ZkNodeExistsError` | 节点已存在（leader 互斥/claim 抢锁） |
| `ZK_NODE_NOT_FOUND` | `ZkNodeNotFoundError` | 节点不存在 |
| `VALIDATION_FAILED` | `ValidationError` | Zod schema 校验失败 |
| `PROTOCOL_VERSION_MISMATCH` | `ProtocolVersionMismatchError` | 版本不一致 |
| `CLAUDE_RUNNER_EXIT_NON_ZERO` | `ClaudeRunnerError` | claude -p 退出码非 0 |
| `CLAUDE_RUNNER_SESSION_PARSE_FAILED` | `ClaudeRunnerError` | 无法提取 session_id |
| `TEMPLATE_NOT_FOUND` | `TemplateNotFoundError` | 模板不存在 |
| `HOOK_EXIT_NON_ZERO` | `HookError` | Hook 失败（仅日志） |
| `MERGE_CONFLICT` | `MergeConflictError` | git merge 冲突 |
| `WORKTREE_BUSY` | `WorktreeError` | worktree 被占用 |
| `WORKTREE_CREATE_FAILED` | `WorktreeError` | git worktree add 失败 |
| `ORPHAN_RETRY_EXHAUSTED` | `OrphanRetryExhaustedError` | 重试达 3 次 |
| `EVAL_DECISION_PARSE_FAILED` | `ValidationError` | EvalDecision JSON 不符合 schema |
| `CHAIN_DEF_PARSE_FAILED` | `ValidationError` | ChainDef JSON 不符合 schema |
| `MESSAGE_DELIVERY_FAILED` | `CoError` | 消息写入失败 |

## 3. 三个核心错误边界

| 边界 | 包 | 行为 |
|------|----|------|
| `LeaderWatcher.processMessage(msg)` | `@co/leader` | 单条消息失败 → 记 `debug_info` + 不影响其他消息 |
| `WorkerWatcher.processMessage(msg)` | `@co/worker` | 单条消息失败 → 发 completion_report(decision="reject") + 释放任务 |
| CLI 子命令 `handler(args)` | `@co/cli` | 命令失败 → 打印 `{ code, message }` + exit 非 0 |

## 4. 任务生命周期与 retry_count

```
push → pending → claim → claimed → complete → completed
                   ↑          │
                   │          ├── fail (retry < 3) → pending (retry++)
                   │          │        │
                   │          │        └── retry >= 3 → failed (archived)
                   │          │
                   │          └── instance lost → Recovery 检测
                   │                                    │
                   │                           retry < 3 → pending (retry++)
                   │                           retry >= 3 → failed (archived)
                   └──────────────────────────────────────┘
```

`MAX_RETRY = 3` 是协议常量，不开放配置。

## 5. 进程级恢复

### 5.1 Worker 子进程崩溃 → 父进程重启（最多 3 次）

```
parent fork(child.js) → child crash (exit != 0)
  → parent child.on("exit"): restart_count[name]++
  → restart_count <= 3 ? fork 重启 : 标记 failed, 放弃
```

`restart_count` 在父进程内存中维护，不持久化。

### 5.2 Worker 检测父进程死亡 → 自杀

```ts
setInterval(() => {
  try { process.kill(process.ppid, 0); } catch {
    process.exit(1);
  }
}, 1000);
```

### 5.3 Leader 崩溃 → 整体重启

- `/leader` EPHEMERAL 自动消失
- Worker 进入 idle 等待
- 操作员重新 `run --worker N`：
  - InitChecker 跳过已完成步骤
  - WorktreeInitializer 检测 worktree 已存在 → 跳过
  - new `/leader` + `Recovery.scanOrphans()`
  - 现存 Worker 继续工作

### 5.4 孤儿 claimed → pending 自动回收

Recovery 在以下时机执行：
1. Leader 启动时：`scanOrphans()` 一次性扫描
2. 运行时：`TaskOrchestrator` 监听 `/tasks/claimed` child watch，instance 不存在时回收

```ts
async function reclaim(taskSnapshot: Task) {
  if (taskSnapshot.retry_count >= MAX_RETRY) {
    await taskQueue.fail(taskSnapshot.id, "ORPHAN_RETRY_EXHAUSTED");
    return;
  }
  const next = { ...taskSnapshot, retry_count: taskSnapshot.retry_count + 1, status: "pending" };
  await taskQueue.push(toCreateInput(next));
  eventBus.emit({ type: "task_recovered", task_id: taskSnapshot.id });
}
```

## 6. Hook 失败隔离

Hook 错误绝不破坏主流程。每个 hook 独立 try-catch，最多 5s 超时，多个 hook 顺序执行，某条失败不影响后续。

## 7. ClaudeRunner 错误处理

| 退出码 | 含义 | 处理 |
|--------|------|------|
| 0 | 成功 | 提取 session_id |
| 1-127 | 业务失败 | 抛 `ClaudeRunnerError` |
| 130 (SIGINT) | 用户取消 | 抛 `ClaudeRunnerError(code="CLAUDE_RUNNER_CANCELLED")` |
| 137/143 | 进程被杀 | 抛 `ClaudeRunnerError(code="CLAUDE_RUNNER_KILLED")` |

## 8. SelfEvaluator 与 CommitChecker 容错

### SelfEvaluator 格式错误重试

最多 3 次，每次 `--fork-session` 消除锚定效应。仍失败 → 发 reject completion_report。

### CommitChecker 失败回退

```
claude -p 生成 commit message
  → 失败/输出空 → 回退: git commit -m "chore: auto-commit from {Name}"
  → git commit 仍失败（无变更）→ 跳过 commit，commit 字段 null
```

CommitChecker 错误不抛给主流程。

## 9. MergeValidator 冲突处理

```
git checkout main
git merge --no-ff {worker_branch}
  → 冲突: git merge --abort → 返回 { decision: "review_first", conflict_files: [...] }
  → 成功: claude-cli 二次判断 → keep or git reset --hard HEAD~1
```

MergeValidator 一定返回 MergeDecision，不向上抛错。

## 10. ZK 会话事件响应矩阵

| 组件 | `disconnected` | `reconnected` | `expired` |
|------|---------------|---------------|-----------|
| Leader WorkerMonitor | 暂停事件 | 重新拉 `/instances` + diff | 重新 register + 重挂 watch |
| Leader TaskOrchestrator | 暂停事件 | 重新拉 tasks + 补发事件 | 同上 + Recovery 复扫 |
| Worker Watcher | 暂停消息处理 | 重挂 watch + 处理积压 | 重新 register + 重挂 watch |

### Worker expired 时的 in-flight 任务

Worker 在 ZK session expired 时**不**杀掉当前 claude -p 子进程。极端场景下可能双重提交，由 ChainRouter 校验 task 当前 status 是否为 `claimed by this instance` 来去重。
