# 05 — Step 9：Review 链环节（Mia 处理 task-0000000004）

> 入口状态：Mia 收件箱有 `msg-0000000001`（task_dispatch, link=review, task_id=task-0000000004, assigned_to=mia-01）。
> 出口状态：Mia 发完成报告，Leader 复用 `task-0000000005`（accept link）派给 Leo（或 reject → close_chain，或 feedback → 自动物化为 retry verify task 派回 Lucy）。

## 8.1–8.3 同前

- `registry.heartbeat(busy)` + `task_queue.claimById(task-0000000004, mia-01)` + `task_claimed` hook fire
- 模板：`templates/agents/worker-reviewer-task.md`（per-task wrapper），system prompt = `worker-reviewer.md` + `personal-claude-reviewer.md`（boot 时载入并已渲染 `{{name}}`）
- skill：`task-review`
- hook CO_LINK=`review`

## 8.4 模板渲染差异

上游 artifact 要求**三份**（`templates/agents/worker-reviewer-task.md`）：

```markdown
## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Builder traceability map: `{{upstream_build_artifact}}`
3. Verifier verification map: `{{upstream_verify_artifact}}`

If any of the three upstream artifacts is missing, write a single-line BLOCKED report to `result_path` naming the missing artifact and stop.
```

✅ **issue #10 修复**：Mia 通过 chain-shared cache 路径读 3 份上游 artifact：
- `{{upstream_plan_artifact}}` = `~/.../projects/leader-01/tasks/task-0000000001/result.md`（Tom 的 blueprint）
- `{{upstream_build_artifact}}` = `~/.../projects/leader-01/tasks/task-0000000002/result.md`（Jerry 的 traceability-map）
- `{{upstream_verify_artifact}}` = `~/.../projects/leader-01/tasks/task-0000000003/result.md`（Lucy 的 verification-map）

由 `WorkerWatcher.collectChainArtifacts` 从 chain manifest 解析得到。

✅ **本轮治理**：`{{task_doc_path}}` 行已从模板移除。

## 8.5 主任务

```bash
cd ~/work/co-pagination/.worktrees/Mia
claude --append-system-prompt '<Mia identity (reviewer)>' \
       -p '<rendered worker-reviewer-task.md>' \
       --output-format stream-json --verbose \
  > ~/.claude-orchestrator/projects/leader-01/tasks/task-0000000004/exec-<ts>.log
```

期望生成文件：

| 路径 | 内容 |
|------|------|
| `~/.../projects/leader-01/tasks/task-0000000004/result.md` | review-judgment.md 副本（Leader / 下游 worker 视角） |
| `~/.../projects/leader-01/docs/Mia/2026-05-14/review-chain-pagination-001.md` | local_doc_path 副本 |
| `~/work/.../worktrees/Mia/.claude-orchestrator/docs/Mia/2026-05-14/review-judgment.md` | worktree 副本 |
| `~/work/.../worktrees/Mia/.claude-orchestrator/docs/Mia/2026-05-14/CLAUDE.md` | 当日记忆 |

**review-judgment.md 内容示意**（基于贯穿样例的 FAILURE）：

```markdown
# Review Judgment — /api/users 分页

| Plan Intent | Build Result | Verify Finding | Review |
|-------------|--------------|----------------|--------|
| 分页接口签名 & 默认值 | 接口已实现 / 默认值正确 | PASS | ACCEPT |
| page 校验 | 已加 page>=1 | PASS | ACCEPT |
| page_size 范围 1..100 | 仅校验 >=1，未限上限 | FAILURE | **CONCERN** — Builder 需补 page_size<=100 |
| 响应结构 | total/page/page_size/items 齐全 | PASS | ACCEPT |
| 4xx 错误 | 错误码齐全 | PASS | ACCEPT |

Decision: **FEEDBACK** — 1 concern needs fix by Builder before accept.
Specific fix: Add `page_size > 100 → 400 INVALID_PAGE_SIZE` in users-service.ts:34.
```

## 8.6 hook worker_message_end + CommitChecker

只产出 markdown，不改业务代码。commit log 落 `projects/leader-01/tasks/task-0000000004/commit.log`。

## 8.7 SelfEvaluator — Review 三条决策分支

`NEXT_LINKS["review"] = "accept"`。Review 决策可能：

### 8.7.A activate_next（PASS）— 默认走向

```json
{
  "decision": "activate_next",
  "reason": "All 5 plan intents accepted with 1 minor concern documented for Accepter awareness",
  "next_link": "accept"
}
```

### 8.7.B feedback（要补救）

```json
{
  "decision": "feedback",
  "reason": "page_size>100 unrejected — concern needs Builder fix before accept",
  "feedback_to_worker": "Builder: add page_size<=100 validation in users-service.ts:34, return 400.",
  "feedback_target": null
}
```

✅ **issue #6 修复 + 本轮治理**：Mia 不指定 `feedback_target` 时，`ChainRouter.resolveFeedbackTarget` 读 `manifest.link_workers[PREV_LINKS["review"]]` = `link_workers.verify` = Lucy（verify worker）；持久化到 chain manifest，Leader 重启可恢复。

⚠️ 业务语义注意：Review 默认 feedback 目标是 Verifier。若 Mia 想直接把问题打回 Builder，需显式 `feedback_target = jerry-01`，或通过 Verifier 中转。

✅ **本轮治理（feedback 物化为 retry task）**：Leader 收到 review feedback 后，`dispatchFeedbackAsRetry` 会 push 一条 retry verify task（同 `04` §7.9.1 机制），`description = feedback_to_worker`，assign 给 Lucy（或 Mia 显式指定的 target）。Lucy 走标准 claimById → run → evaluate 循环；新 task_id 进入 chain manifest 的 link_tasks.verify，旧 task-0000000003 仍在 completed/ 中供审计。

### 8.7.C reject

`worker-evaluate.md` 决策枚举（修复后）现在包含 `reject`；schema 也支持。Review 拒收时输出：

```json
{
  "decision": "reject",
  "reason": "Implementation fundamentally diverges from blueprint architecture — restart required"
}
```

`ChainRouter.handleCompletionReport()` 对 `reject` 走专属分支：

```typescript
case "reject": {
  if (msg.chain_id) {
    if (this.opts.chain_audit) {
      await this.opts.chain_audit.closeChain(msg.chain_id, "aborted", { reason: "evaluator_reject" });
    }
    this.emitChainClosed(msg.chain_id);
    this.forgetChain(msg.chain_id);
  }
  break;
}
```

- ChainAudit `closeChain(chainId, "aborted")` 把 manifest.status 设为 `aborted` 并 append `chain_closed` 事件（payload.reason="evaluator_reject"）；
- emit `chain_closed` → TUI 显示链关闭；
- `forgetChain` 清理 chainCommits 内存（reject 不触发 MergeValidator —— 语义是"彻底回退，不进主线"）；
- 整条链就此终止；前面 commit 留在各自分支，但没人 merge 到主分支。

本贯穿样例假设 Mia 走 **8.7.A（activate_next）**，把 concern 留给 Accepter 在业务层面判定（与 personal-claude-reviewer.md 的"PASS — Ready for Accept" 一致）。

## 8.8 完成报告

`task_queue.complete` → `/tasks/completed/task-0000000004`，`task_completed` hook fire。

ZK 路径：`/messages/leader-01/msg-0000000005`

```json
{
  "id": "msg-0000000005",
  "type": "completion_report",
  "from_instance": "mia-01",
  "from_name": "Mia",
  "from_role": "reviewer",
  "to_instance": "leader-01",
  "to_name": null,
  "content": "{\"decision\":\"activate_next\",\"reason\":\"All 5 plan intents accepted with 1 minor concern documented for Accepter awareness\",\"next_link\":\"accept\",\"commit\":{\"sha\":\"a1b2c3d4e5f60718293a4b5c6d7e8f9012345abcd\",\"message\":\"review(users): 5 ACCEPT 1 CONCERN — page_size>100 unrejected\",\"branch\":\"co/mia-01\",\"changed_files\":[],\"untracked_files\":[\".claude-orchestrator/docs/Mia/2026-05-14/review-judgment.md\",\".claude-orchestrator/docs/Mia/2026-05-14/CLAUDE.md\"]}}",
  "link": "review",
  "task_id": "task-0000000004",
  "chain_id": "chain-pagination-001",
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "result_path": "~/.claude-orchestrator/projects/leader-01/tasks/task-0000000004/result.md",
  "original_requirement_path": null,
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:11:00.000Z"
}
```

## 8.9 Leader 路由 → 激活 Accept

`ChainRouter.handleCompletionReport` `activate_next + next_link=accept`：
- `findOrCreatePendingTask("chain-pagination-001", "accept")` → 复用 `task-0000000005`
- `findIdleWorkerByRole("accepter")` → Leo
- `task_queue.assign(task-0000000005, leo-01)`
- `chain_audit.setLinkTask("accept", task-0000000005)` + `setLinkWorker("accept", leo-01)`
- `message_router.send(task_dispatch → leo-01)` → `/messages/leo-01/msg-0000000001`

## Review 环节产物清单

### ZK 新增

| 路径 | 备注 |
|------|------|
| `/tasks/claimed/mia-01-task-0000000004` | EPHEMERAL（短暂） |
| `/tasks/completed/task-0000000004` | PERSISTENT |
| `/messages/leader-01/msg-0000000005` | Mia 完成报告 |
| `/messages/leo-01/msg-0000000001` | task_dispatch → Leo |

### ZK 修改

| 路径 | 修改 |
|------|------|
| `/tasks/pending/task-0000000004` | 8.1 删除（claim 时）|
| `/tasks/pending/task-0000000005` | `assigned_to` 设为 `leo-01` |
| `/messages/mia-01/msg-0000000001` | **删除** |
| `/messages/leader-01/msg-0000000005` | `read=true` |
| `/instances/mia-01` | status: idle → busy → idle |

### Cache 文件（projects/leader-01/）

| 路径 | 来源 |
|------|------|
| `tasks/task-0000000004/exec-<ts>.log` | claude-cli 主执行 stream-json |
| `tasks/task-0000000004/result.md` | review-judgment.md |
| `tasks/task-0000000004/commit.log` | commit message 调用日志 |
| `tasks/task-0000000004/eval-{0,1,2}.log` | self-eval 调用日志 |
| `docs/Mia/2026-05-14/review-chain-pagination-001.md` | local_doc_path 副本 |
| `chains/chain-pagination-001/manifest.json` | `link_tasks.accept = task-0000000005`、`link_workers.accept = leo-01` 更新 |
| `chains/chain-pagination-001/audit.jsonl` | append `completion_report`（review）+ `task_dispatch`（accept）两行 |

### Worktree 内文件（Mia 分支）

| 路径 | 内容 |
|------|------|
| `~/work/.../worktrees/Mia/.claude-orchestrator/docs/Mia/2026-05-14/review-judgment.md` | 评审判断 |
| `~/work/.../worktrees/Mia/.claude-orchestrator/docs/Mia/2026-05-14/CLAUDE.md` | 当日记忆 |

### Git commit

| 分支 | SHA | message |
|------|-----|---------|
| `co/mia-01` | `a1b2c3d4...` | `review(users): 5 ACCEPT 1 CONCERN — page_size>100 unrejected` |

## 衔接到 Step 10

Leo 的 `WorkerWatcher` 触发，进入最后一个链环节。详见 [`06-accept-and-close.md`](./06-accept-and-close.md)。
