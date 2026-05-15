# 04 — Step 8：Verify 链环节（Lucy 处理 task-0000000003）

> 入口状态：Lucy 收件箱有 `msg-0000000001`（task_dispatch, link=verify, task_id=task-0000000003, assigned_to=lucy-01）。
> 出口状态：Lucy 发完成报告，Leader 复用 `task-0000000004`（review link）派给 Mia（或 feedback 物化为 build retry task 派回 Jerry）。

## 7.1–7.3 同 Plan/Build

- `registry.heartbeat(busy)` + `task_queue.claimById(task-0000000003, lucy-01)` + `task_claimed` hook fire
- `LINK_TO_TASK_TEMPLATE["verify"]` → `worker-verifier-task.md`（per-task wrapper）；system prompt 是 boot 时载入的 `worker-verifier.md` + `personal-claude-verifier.md`（`{{name}}` 已替换为 Lucy）
- hook `worker_message_start`：CO_LINK=`verify`

## 7.4 模板渲染差异

- skill：`task-verification`
- 上游 artifact 要求**两份**：Planner blueprint + Builder traceability-map（`templates/agents/worker-verifier-task.md`）：

```markdown
## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Builder traceability map: `{{upstream_build_artifact}}`

If either upstream artifact is missing, write a single-line BLOCKED report to `result_path` naming the missing artifact and stop — do not invent results.
```

✅ **issue #10 修复**：跨 worktree artifact 通过 chain-shared cache 路径传递。Lucy 直接从：
- `{{upstream_plan_artifact}}` = `~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/result.md`（manifest.link_tasks.plan 解析得到）
- `{{upstream_build_artifact}}` = `~/.claude-orchestrator/projects/leader-01/tasks/task-0000000002/result.md`

读 Tom 与 Jerry 的产物，不再依赖 git 分支跨 worktree 同步。

✅ **本轮治理**：`{{task_doc_path}}` 行已从模板移除（schema 字段也已删除）。缺上游 artifact 时 Lucy 写 BLOCKED 到 result_path 然后停。

## 7.5 主任务 claude-cli

调用形态：

```bash
cd ~/work/co-pagination/.worktrees/Lucy
claude --append-system-prompt '<Lucy identity (verifier)>' \
       -p '<rendered worker-verifier-task.md>' \
       --output-format stream-json --verbose \
  > ~/.claude-orchestrator/projects/leader-01/tasks/task-0000000003/exec-<ts>.log
```

期望生成文件：

| 路径 | 内容 |
|------|------|
| `~/.../projects/leader-01/tasks/task-0000000003/result.md` | verification-map.md（Leader / 下游 worker 视角） |
| `~/.../projects/leader-01/docs/Lucy/2026-05-14/verify-chain-pagination-001.md` | local_doc_path：同上副本 |
| `~/work/.../worktrees/Lucy/.claude-orchestrator/docs/Lucy/2026-05-14/verification-map.md` | worktree 副本（Lucy 可能也写一份） |
| `~/work/.../worktrees/Lucy/.claude-orchestrator/docs/Lucy/2026-05-14/evidence/*.log` | 测试证据（Lucy 跑的） |
| `~/work/.../worktrees/Lucy/.claude-orchestrator/docs/Lucy/2026-05-14/CLAUDE.md` | 当日记忆 |

**verification-map.md 内容示意**：

```markdown
# Verifier Verification Map — /api/users 分页

| Plan Requirement | Builder Output | Verified By | Status |
|------------------|----------------|-------------|--------|
| 接口签名 | controller.ts:55 | curl -G /api/users → 200 | PASS |
| page>=1 校验 | service.ts:23 | curl page=0 → 400 ✓ | PASS |
| page_size 范围 | service.ts:34 | curl page_size=200 → **200 ⚠️** | FAILURE |
| 默认值 | service.ts:18 | curl /api/users → page=1/page_size=20 | PASS |
| 响应结构 | controller.ts:62 | jsonschema validate ✓ | PASS |
| 4xx 错误 | controller.ts:78 | error code present | PASS |

Findings: 1 FAILURE — page_size>100 未拒绝。
Recommendation: needs fixes by Builder (Jerry)
```

## 7.6 hook worker_message_end + CommitChecker

`git status` 通常有 `verification-map.md` + `evidence/` 等新文件。Lucy 的 commit 不改动业务代码。

`CommitResult`：

```json
{
  "sha": "9e6f5c4d1b3a7e8f0d6c5b4a3e2f10987654cdef",
  "message": "verify(users): 1 FAILURE — page_size>100 not rejected",
  "changed_files": [],
  "untracked_files": [
    ".claude-orchestrator/docs/Lucy/2026-05-14/verification-map.md",
    ".claude-orchestrator/docs/Lucy/2026-05-14/evidence/curl-page-size-200.log",
    ".claude-orchestrator/docs/Lucy/2026-05-14/CLAUDE.md"
  ]
}
```

commit log 落 `projects/leader-01/tasks/task-0000000003/commit.log`。

## 7.7 SelfEvaluator — Verify 的两条决策分支

`NEXT_LINKS["verify"] = "review"`。Verify 的 self-eval 决策决定下一步：

### 7.7.A 决策 1 — activate_next（一切 PASS / FAILURE 由下游处理）

```json
{
  "decision": "activate_next",
  "reason": "all checklist items verified; 1 FAILURE forwarded for downstream judgment",
  "next_link": "review"
}
```

Verifier 自己不发 feedback，而是把 FAILURE 留给 Reviewer 在更高层判定（这是 `personal-claude-verifier.md` 鼓励的做法："独立检查"，不做架构判断）。

### 7.7.B 决策 2 — feedback（要 Builder 修）

```json
{
  "decision": "feedback",
  "reason": "FAILURE: page_size>100 not rejected",
  "feedback_to_worker": "Add check: page_size must be <=100, return 400 with code=INVALID_PAGE_SIZE",
  "feedback_target": null
}
```

✅ **issue #3 修复**：模板字段名已对齐 schema，feedback 路径能被正常接受。

本贯穿样例假设 Lucy 走 `activate_next`（决策 A），把 FAILURE 交给 Mia。

## 7.8 完成报告 + 收尾

`task_queue.complete` → `/tasks/completed/task-0000000003`，`task_completed` hook fire。`processMessage` finally 写回 idle。

ZK 路径：`/claude-orchestrator/messages/leader-01/msg-0000000004`

```json
{
  "id": "msg-0000000004",
  "type": "completion_report",
  "from_instance": "lucy-01",
  "from_name": "Lucy",
  "from_role": "verifier",
  "to_instance": "leader-01",
  "to_name": null,
  "content": "{\"decision\":\"activate_next\",\"reason\":\"all checklist items verified; 1 FAILURE forwarded for downstream judgment\",\"next_link\":\"review\",\"commit\":{\"sha\":\"9e6f5c4d1b3a7e8f0d6c5b4a3e2f10987654cdef\",\"message\":\"verify(users): 1 FAILURE — page_size>100 not rejected\",\"branch\":\"co/lucy-01\",\"changed_files\":[],\"untracked_files\":[\".claude-orchestrator/docs/Lucy/2026-05-14/verification-map.md\",\".claude-orchestrator/docs/Lucy/2026-05-14/CLAUDE.md\"]}}",
  "link": "verify",
  "task_id": "task-0000000003",
  "chain_id": "chain-pagination-001",
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "result_path": "~/.claude-orchestrator/projects/leader-01/tasks/task-0000000003/result.md",
  "original_requirement_path": null,
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:08:30.000Z"
}
```

## 7.9 Leader 路由 → 激活 Review

`ChainRouter.handleCompletionReport()` `activate_next + next_link=review`：
- `findOrCreatePendingTask("chain-pagination-001", "review")` → 复用 `task-0000000004`
- `findIdleWorkerByRole("reviewer")` → Mia
- `task_queue.assign(task-0000000004, mia-01)`
- `chain_audit.setLinkTask("review", task-0000000004)` + `setLinkWorker("review", mia-01)`
- `message_router.send(task_dispatch → mia-01)` → `/messages/mia-01/msg-0000000001`

### 7.9.1 ✅ feedback 分支已物化为 retry task

如果 Lucy 输出 `decision=feedback`，`ChainRouter.handleCompletionReport()` 走 feedback 分支 —— **本轮治理后行为完全更换**：

```typescript
case "feedback": {
  const targetId = await this.resolveFeedbackTarget(msg, decision.feedback_target ?? null);
  await this.dispatchFeedbackAsRetry({ msg, targetId, feedback: decision.feedback_to_worker, requirementPath });
  break;
}
```

`dispatchFeedbackAsRetry` 三步走（`packages/leader/src/chain-router.ts`）：

1. **目标 link 解析**：`prevLink = PREV_LINKS[msg.link] ?? msg.link` → verifier feedback 时 prevLink = `"build"`，target = Jerry
2. **push 新 retry task**：`task_queue.push({ link: "build", retry_count: priorRetry+1, description: feedback_to_worker, assigned_to: jerry-01, ... })` → 新 task_id（例如 `task-0000000006`）。priorRetry 来自查 `task_queue.getCompleted(msg.task_id)` 或 manifest link_tasks 路径上的最新 task。
3. **ChainAudit + dispatch**：`chain_audit.setLinkTask("build", new_task_id)` 把 manifest 的 build link 切到新任务；`setLinkWorker("build", jerry-01)`；`record('feedback_sent', payload={feedback_to_worker, retry_count, target_link})`；最后 `message_router.send({type:"task_dispatch", to_instance: jerry-01, task_id: new_task_id, link: "build", task_description: feedback_to_worker, ...})`

Worker 端走标准 claimById → run → evaluate 流程，与首次 build 完全一致。Jerry 收到的 task_description 是 Lucy 写的 feedback 文本，task_criteria 为空字符串（feedback 通常不带新 criteria）。

✅ **issue #6 修复 + 持久化**：`resolveFeedbackTarget` 优先级 = ① `decision.feedback_target`（显式指定）→ ② `manifest.link_workers[prev_link]`（从 chain audit manifest 读，持久化）→ ③ `msg.from_instance`。Leader 进程重启后通过读 manifest 仍能恢复 prev-link worker 映射，旧版本的 `chainWorkers` 内存 Map 已完全删除。

旧 completed task（首次 build 的 `task-0000000002`）在 `/tasks/completed/` 与 `tasks/task-0000000002/result.md` 中保留，审计可追溯。新 retry task 在 `/tasks/pending/` 起新轮，进入 claim → complete 标准流程。

## Verify 环节产物清单

### ZK 新增

| 路径 | 备注 |
|------|------|
| `/tasks/claimed/lucy-01-task-0000000003` | EPHEMERAL（短暂）|
| `/tasks/completed/task-0000000003` | PERSISTENT |
| `/messages/leader-01/msg-0000000004` | Lucy 完成报告 |
| `/messages/mia-01/msg-0000000001` | task_dispatch → Mia（activate_next 分支） |

### ZK 修改

| 路径 | 修改 |
|------|------|
| `/tasks/pending/task-0000000003` | 7.1 删除（claim 时）|
| `/tasks/pending/task-0000000004` | `assigned_to` 设为 `mia-01` |
| `/messages/lucy-01/msg-0000000001` | **删除** |
| `/messages/leader-01/msg-0000000004` | `read=true` |
| `/instances/lucy-01` | status: idle → busy → idle |

### Cache 文件（projects/leader-01/）

| 路径 | 来源 |
|------|------|
| `tasks/task-0000000003/exec-<ts>.log` | claude-cli 主执行 stream-json |
| `tasks/task-0000000003/result.md` | verification-map.md |
| `tasks/task-0000000003/commit.log` | commit message claude 调用日志 |
| `tasks/task-0000000003/eval-{0,1,2}.log` | self-eval claude 调用日志 |
| `docs/Lucy/2026-05-14/verify-chain-pagination-001.md` | local_doc_path 副本 |
| `chains/chain-pagination-001/manifest.json` | `link_tasks.review = task-0000000004`、`link_workers.review = mia-01` 更新 |
| `chains/chain-pagination-001/audit.jsonl` | append `completion_report`（verify）+ `task_dispatch`（review）两行 |

### Worktree 内文件（Lucy 分支）

| 路径 | 内容 |
|------|------|
| `~/work/.../worktrees/Lucy/.claude-orchestrator/docs/Lucy/2026-05-14/verification-map.md` | 验证表 |
| `~/work/.../worktrees/Lucy/.claude-orchestrator/docs/Lucy/2026-05-14/evidence/*.log` | 证据 |
| `~/work/.../worktrees/Lucy/.claude-orchestrator/docs/Lucy/2026-05-14/CLAUDE.md` | 当日记忆 |

### Git commit

| 分支 | SHA | message |
|------|-----|---------|
| `co/lucy-01` | `9e6f5c4d...` | `verify(users): 1 FAILURE — page_size>100 not rejected` |

## 衔接到 Step 9

Mia 的 `WorkerWatcher` 触发。详见 [`05-review-link.md`](./05-review-link.md)。
