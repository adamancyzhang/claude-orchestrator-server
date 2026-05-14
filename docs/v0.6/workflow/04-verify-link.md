# 04 — Step 8：Verify 链环节（Lucy 处理 task-0000000007）

> 入口状态：Lucy 收件箱有 `msg-0000000001`（task_dispatch, link=verify, task_id=task-0000000007）。
> 出口状态：Lucy 发完成报告，Leader 激活 Review，派给 Mia（或 feedback 给 Builder）。

## 7.1–7.3 同 Plan/Build

- 不走 claim
- `LINK_TO_TEMPLATE["verify"]` → `worker-verify.md`
- hook `worker_message_start`：CO_LINK=`verify`

## 7.4 模板渲染差异

- skill：`task-verification`
- 上游 artifact 要求**两份**：Planner blueprint + Builder traceability-map（`templates/agents/worker-verify.md:18-22`）：

```
**Trace — Collect upstream artifacts (required)**:
1. Planner blueprint: `.claude-orchestrator/docs/{planner_name}/YYYY-MM-DD/blueprint.md`
2. Builder traceability map: `.claude-orchestrator/docs/{builder_name}/YYYY-MM-DD/traceability-map.md`
Fallback: `{{task_doc_path}}`. If either is missing → BLOCKED, report to Leader.
```

⚠️ 跨 worktree artifact 问题在 Verify 更严重：Lucy 在 `~/work/co-pagination/.worktrees/Lucy`，需要看 Tom 的 `blueprint.md`（在 `co/tom-01` 分支）+ Jerry 的 `traceability-map.md`（在 `co/jerry-01` 分支）。两份都不在 Lucy 的 worktree 默认 checkout 中，**且模板没指引怎么 git checkout / fetch**。

实际现状：Lucy 可能：
1. 退化为只看 `task_doc_path`（为空字符串）→ BLOCKED
2. 主动 `git log --all --oneline` 找到 `co/tom-01` / `co/jerry-01` 分支，用 `git show <branch>:<path>` 取文件
3. 直接读项目根目录的 `.claude-orchestrator/docs/Tom/...`（如果 worktree 共享主项目根）

⚠️ 现状⚠️ 不确定哪种行为占主导，依赖 Worker prompt 中 Claude 的应变能力。

## 7.5 主任务 claude-cli

调用形态：

```bash
cd ~/work/co-pagination/.worktrees/Lucy
claude --append-system-prompt '<Lucy identity (verifier)>' \
       -p '<rendered worker-verify.md>' \
       --output-format stream-json --verbose \
  > ~/.claude-orchestrator/cache/leader-01/logs/task-0000000007-<ts>.log
```

期望生成文件：

| 路径 | 内容 |
|------|------|
| `~/.../cache/leader-01/results/task-0000000007.md` | verification-map.md 副本 |
| `~/work/.../worktrees/Lucy/.claude-orchestrator/docs/Lucy/2026-05-14/verification-map.md` | 验证表 |
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

## 7.6 CommitChecker

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

✅ **issue #3 修复**：模板字段名已对齐 schema，feedback 路径现在能正常被 schema 接受。Verify 决定 FAILURE 是否回退 Builder 是模板里 `worker-evaluate.md` 决策树的选择题，不再被字段命名挡住。

本贯穿样例假设 Lucy 走 `activate_next`（决策 A），把 FAILURE 交给 Mia。

## 7.8 完成报告

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
  "task_id": "task-0000000007",
  "chain_id": "chain-pagination-001",
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "task_doc_path": null,
  "result_path": "~/.claude-orchestrator/cache/leader-01/results/task-0000000007.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:08:30.000Z"
}
```

## 7.9 Leader 路由 → 激活 Review

`ChainRouter.handleCompletionReport()` `activate_next + next_link=review`：
- `task_queue.push({title: "[chain-pagination-001] review", link: "review", ...})` → `task-0000000008`
- `findIdleWorkerByRole("reviewer")` → Mia
- `message_router.send(task_dispatch → mia-01)` → `/messages/mia-01/msg-0000000001`

### 7.9.1 假设走 feedback 分支会怎样？

如果 Lucy 输出 `decision=feedback`，`ChainRouter.handleCompletionReport()` 走 `packages/leader/src/chain-router.ts:218-230`：

```typescript
const targetId = decision.feedback_target ?? msg.from_instance;
//   ⚠️ feedback_target=null → 兜底 msg.from_instance = "lucy-01"
//   ⚠️⚠️ 这意味着 feedback 实际发回 **Lucy 自己**，而不是 Jerry！
await this.opts.message_router.send({
  type: "direct",
  from_instance: leader-01, ...
  to_instance: targetId,                         // "lucy-01"
  content: decision.feedback_to_worker,
  link: msg.link,                                // "verify"
  chain_id: msg.chain_id,
});
```

⚠️ **现状重大缺陷**：feedback 默认目标是消息发送者本人（Verifier 自己），不是 Builder！要让 feedback 发回 Jerry 需要 Lucy 显式设置 `feedback_target = "jerry-01"`——但 Verifier 通常不知道 builder 的 instance_id（仅知名字）。

此外 `decision=feedback` 时 leader **不会再 push 新 task**——Lucy 会再次收到 link=verify 消息，触发自己重做 verify。这是另一处严重的现状⚠️。

## Verify 环节产物清单

### ZK 新增

| 路径 | 备注 |
|------|------|
| `/messages/leader-01/msg-0000000004` | Lucy 完成报告 |
| `/tasks/pending/task-0000000008` | 新 review task ⚠️ 沉积 |
| `/messages/mia-01/msg-0000000001` | task_dispatch → Mia |

### ZK 修改

| 路径 | 修改 |
|------|------|
| `/messages/lucy-01/msg-0000000001` | **删除** |
| `/messages/leader-01/msg-0000000004` | `read=true` |

### Cache 文件

同上五类，task_id = `task-0000000007`。

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
