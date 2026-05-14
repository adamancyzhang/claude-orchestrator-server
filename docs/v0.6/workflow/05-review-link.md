# 05 — Step 9：Review 链环节（Mia 处理 task-0000000008）

> 入口状态：Mia 收件箱有 `msg-0000000001`（task_dispatch, link=review, task_id=task-0000000008）。
> 出口状态：Mia 发完成报告，Leader 激活 Accept，派给 Leo（或 reject → close_chain，或 feedback → Mia 自己）。

## 8.1–8.3 同前

- 不走 claim
- 模板：`templates/agents/worker-review.md`，skill：`task-review`
- hook CO_LINK=`review`

## 8.4 模板渲染差异

上游 artifact 要求**三份**（`templates/agents/worker-review.md:18-22`）：

```
**Trace — Read all three upstream artifacts (required)**:
1. `.claude-orchestrator/docs/{planner_name}/YYYY-MM-DD/blueprint.md`
2. `.claude-orchestrator/docs/{builder_name}/YYYY-MM-DD/traceability-map.md`
3. `.claude-orchestrator/docs/{verifier_name}/YYYY-MM-DD/verification-map.md`
Fallback: `{{task_doc_path}}`. If any is missing → cannot review, report to Leader.
```

⚠️ 同 Verify：跨 worktree artifact 传递问题在 Review 进一步累积——Mia 需要看 3 个不同分支的 artifact。

## 8.5 主任务

```bash
cd ~/work/co-pagination/.worktrees/Mia
claude --append-system-prompt '<Mia identity (reviewer)>' \
       -p '<rendered worker-review.md>' \
       --output-format stream-json --verbose \
  > ~/.claude-orchestrator/cache/leader-01/logs/task-0000000008-<ts>.log
```

期望生成文件：

| 路径 | 内容 |
|------|------|
| `~/.../cache/leader-01/results/task-0000000008.md` | review-judgment.md 副本 |
| `~/work/.../worktrees/Mia/.claude-orchestrator/docs/Mia/2026-05-14/review-judgment.md` | 判断 |
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

## 8.6 CommitChecker

只产出 markdown，不改业务代码。

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

✅ **issue #6 修复**：Mia 写 `feedback_to_worker` 但不指定 `feedback_target` 时，`ChainRouter.resolveFeedbackTarget` 会按 PREV_LINKS["review"]="verify" 查 chain 的 verify worker（Lucy）。✅ **issue #3 修复**：模板字段名已与 schema 对齐，feedback 分支可被 schema 接受。

注：Review 默认 feedback 目标是 Verifier，因为 PREV_LINKS["review"]="verify"——若 Mia 想要 Builder 修复，需显式 `feedback_target = jerry-01` 或借助 Verifier 中转。

### 8.7.C reject / close_chain

`worker-evaluate.md` 决策枚举（修复后）现在包含 `reject`；schema 仍同时支持 `reject` 与 `close_chain`。Review 拒收时输出：

```json
{
  "decision": "reject",
  "reason": "Implementation fundamentally diverges from blueprint architecture — restart required"
}
```

`ChainRouter.handleCompletionReport()`（`packages/leader/src/chain-router.ts:232-238`）对 `reject` 与 `close_chain` 同等处理：

```typescript
case "reject":
case "close_chain": {
  if (msg.chain_id) this.emitChainClosed(msg.chain_id);
  break;
}
```

emit `chain_closed` → TUI 显示链关闭。**没有进一步动作**——不会撤回前面的 commit，不会通知 Accepter，不会自动 retry。整条链就此终止。

本贯穿样例假设 Mia 走 **8.7.A（activate_next）**，把 concern 留给 Accepter 在业务层面判定（与 personal-claude-reviewer.md 的"PASS — Ready for Accept" 一致）。

## 8.8 完成报告

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
  "task_id": "task-0000000008",
  "chain_id": "chain-pagination-001",
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "task_doc_path": null,
  "result_path": "~/.claude-orchestrator/cache/leader-01/results/task-0000000008.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:11:00.000Z"
}
```

## 8.9 Leader 路由 → 激活 Accept

`ChainRouter.handleCompletionReport` `activate_next + next_link=accept`：
- `task_queue.push({title: "[chain-pagination-001] accept", link: "accept", ...})` → `task-0000000009`
- `findIdleWorkerByRole("accepter")` → Leo
- `message_router.send(task_dispatch → leo-01)` → `/messages/leo-01/msg-0000000001`

## Review 环节产物清单

### ZK 新增

| 路径 | 备注 |
|------|------|
| `/messages/leader-01/msg-0000000005` | Mia 完成报告 |
| `/tasks/pending/task-0000000009` | 新 accept task ⚠️ 沉积 |
| `/messages/leo-01/msg-0000000001` | task_dispatch → Leo |

### ZK 修改

| 路径 | 修改 |
|------|------|
| `/messages/mia-01/msg-0000000001` | **删除** |
| `/messages/leader-01/msg-0000000005` | `read=true` |

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
