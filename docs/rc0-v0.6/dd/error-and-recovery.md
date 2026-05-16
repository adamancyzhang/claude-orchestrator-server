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
├── OrphanRetryExhaustedError        // 重试达上限
├── ChainConflictError               // chain_id 重写已关闭 chain
└── CommitFailedError                // git commit 真实失败
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

### 8.1 SelfEvaluator 格式错误重试（reject-only fallback）

最多 3 次，每次 `--fork-session` 消除锚定效应。3 次全失败时**强制输出 `reject` 决策**，不论当前 link：

```json
{
  "decision": "reject",
  "reason": "self-evaluation failed after 3 attempts (link=<link>) — see eval logs"
}
```

历史背景：在 v0.6 早期版本，fallback 是 `activate_next`（非 accept link）/ `close_chain`（accept link），导致评估器在 accept 失败时会"无声签字"绕过质量门。RC0 修复为 reject-only，使破损评估器一定停链。详见 `core/03-chain-progression.md` §self-evaluation-fallback。

### 8.2 CommitChecker 失败回退

```
claude -p 生成 commit message
  → 失败/输出空 → 回退: git commit -m "chore: auto-commit from {Name}"
  → git status --porcelain 干净（无变更可提交）→ check() 返回 null（合法短路）
  → git add / git commit 真实失败（pre-commit hook 拒绝、index 损坏等）
      → 抛 CommitFailedError，携带 stderr
      → WorkerWatcher 捕获后构造强制 feedback 决策：
        {
          "decision": "feedback",
          "feedback_to_worker": "git commit failed for <link> task <id>...",
          "feedback_target": <self instance_id>
        }
      → 走 Leader 的 feedback 分支，retry 同 link
```

详见 `core/02-task-claim-and-execute.md` §commit-failure。

## 9. MergeValidator 冲突处理

单个 commit 验证：
```
git checkout main
git merge --no-ff {worker_branch}
  → 冲突: git merge --abort → 抛 MergeConflictError
  → 成功: claude-cli 二次判断 → keep or 不操作
```

链级 `runMergeValidation`：

- 遍历 chain 内全部 commits（plan→build→verify→review→accept 顺序）。
- 收集每个失败为 `{link, sha, branch, message, error}`，**不再吞噬**。
- 全部完成后将失败列表返回给 `close_chain` 分支。

`close_chain` 收到失败列表：
- 非空 → ChainAudit `closeChain(chainId, "merge_failed", { failures })`、emit `chain_merge_failed` 事件、对每个失败 link 推送 retry task 给该 link 的 worker（manifest.link_workers 查表）。
- 空 → ChainAudit `closeChain(chainId, "completed")`。

详见 `core/04-merge-and-close.md` §merge_failed。

## 10. 链级反馈硬上限（retry-ceiling）

每条 chain 的 manifest 持久化两个字段：

```
total_retry_count   // ChainAudit.incrementRetry 原子递增
max_total_retries   // 默认 9；启动时 CO_CHAIN_MAX_RETRIES 覆写
```

`ChainRouter.dispatchFeedbackAsRetry` 入口前置：
1. `chain_audit.incrementRetry(chainId)` → `{total_retry_count, max_total_retries}`
2. 若 `total_retry_count > max_total_retries`：
   - 记 audit 事件 `retry_ceiling_exceeded`
   - `closeChain(chainId, "aborted", { reason: "retry_ceiling_exceeded", ... })`
   - 发射 `debug_info` 事件 + `chain_closed`
   - **不**派发新 task
3. 否则正常 push retry task

效果：A→B→A→B 无限反馈会在第 N+1 次被熔断，避免资源耗尽。

## 11. chain_id 重用拒绝（chain-id-reuse）

`ChainAudit.openChain` 写盘前 `readManifest(chainId)`：
- 存在 + `status !== "running"` → 抛 `ChainConflictError(chainId, existing_status, existing_completed_at)`
- 否则正常初始化

`ChainRouter.handleTaskDefinitions` catch 该错：
- 记日志 + emit `debug_info`（用户在 TUI 可见）
- 记 audit 事件 `chain_id_conflict`，payload 含 existing_status / completed_at / 当次需求 path
- 跳过本次需求（保留原 manifest 不变）

效果：审计文件不会出现 `completed → running → completed` 的混乱轨迹。

## 12. feedback target 不可解析（unresolved-target）

`resolveFeedbackTarget` 返回 `InstanceId | null`：
- 显式 `feedback_target` → 用之
- 否则 manifest.link_workers[PREV_LINKS[link]] → 用之
- 都没有 → 返回 null（v0.6 早期返回报告者自己 = 死循环风险）

ChainRouter.handleCompletionReport 的 feedback case 处理 null：
- 不派发新 task
- 记 audit 事件 `feedback_unresolved`
- 发射 `debug_info` 事件
- 不修改 chain status

## 13. ZK 会话事件响应矩阵

| 组件 | `disconnected` | `reconnected` | `expired` |
|------|---------------|---------------|-----------|
| Leader WorkerMonitor | 暂停事件 | 重新拉 `/instances` + diff | 重新 register + 重挂 watch |
| Leader TaskOrchestrator | 暂停事件 | 重新拉 tasks + 补发事件 | 同上 + Recovery 复扫 |
| Worker Watcher | 暂停消息处理 | 重挂 watch + 处理积压 | 重新 register + 重挂 watch |

### Worker expired 时的 in-flight 任务

Worker 在 ZK session expired 时**不**杀掉当前 claude -p 子进程。极端场景下可能双重提交，由 ChainRouter 校验 task 当前 status 是否为 `claimed by this instance` 来去重。

## 14. 新增错误码

| 错误码 | 类 | 含义 |
|--------|----|------|
| `CHAIN_ID_CONFLICT` | `ChainConflictError` | 试图重写已关闭 chain 的 manifest |
| `WORKER_COMMIT_FAILED` | `CommitFailedError` | `git commit` 真实失败（非"无变更"短路） |
