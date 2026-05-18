# Core Chain 5 — Worker 失联 → 孤儿检测 → 重试/归档（含 worktree 复用注记）

> **链路定位**：Worker 崩溃或 ZK Session 超时后，Recovery 检测孤儿 claimed 任务并按 retry_count 决定重新入队或归档。本文沿用 rc0 同名文件的恢复主流程，仅在 §2 补充 worktree 复用注记、§4 补充 rc1 新增的错误类清单。

## 1. 链路总览

```
Worker 子进程崩溃 / ZK Session 超时
    │
    ▼
/instances/{id} EPHEMERAL 自动删除     ← ZK 自动行为
/tasks/claimed/{id}-{task} EPHEMERAL 删除 ← ZK 自动行为
    │
    ▼
Leader 检测:
    ├─ 启动时: Recovery.scanOrphans()
    └─ 运行时: TaskOrchestrator ChildWatch 触发
    │
    ▼
reclaim(taskSnapshot):
    ├─ retry_count >= 3 → 归档 /tasks/completed/{id} (status=failed)
    └─ retry_count < 3  → retry_count++ → push /tasks/pending/task-{newSeq}
```

恢复路径主体行为参见 `docs/rc0-v0.6/core/05-recovery.md §2-§6`，rc1 未做修改。本文仅追加两点关注。

## 2. Worktree 复用注记（rc1 新增）

Leader 重启后再次执行 `initializeWorktrees` 时，若发现同名 worktree 已存在（上次 crash 留下来的），默认行为是**有损清理**：

```ts
// worktree-initializer.ts:177-201
if (existing && fs.existsSync(wtPath)) {
  if (resetOnReuse && leaderHead) {
    try {
      execGitArgs(["reset", "--hard", leaderHead], wtPath);
      execGitArgs(["clean", "-fdq"], wtPath);
      logger.info(`reused worktree ${name} reset to ${leaderHead.slice(0,8)}`);
    } catch (err) {
      logger.warn(`worktree ${name} reset failed; continuing without clean slate`, {...});
    }
  }
  // 仍复用同一 worktree_path + 同一分支
  configs.push({...});
  continue;
}
```

### 2.1 清理范围

- `git reset --hard <leaderHEAD>`：把该 worktree HEAD 回退到 Leader 启动时的分支 HEAD（即 main 当前状态），**抹除该 worktree 自己分支上的未推送 commit**——但因为分支共享 `.git`，那些 commit 实际仍存在于 `.git/objects` 内，只是该 worktree 的 reflog 不再引用。
- `git clean -fdq`：删除该 worktree 内所有 untracked files 与目录。

### 2.2 后果与边界

- **有意为之**：rc0 评估报告 Issue-6 指出旧实现复用脏 worktree 会让"上次 crash 中间态"延续到新任务，新一轮产物不可预测。rc1 通过 reset-on-reuse 收敛了这个风险。
- **代价**：任何未提交的 in-progress 工作（dirty index、untracked file）**被无声抹掉**。运行人员必须知晓"Leader 重启 = worktree 一次性回到 main"的语义。
- **未触及 git 历史**：reset 只动该 worktree 的 HEAD，前一轮成功的 commit 仍可通过 `git reflog` 或直接以 sha 访问；如果某个 commit 已经被 chain_audit 记入 manifest.link_commits，Leader 在重启后仍能通过 sha 调度它（虽然 v0.6 不实现 Leader 重启后断点续传链路）。
- **失败时降级**：`reset --hard` 或 `clean` 失败 → log warn，仍把该 worktree 加入 configs。降级运行不阻塞 Worker 上线，但下一任务可能在脏环境上跑——属于已知边界。

### 2.3 当不希望清理时

`initializeWorktrees` 选项 `reset_on_reuse: false` 关闭清理，目前**仅供测试**使用（需要观察 shutdown 后 worktree 状态的测试用例）。生产路径无暴露开关。

## 3. Recovery 与 chain manifest 的解耦关系

`reclaim(taskSnapshot)` 把孤儿任务以**新的 task id** 重新入队（rc0 §3 行为）。对 chain manifest 的影响：

- 旧 task id 已记在 `manifest.link_tasks[link]`，新 task id 在被 dispatch 时由 `setLinkTask` 覆盖。
- 已记录的 `manifest.link_commits[link]`（如果上一轮已 commit 才崩溃）**不会自动清理**——这是设计选择：
  - 如果失联发生在 Worker 完成 commit + 发完 completion_report 之后但 Leader 处理完之前：commit 已落地，下次 dispatch 不必重做（但本系统目前会重做，因为 Leader 不持久化"已收到 completion_report"状态，恢复后 task 仍 pending）
  - 重做时 `recordLinkCommit` 写入新 commit，自动覆盖旧记录（manifest.link_commits[link] = 最近一次记账）
  - 下游 link 通过 collectUpstreamCommits 拿到的永远是"最近一次 recordLinkCommit 的结果"

因此 Worker 失联 + 重启 + 重做的路径与 feedback retry 路径在 commit 记账上**幂等等价**。

## 4. rc1 新增错误类清单

`docs/rc0-v0.6/dd/error-and-recovery.md` 的错误类层级表尚未包含本次随 worktree 工作流引入的 4 个错误类。在 `dd/` 完整更新前，本节作为补丁文档：

| 错误类 | 定义位置 | 抛出位置 | 处理位置 |
|--------|---------|---------|---------|
| `RebaseConflictError` | `packages/contracts/src/errors.ts:114` | `packages/worker/src/watcher.ts:810-814`（pre-task rebase 冲突） | `watcher.ts:255-280` 走 `sendForcedFeedbackReport` |
| `WorktreeLockedError` | `packages/contracts/src/errors.ts` | `packages/leader/src/merge-validator.ts:208`（classifyGitError） | `chain-router.ts:884-890` categorize → `pushMergeConflictRetries` 跳过重试 |
| `GitPermissionError` | 同上 | `merge-validator.ts:211` | 同上，跳过重试 |
| `GitNetworkError` | 同上 | `merge-validator.ts:216` | 同上，跳过重试 |
| `CommitFailedError` | `packages/contracts/src/errors.ts` | `packages/worker/src/commit-checker.ts`（git add/commit 抛错） | `watcher.ts:534-545` 走 `sendForcedFeedbackReport`（rc0 R-01 已述） |

新错误码的语义边界：

| 错误 | 是否抛出到链路边界 | 是否触发任务重试 | 是否需要人工介入 |
|------|------------------|----------------|----------------|
| `RebaseConflictError` | 否（被 worker 捕获转 feedback） | 是（feedback retry） | 视具体冲突复杂度 |
| `CommitFailedError` | 否（同上） | 是（forced feedback retry） | 通常需要看 stderr |
| `MergeConflictError` | 是（chain-router 捕获分类） | 是（merge-conflict-fix retry） | 视冲突复杂度 |
| `WorktreeLockedError` | 是 | **否** | 是（运维需排查 git 锁占用） |
| `GitPermissionError` | 是 | **否** | 是（运维需修文件系统权限） |
| `GitNetworkError` | 是 | **否** | 是（外部网络恢复后人工触发） |

## 5. 链路产出（rc0 行为继承）

| 产出 | 说明 |
|------|------|
| `task_recovered` 事件 | 孤儿任务重新入队 |
| `task_failed` 事件 | retry_count >= 3 归档 |
| 重启的 Worker 子进程 | 父进程自动重启（最多 3 次） |
| EVENT LOG 记录 | TUI 显示恢复动作 |

## 6. 错误处理（rc0 行为继承 + rc1 注解）

| 场景 | 处理 |
|------|------|
| 孤儿 retry >= 3 | 归档 failed，抛 `OrphanRetryExhaustedError` |
| ZK 读取孤儿数据失败 | 跳过该孤儿，记录错误日志 |
| 重新 push 失败 | ZK 写入错误，重试 1 次后抛错到边界 |
| 子进程重启超 3 次 | 标记 worker.status = "failed"，发 worker_left 事件 |
| Leader 重启后 worktree 复用 reset 失败 | log warn，继续（rc1 注解，§2.2） |
| Leader 重启后 chain 半态 | v0.6 不实现 Leader 断点续传；半态 chain 需用户手动 abort 或重派需求 |
