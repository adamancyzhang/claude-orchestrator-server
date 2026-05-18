# Core Chain 2 — 任务认领 → Pre-task Rebase → 执行 → 双轨提交 → 自评估

> **链路定位**：Worker 从 ZK 消息到达、认领任务、对 immediate predecessor 做 pre-task rebase、调用 claude-cli 执行、向项目仓与 CO root 仓双轨提交、自评估、到发送携 `commits` 字段的完成报告的全过程。本文重写自 rc0 同名文件，主要新增 §3 pre-task rebase 与 §6.2 docs commit 两节，以及 §7 完成报告新增 `commits` envelope 描述。

## 1. 链路总览

```
/messages/{worker_id}/msg-{seq}
    │
    ▼
WorkerWatcher.processMessage(msg)
    │
    ├─ Step 1: 解析 Message → 提取 link / chain_id / upstream_commits
    ├─ Step 2: 心跳 status=busy
    ├─ Step 3: 任务 pin 校验 + claimById（assigned_to ≠ self → dismiss）
    ├─ Step 4: pre-task rebase（仅 chain link，非 decompose）  ◄── rc1 关键节点
    ├─ Step 5: Hook worker_message_start
    ├─ Step 6: 渲染 worker-{role}-task.md + ClaudeRunner.run
    ├─ Step 7: 主任务结果校验（最多 3 次重试）
    ├─ Step 8: 提交（仅 chain link）
    │     ├─ 8.1 worktree commit（CommitChecker → 项目仓）  ◄── 失败走 forced feedback
    │     └─ 8.2 docs commit（WorkerDocsCommitter → CO root）◄── 失败 best-effort，不阻塞
    ├─ Step 9: 自评估 SelfEvaluator.evaluate（commit 失败则跳过）
    ├─ Step 10: 发送 completion_report（含 `commits` envelope）
    ├─ Step 11: task_queue.complete（claimed → completed）
    └─ Step 12: 心跳 status=idle + Hook worker_message_end
```

## 2. Step 1 — 解析消息

```ts
// watcher.ts:139-160
const link = msg.link as TaskLink | "decompose" | null;
const taskId = msg.task_id ?? asTaskId(`adhoc-${msg.id || Date.now().toString(36)}`);
const isChainLink = link !== null && CHAIN_LINKS.includes(link);
const realTaskId = isChainLink && msg.task_id ? msg.task_id as TaskId : null;
```

`msg.upstream_commits` 在解析阶段不消费，到 Step 4 才用。其结构（`packages/contracts/src/schemas/message.ts`）：

```ts
type UpstreamCommits = {
  plan?:   string | null;
  build?:  string | null;
  verify?: string | null;
  review?: string | null;
};
```

## 3. Step 4 — Pre-task Rebase（rc1 新增）

```ts
// watcher.ts:242-287
if (isChainLink && link !== "decompose") {
  const predecessor = pickImmediatePredecessor(link, msg.upstream_commits);
  if (predecessor) {
    try {
      await this.preTaskRebase(predecessor);
    } catch (err) {
      if (err instanceof RebaseConflictError) {
        await this.sendForcedFeedbackReport({...});
        await this.opts.message_router.dismiss(...);
        return;
      }
      // 非冲突错误：log warn 并继续（不阻塞链）
    }
  }
}
```

### 3.1 immediate predecessor 选择

`pickImmediatePredecessor(link, upstream)`（`watcher.ts:61-81`）按 plan/build/verify/review 顺序从当前 link **往前**找首个非空 worktree hash：

| 当前 link | 走查顺序 | 跳过条件 |
|----------|---------|---------|
| `plan` | — | 永远返回 null |
| `build` | 仅检查 `upstream.plan` | plan 无 worktree commit（如 plan 是纯文档）→ null |
| `verify` | `upstream.build` → `upstream.plan` | 都无 → null |
| `review` | `upstream.verify` → `upstream.build` → `upstream.plan` | 都无 → null |
| `accept` | `upstream.review` → `upstream.verify` → `upstream.build` → `upstream.plan` | 都无 → null |

设计意图：每个 link 的 immediate predecessor 已经 rebase 过它自己的上游，所以 rebase 到 immediate predecessor 等价于 rebase 整条上游历史；遇到中间 link 没有产生 worktree commit（例如 verify 只写了验证报告而无代码变更）时优雅退化到再上一级。

### 3.2 `preTaskRebase(targetSha)` 实现

`watcher.ts:732-818`：

```
1. `git merge-base --is-ancestor <targetSha> HEAD`
   exit 0 → 目标已是当前 HEAD 祖先 → 直接返回（短路）
   exit 1 → 需要 rebase
   其他 → log debug 继续尝试

2. 如果配置了 git_remote：
   `git fetch <remote> <targetSha>`（失败 → log debug，非致命）

3. `git rebase <targetSha>`
   成功 → log info 返回
   失败：
     a. `git diff --name-only --diff-filter=U` 收集 unmerged 路径
     b. `git rebase --abort`（失败 ignore）
     c. 若有 unmerged 路径 → 抛 `RebaseConflictError(message, conflicts)`
     d. 否则抛原始 err（unwrap 成 Error）
```

所有命令一律 `execFileSync("git", [args...])` 数组形式（详见 `worktree-foundation.md §6`）。

### 3.3 冲突处理 — forced feedback

冲突路径 `watcher.ts:255-280`：

```ts
await this.sendForcedFeedbackReport({
  link, msg, resultPath, taskId,
  stderr: `rebase onto ${predecessor.slice(0,8)} conflicted: ${err.conflict_files.join(", ")}`,
});
await this.opts.message_router.dismiss(this.opts.instance_id, msg.id);
return;
```

`sendForcedFeedbackReport`（`watcher.ts:828-854`）构造一个 `decision = "feedback"` 的 EvalDecision，`feedback_target = self`，文本指引该 Worker 用 `git status / git diff` 诊断冲突。Leader 收到后走标准 feedback 路径（计入 `total_retry_count`，超 `max_total_retries` 仍会终止链）。

非冲突错误（fetch 失败等）：log warn 但**不**走 forced feedback，继续 Step 5+。原因：rebase 偶发的网络/IO 抖动不应整链失败；真正的脏分支或上游消失会在后续 commit/merge 节点被发现。

## 4. Step 6 — 选择模板与渲染

```ts
// watcher.ts: LINK_TO_TASK_TEMPLATE
const LINK_TO_TASK_TEMPLATE = {
  plan:   "worker-planner-task.md",
  build:  "worker-builder-task.md",
  verify: "worker-verifier-task.md",
  review: "worker-reviewer-task.md",
  accept: "worker-accepter-task.md",
  decompose: "worker-decompose.md",
};
```

身份 system prompt 在 `child-boot.ts` 启动时一次性加载，不通过模板变量传递。模板变量包括 task_title / task_description / task_criteria / 上游 result.md 路径（`collectChainArtifacts` 从 manifest `link_tasks` 解析，`watcher.ts:604-650`）/ 工作目录路径等。

## 5. Step 7 — 主任务执行 + 结果校验

`ClaudeRunner.run({prompt, log_path, system_prompt, cwd: worktree_path, quiet})` 执行 claude-cli，`session_id` 从 stream-json 输出第一行 `system/init` 事件提取，后续 commit message / 自评估通过 `--resume <session_id>` 与 `--fork-session` 复用上下文。

结果校验最多 3 次（`MAX_GENERATION_RETRIES`）：
- `missing`：result.md 文件不存在
- `empty`：文件存在但为空
- `exit_code`：claude-cli 非零退出

3 次仍失败 → log error + `message_router.send(direct)` 把失败描述发给 Leader + `task_queue.fail(realTaskId, detail)`，链路在 Leader 侧走 task_failed 处理，**不**走 self-evaluator。

## 6. Step 8 — 双轨提交（rc1 新增视角）

仅 chain link 任务触发；decompose 与 `_generic` 不提交。

### 6.1 worktree commit（项目仓）

`watcher.ts:454-479`：

```ts
try {
  commit = await this.opts.commit_checker.check(
    { link, task_id, task_title, task_description },
    result.session_id ?? undefined,
  );
} catch (err) {
  if (err instanceof CommitFailedError) {
    commitFailure = err;   // 捕获，进入 forced feedback 路径（详见 §8）
  } else {
    throw err;
  }
}
```

`CommitChecker.check`（`packages/worker/src/commit-checker.ts`）行为：
1. `git status --porcelain` 干净 → 返回 null（合法短路，无副作用）
2. 调 claude-cli + `worker-commit-message.md` 生成 commit message（72 字符截断；失败回退 `chore: auto-commit from <Name>`）
3. `git add -A` + `git commit -m <message>`（cwd = worktree_path）
4. 失败 → 抛 `CommitFailedError(message, stderr)`

### 6.2 docs commit（CO root 仓）— rc1 新增

`watcher.ts:485-499`：

```ts
if (!commitFailure) {
  try {
    docsSha = await this.opts.docs_committer.commitIfChanged(
      { task_id, link, task_title },
      result.session_id ?? undefined,
    );
  } catch (err) {
    this.opts.logger.warn("docs commit threw unexpectedly", { error: String(err) });
  }
}
```

`WorkerDocsCommitter.commitIfChanged`（`docs-committer.ts:46-130`）：
1. `<co_root>/docs/<worker_name>/` 子目录不存在 → 返回 null
2. `git status --porcelain -- docs/<worker_name>` 为空 → 返回 null（log info）
3. 解析变更路径（含 `??` untracked）
4. 调 claude-cli + `worker-commit-message.md` 生成 message（失败回退 `docs(<Name>): auto-commit <YYYY-MM-DD>`）
5. `git add -- <paths>`（scope 到该 Worker 子目录）
6. `git commit --only -F <msgFile> -- <paths>`（`--only` 防止 index 中其他 Worker 已 staged 的文件被串入）
7. `git rev-parse HEAD` 取 sha 返回

为什么 docs commit 是 best-effort：
- CO root 是多 Worker 共享 `.git/index` 的高并发区，临时锁等可能导致 commit 失败；
- docs 是协作产物而非交付产物，丢失一次提交不影响 chain 推进；
- 提交并发安全已由 `--only` + `.git/index.lock`（git 自身）保证，因此 catch 块只 log，不重试不抛错。

### 6.3 memory_refresh（worktree commit 衍生消息）

仅当 worktree commit 成功且 changed_files 非空时（`watcher.ts:507-530`）：

```ts
this.opts.message_router.send({
  type: "memory_refresh",
  ...,
  content: JSON.stringify({
    chain_id, task_id,
    commit_sha: commit.sha,
    changed_files: commit.changed_files,
  }),
}).catch(...);  // best-effort
```

Leader 端 `handleMemoryRefresh`（`chain-router.ts:653-720`）转给 `MemoryBootstrap` 重生成对应 Source 文件的工作区记忆。此消息与 chain 推进解耦，不在本链路关注范围。

## 7. Step 10 — 完成报告携 `commits` envelope（rc1 关键）

`sendCompletionReport`（`watcher.ts:653-719`）：

```ts
const evalContent = await this.opts.evaluator.evaluate({...});

let body = evalContent;
if (commit || docsSha) {
  const json = JSON.parse(evalContent);
  json.commits = {
    worktree: commit?.sha ?? null,
    docs: docsSha,
    branch: this.opts.worktree_branch,
  };
  if (commit) {
    // 兼容旧 Leader：保留 legacy `commit` 字段
    json.commit = {
      sha: commit.sha,
      message: commit.message,
      branch: this.opts.worktree_branch,
      changed_files: commit.changed_files,
      untracked_files: commit.untracked_files,
    };
  }
  body = JSON.stringify(json);
}
```

最终发给 Leader 的 completion_report 内容形如：

```json
{
  "decision": "activate_next",
  "reason": "blueprint complete, all criteria met",
  "next_link": "build",
  "suggested_worker": null,
  "commits": {
    "worktree": "f3a2c4...",
    "docs": "1b8d9e...",
    "branch": "claude-orchestrator/Tom-workspace"
  },
  "commit": {
    "sha": "f3a2c4...",
    "message": "feat(plan): authentication module blueprint",
    "branch": "claude-orchestrator/Tom-workspace",
    "changed_files": [".claude-orchestrator/docs/Tom/.../plan-001.md"],
    "untracked_files": []
  }
}
```

`commits.{worktree,docs}` 任一可为 `null`（纯文档任务、docs 提交失败、本 link 无变更）；`branch` 永远是该 Worker 的固定分支名。

## 8. commit-failure 分支（rc0 §12 行为继承 + rc1 注解）

`CommitChecker.check` 抛 `CommitFailedError` 时（git status/add/commit 抛错，非"无变更"），`watcher.ts:534-555` 走 forced feedback 路径：

```
1. 跳过 docs commit（commitFailure 非 null → §6.2 if 不进入）
2. 跳过 memory_refresh
3. 跳过 self-evaluate
4. sendForcedFeedbackReport({link, msg, resultPath, taskId, stderr: err.stderr})
     构造 {decision:"feedback", feedback_target: self, feedback_to_worker: "..."}
     直接发给 Leader，无 evaluator 介入
5. task_queue.complete（claimed → completed）
6. dismiss 消息
```

Leader 收到后走标准 feedback 路径（重新 push retry 给同一 worker），计入 `total_retry_count`。

rc1 注解：pre-task rebase 冲突走的也是 `sendForcedFeedbackReport`（§3.3），与 commit 失败共用同一通道。两者在 Leader 侧无需区分——`dispatchFeedbackAsRetry`（`chain-router.ts:1072-1198`）一视同仁地 push retry 任务、清理下游 commit、再派发。

## 9. 链路产出（rc1 全量）

| 产出 | 位置 | 说明 |
|------|------|------|
| 任务日志 | `<cache_dir>/<leader_id>/tasks/<task_id>/exec-<ts>.log` | claude-cli stream-json 完整流 |
| 任务结果 | `<cache_dir>/<leader_id>/tasks/<task_id>/result.md` | Worker 按 link 产出，被下游 link 通过 manifest.link_tasks 读取 |
| Worker 自留副本 | `<cache_dir>/<leader_id>/docs/<worker>/<date>/<prefix>-<chain_id>.md` | 同任务备份；属于 CO root scope，进入 docs commit |
| **项目仓 commit** | `claude-orchestrator/<Name>-workspace` 分支 | 代码变更；rc1 由 `CommitChecker` 触发 |
| **CO root docs commit** | CO root 默认分支 | 该 Worker 写的 `docs/<Name>/...` 子目录文档；rc1 由 `WorkerDocsCommitter` 触发 |
| 评估日志 | `<cache_dir>/<leader_id>/tasks/<task_id>/eval-<N>.log` | 最多 3 次 |
| 完成报告 | `/messages/<leader_id>/msg-{seq}` | EvalDecision + **`commits` envelope**（rc1 新增） |
| memory_refresh 消息 | `/messages/<leader_id>/msg-{seq}` | best-effort，独立于 chain 推进 |

## 10. 错误处理（rc1 增量）

| 场景 | 处理 |
|------|------|
| `RebaseConflictError`（rebase 冲突） | sendForcedFeedbackReport + dismiss 消息，链走 feedback 路径 |
| Pre-task rebase 非冲突错误（fetch 失败等） | log warn，**继续**执行后续步骤 |
| `git status --porcelain` 干净（无变更） | `commit_checker.check` 返回 null；`docs_committer.commitIfChanged` 同 scope 检测后返回 null；走正常 self-evaluate + activate_next 路径 |
| `CommitFailedError`（worktree commit 抛错） | forced feedback（rc0 §12 行为，仍是同一通道） |
| docs commit 抛错 | log warn，`docsSha=null`，**继续** worktree commit 与 self-evaluate（best-effort 语义） |
| 任务 `assigned_to ≠ self` | dismiss 消息，让真正的 assignee 抓取 |
| 主任务输出 3 次校验失败 | 发 direct 失败描述 + `task_queue.fail`，**不**自评估 |
| Self-evaluator 3 次失败 | 强制 `reject`（rc0 R-03，行为不变） |
