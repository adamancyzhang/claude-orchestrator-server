# 06 — Step 10：Accept 链环节 + 链关闭 + MergeValidator

> 入口状态：Leo 收件箱有 `msg-0000000001`（task_dispatch, link=accept, task_id=task-0000000009）。
> 出口状态：Leo 发完成报告（含 `close_chain` 或 `activate_next`，按其 EvalDecision），Leader emit `chain_closed`，MergeValidator 按需触发合并审查。

## 9.1–9.3 同前

- 不走 claim
- 模板：`templates/agents/worker-accept.md`，skill：`task-acceptance`
- hook CO_LINK=`accept`

## 9.4 模板渲染差异

上游 artifact 要求**全部四份**（`templates/agents/worker-accept.md:18-23`）：

```
**Read all four upstream artifacts (required)**:
1. .claude-orchestrator/docs/{planner_name}/YYYY-MM-DD/blueprint.md
2. .claude-orchestrator/docs/{builder_name}/YYYY-MM-DD/traceability-map.md
3. .claude-orchestrator/docs/{verifier_name}/YYYY-MM-DD/verification-map.md
4. .claude-orchestrator/docs/{reviewer_name}/YYYY-MM-DD/review-judgment.md
Fallback: {{task_doc_path}}. If any is missing → cannot accept, report to Leader.
```

✅ **issue #10 修复**：Leo 通过 chain-shared cache 路径读全部 4 份上游 artifact：
- `{{upstream_plan_artifact}}` / `{{upstream_build_artifact}}` / `{{upstream_verify_artifact}}` / `{{upstream_review_artifact}}` 分别指向 `{cache_dir}/{leader_id}/chains/{chain_id}/{plan|build|verify|review}.md`。不再依赖各 worktree 的 `.claude-orchestrator/docs/{role}/...`。

## 9.5 主任务

```bash
cd ~/work/co-pagination/.worktrees/Leo
claude --append-system-prompt '<Leo identity (accepter)>' \
       -p '<rendered worker-accept.md>' \
       --output-format stream-json --verbose \
  > ~/.claude-orchestrator/cache/leader-01/logs/task-0000000009-<ts>.log
```

期望生成文件：

| 路径 | 内容 |
|------|------|
| `~/.../cache/leader-01/results/task-0000000009.md` | acceptance-report.md 副本 |
| `~/work/.../worktrees/Leo/.claude-orchestrator/docs/Leo/2026-05-14/acceptance-report.md` | 验收报告 |
| `~/work/.../worktrees/Leo/.claude-orchestrator/docs/Leo/2026-05-14/CLAUDE.md` | 当日记忆 |

**acceptance-report.md 内容示意**（贯穿样例 NO-GO 情形）：

```markdown
# Acceptance Report — /api/users 分页

## Verifier FAILUREs resolved: 0/1
- page_size>100 unrejected (vs Plan criterion 3) → **未解决**

## Reviewer CONCERNs addressed: 0/1
- Builder fix not applied → **未解决**

## Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| 接口签名正确 | PASS |
| 默认值正确 | PASS |
| page>=1 校验 | PASS |
| **page_size 范围 1..100** | **FAIL** ← blocker |
| 响应结构正确 | PASS |
| 4xx 错误响应 | PASS |

## Decision: **NO-GO**

Failed criteria:
1. page_size 范围 — responsible link: **build** (Jerry must add validation)
```

按 `personal-claude-accepter.md` 规则："No conditional GO — zero issues is the only standard"，本样例严格走 NO-GO。

## 9.6 CommitChecker

只产出 markdown。

## 9.7 SelfEvaluator — Accept 的决策

`NEXT_LINKS["accept"] = null`，所以 fallback 路径会输出：

```json
{
  "decision": "close_chain",
  "reason": "accept link completed after 3 eval failures"
}
```

（见 `packages/worker/src/evaluator.ts:120-123`）

### 9.7.A GO 时（schema 命中场景）

按 `worker-evaluate.md` "**Accept link passes** → `close_chain`"：

```json
{
  "decision": "close_chain",
  "reason": "all acceptance criteria met; deliverable approved"
}
```

### 9.7.B NO-GO 时（schema 命中场景）

模板没有给 NO-GO 明确决策。逻辑上应是 `feedback`（要 Builder 修）或 `reject`（restart）。Accept 通常输出：

```json
{
  "decision": "feedback",
  "reason": "1 criterion failed: page_size>100 unrejected",
  "feedback_to_worker": "Builder: add page_size<=100 validation",
  "feedback_target": null
}
```

✅ **issue #3 修复**：模板字段名 `feedback_to_worker / feedback_target` 已对齐 schema，feedback 分支现在能被 schema 接受。

✅ **issue #6 修复**：Leo 不指定 `feedback_target` 时，按 PREV_LINKS["accept"]="review" 默认发给 Mia（reviewer）。若要直接退到 Builder（Jerry），Leo 需在 EvalDecision 中显式 `feedback_target = jerry-01`。NO-GO 决策现在能在 schema 内直接表达——选 `feedback`（含 `feedback_target`）或 `reject`（彻底拒收）。

本贯穿样例选择走 9.7.A，最终决策 `close_chain` —— 不严格区分 GO/NO-GO 时的差异，链都会以 `close_chain` 落地。

## 9.8 完成报告

ZK 路径：`/messages/leader-01/msg-0000000006`

```json
{
  "id": "msg-0000000006",
  "type": "completion_report",
  "from_instance": "leo-01",
  "from_name": "Leo",
  "from_role": "accepter",
  "to_instance": "leader-01",
  "to_name": null,
  "content": "{\"decision\":\"close_chain\",\"reason\":\"acceptance review complete — see acceptance-report.md for final verdict\",\"commit\":{\"sha\":\"b2c3d4e5f60718293a4b5c6d7e8f9012345abcde0\",\"message\":\"accept(users): NO-GO — page_size validation gap (responsible: build)\",\"branch\":\"co/leo-01\",\"changed_files\":[],\"untracked_files\":[\".claude-orchestrator/docs/Leo/2026-05-14/acceptance-report.md\",\".claude-orchestrator/docs/Leo/2026-05-14/CLAUDE.md\"]}}",
  "link": "accept",
  "task_id": "task-0000000009",
  "chain_id": "chain-pagination-001",
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "task_doc_path": null,
  "result_path": "~/.claude-orchestrator/cache/leader-01/results/task-0000000009.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:14:00.000Z"
}
```

## 9.9 Leader 路由 → 链关闭

`ChainRouter.route()`：`msg.link === "accept"`（非 plan）+ 内容像 EvalDecision → `handleCompletionReport(msg)`。

`packages/leader/src/chain-router.ts:232-238`：

```typescript
case "reject":
case "close_chain": {
  if (msg.chain_id) {
    this.emitChainClosed(msg.chain_id);    // emit { type: "chain_closed", chain_id }
  }
  break;
}
```

`emitChainClosed`（line 242-244）：

```typescript
this.opts.bus.emit({ type: "chain_closed", chain_id: asChainId(chainId) });
```

TUI EVENT LOG 显示一条 `Chain closed: chain-pagination-001`。**没有进一步动作**——既不会标记 chain 关联的 tasks 为 `completed`/`failed`，也不会自动触发合并。

## 9.10 MergeValidator（按需触发）

⚠️ **现状**：`MergeValidator`（`packages/leader/src/merge-validator.ts`）**没有被 `ChainRouter` 自动调用**。`emitChainClosed` 后没有任何代码路径触发 merge 流程。

`MergeValidator` 的现有触发方式可能是：
1. 外部 CLI 命令（人工触发）
2. 其他 leader 子系统（task_orchestrator / recovery 等）—— 经代码检查未发现
3. 通过 hook `merge_decision_made`（但是反向：merge 触发后才 emit hook）

### 9.10.1 MergeValidator 行为参考（若被调用）

`packages/leader/src/merge-validator.ts:37-81` `validate(commit)`：

1. `git rev-parse --abbrev-ref HEAD` → 取当前主分支名（e.g. `master`）
2. `git branch --contains <sha>` 检查 commit 是否已合并 → 是则返回 `{decision:"skip", reason:"Already merged"}`
3. 渲染 `worker-merge-decision.md` 模板（`templates/agents/worker-merge-decision.md`），调 claude-cli 询问决策
4. 决策为 `merge`：
   - `git checkout <main_branch>`
   - `git merge <commit.branch> --no-ff -m "Merge <branch>: <message>"`
   - 冲突 → `git merge --abort` → 抛 `MergeConflictError`（含 conflict 文件清单）→ checkout 回原分支
5. 决策为 `skip` / `review_first`：不动作
6. emit `debug_info` 事件

### 9.10.2 worker-merge-decision.md 模板入参

| 变量 | 含义 | 贯穿样例值（Tom 的 plan commit 为例）|
|------|------|------------------------------------|
| `branch` | 待合并分支 | `co/tom-01` |
| `sha` | commit SHA | `7c4f3a2b...` |
| `message` | commit message | `feat(plan): blueprint for /api/users pagination` |
| `task_title` | 任务标题 | `设计 /api/users 分页接口蓝图` |
| `task_link` | 链环节 | `plan` |
| `main_branch` | 主分支 | `master` |

claude 输出 `MergeDecision` JSON：

```json
{
  "decision": "merge" | "skip" | "review_first",
  "reason": "..."
}
```

`MergeDecisionSchema` 见 `packages/contracts/src/schemas/merge.ts`。

### 9.10.3 整链 5 个 commit 的合并

按现状，假设有人触发 merge validation，逐个对 5 个分支：

| Worker | 分支 | SHA | 决策（claude） | 实际动作 |
|--------|------|-----|---------------|---------|
| Tom | `co/tom-01` | `7c4f3a2b...` | `merge` / `skip` / `review_first` | 视决策合并入 master 或留待人工 |
| Jerry | `co/jerry-01` | `8d5e4b3c...` | 同上 | 同上 |
| Lucy | `co/lucy-01` | `9e6f5c4d...` | 同上（通常 skip：纯文档） | 同上 |
| Mia | `co/mia-01` | `a1b2c3d4...` | 同上（通常 skip：纯文档） | 同上 |
| Leo | `co/leo-01` | `b2c3d4e5...` | NO-GO 链时通常 `review_first` | 同上 |

⚠️ 当前没有"链关闭时自动调用 MergeValidator"的代码路径。

## 链关闭时 ZK 终态全景

```
/claude-orchestrator/
├── leader                                   [EPHEMERAL]
├── instances/
│   ├── leader-01, tom-01, jerry-01, lucy-01, mia-01, leo-01   [EPHEMERAL] {status:"idle"}
├── tasks/
│   ├── pending/                             ⚠️ 5 个初始 task 未被 complete（在 #1 落地前依然沉积）
│   │   ├── task-0000000001 (plan，handleTaskDefinitions 初始 push)
│   │   ├── task-0000000002 (build，#4 修复后被 activate_next 复用 dispatch)
│   │   ├── task-0000000003 (verify，同上)
│   │   ├── task-0000000004 (review，同上)
│   │   └── task-0000000005 (accept，同上)
│   ├── claimed/                             (空)
│   └── completed/                           (空)
└── messages/
    ├── leader-01/
    │   ├── msg-0000000001  read=true   ← TUI 用户输入
    │   ├── msg-0000000002  read=true   ← Tom completion
    │   ├── msg-0000000003  read=true   ← Jerry completion
    │   ├── msg-0000000004  read=true   ← Lucy completion
    │   ├── msg-0000000005  read=true   ← Mia completion
    │   └── msg-0000000006  read=true   ← Leo completion
    ├── tom-01/                          (空，已 dismiss)
    ├── jerry-01/                        (空)
    ├── lucy-01/                         (空)
    ├── mia-01/                          (空)
    └── leo-01/                          (空)
```

## TUI EVENT LOG 全程

简化时间轴：

```
[03:00:00]  message_received    leader-01 → "为 REST API..."
[03:00:01]  chain_activated     chain-pagination-001
[03:00:02]  message_processed   msg-0000000001
[03:00:03]  message_received    tom-01 → completion (plan)
[03:01:32]  message_processed   msg-0000000002
[03:01:33]  message_received    jerry-01 → completion (build)
[03:05:01]  message_processed   msg-0000000003
[03:05:02]  message_received    lucy-01 → completion (verify)
[03:08:31]  message_processed   msg-0000000004
[03:08:32]  message_received    mia-01 → completion (review)
[03:11:01]  message_processed   msg-0000000005
[03:11:02]  message_received    leo-01 → completion (accept)
[03:14:00]  chain_closed        chain-pagination-001
[03:14:01]  message_processed   msg-0000000006
```

## 全程产物清单

### Cache 文件（全部位于 `~/.claude-orchestrator/cache/leader-01/`）

```
messages/
└── msg-0000000001.log              ← decompose claude-cli 日志

results/
├── decompose/msg-0000000001.md         ← ChainDef JSON
├── task-0000000001.md         ← Tom blueprint
├── task-0000000006.md         ← Jerry traceability-map
├── task-0000000007.md         ← Lucy verification-map
├── task-0000000008.md         ← Mia review-judgment
└── task-0000000009.md         ← Leo acceptance-report

logs/
├── task-0000000001-<ts>.log   ← Tom 主执行
├── task-0000000006-<ts>.log   ← Jerry 主执行
├── task-0000000007-<ts>.log   ← Lucy 主执行
├── task-0000000008-<ts>.log   ← Mia 主执行
└── task-0000000009-<ts>.log   ← Leo 主执行

commits/
├── task-0000000001.log        ← Tom commit message 日志
├── task-0000000006.log
├── task-0000000007.log
├── task-0000000008.log
└── task-0000000009.log

evals/
├── task-0000000001-attempt-0.log[.result.md]
├── task-0000000001-attempt-1.log[.result.md]
├── task-0000000001-attempt-2.log[.result.md]
├── (同上 5 个 task × ≤3 attempts，受 schema 不匹配影响多数情况下 3 个 attempt 都生成)
```

### Worktree 内文件（5 个 worktree 分支）

```
.worktrees/Tom/.claude-orchestrator/docs/Tom/2026-05-14/
  ├── blueprint.md
  └── CLAUDE.md

.worktrees/Jerry/.claude-orchestrator/docs/Jerry/2026-05-14/
  ├── traceability-map.md
  ├── evidence/curl-page-2.log, curl-default.log, ...
  └── CLAUDE.md
.worktrees/Jerry/src/api/users-controller.ts                  (modified)
.worktrees/Jerry/src/api/users-service.ts                     (modified)
.worktrees/Jerry/tests/users.test.ts                          (new)

.worktrees/Lucy/.claude-orchestrator/docs/Lucy/2026-05-14/
  ├── verification-map.md
  ├── evidence/curl-page-size-200.log, ...
  └── CLAUDE.md

.worktrees/Mia/.claude-orchestrator/docs/Mia/2026-05-14/
  ├── review-judgment.md
  └── CLAUDE.md

.worktrees/Leo/.claude-orchestrator/docs/Leo/2026-05-14/
  ├── acceptance-report.md
  └── CLAUDE.md
```

### Git commits（5 个分支各 1 个）

| 分支 | SHA | message |
|------|-----|---------|
| `co/tom-01` | `7c4f3a2b...` | `feat(plan): blueprint for /api/users pagination` |
| `co/jerry-01` | `8d5e4b3c...` | `feat(users): paginate /api/users with page/page_size` |
| `co/lucy-01` | `9e6f5c4d...` | `verify(users): 1 FAILURE — page_size>100 not rejected` |
| `co/mia-01` | `a1b2c3d4...` | `review(users): 5 ACCEPT 1 CONCERN — page_size>100 unrejected` |
| `co/leo-01` | `b2c3d4e5...` | `accept(users): NO-GO — page_size validation gap (responsible: build)` |

未合并入 `master`（除非外部触发 MergeValidator）。

## 现状基线总结

本贯穿样例覆盖了所有 5 个链环节，共 10 个步骤；展示了：

1. **消息驱动而非任务认领** —— `/tasks/*` 是审计型，Worker 完全靠 task_dispatch 消息工作
2. **链推进靠 Leader 显式 push 新 task** —— `activate_next` 每次 push 新 task；初始 5 个 task 沉积
3. **任务上下文逐级稀释** —— task_description/criteria/doc_path 在 task_dispatch 消息中全为 null，Worker prompt 中只剩 title
4. **跨 worktree artifact 传递断链** —— 模板 "Read planner blueprint" 与 worktree/分支隔离结构冲突
5. **EvalDecision schema 字段命名错位** —— 模板用 camelCase / `feedback`，schema 用 snake_case / `feedback_to_worker`，导致 schema 校验几乎必失败，落到 fallback 自动推进
6. **feedback / reject / NO-GO 路径几乎不可达** —— 字段名错位导致 schema fail；feedback_target 兜底为发送者本人；reject/close_chain 等同关闭链且无后续修复
7. **MergeValidator 未自动触发** —— 链关闭后没有自动合并流程

这些都是 **现状基线**——未来对 prompt 模板、字段命名、跨 worktree 传递、合并触发等的优化都应基于本基线对照修订。
