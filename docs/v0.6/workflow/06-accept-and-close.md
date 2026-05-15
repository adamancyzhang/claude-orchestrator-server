# 06 — Step 10：Accept 链环节 + 链关闭 + MergeValidator

> 入口状态：Leo 收件箱有 `msg-0000000001`（task_dispatch, link=accept, task_id=task-0000000005, assigned_to=leo-01）。
> 出口状态：Leo 发完成报告（含 `close_chain` 或 `feedback` 或 `reject`），Leader 在 close_chain 时自动跑 MergeValidator + ChainAudit `closeChain('completed')`，emit `chain_closed`。

## 9.1–9.3 同前

- `registry.heartbeat(busy)` + `task_queue.claimById(task-0000000005, leo-01)` + `task_claimed` hook fire
- 模板：`templates/agents/worker-accepter-task.md`（per-task wrapper），system prompt = `worker-accepter.md` + `personal-claude-accepter.md`（boot 时载入并已渲染 `{{name}}`）
- skill：`task-acceptance`
- hook CO_LINK=`accept`

## 9.4 模板渲染差异

上游 artifact 要求**全部四份**（`templates/agents/worker-accepter-task.md`）：

```markdown
## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Builder traceability map: `{{upstream_build_artifact}}`
3. Verifier verification map: `{{upstream_verify_artifact}}`
4. Reviewer judgment: `{{upstream_review_artifact}}`

If any of the four upstream artifacts is missing, write a single-line BLOCKED report to `result_path` naming the missing artifact and stop.
```

✅ **issue #10 修复**：Leo 通过 chain-shared cache 路径读全部 4 份上游 artifact：
- `{{upstream_plan_artifact}}` = `~/.../projects/leader-01/tasks/task-0000000001/result.md`
- `{{upstream_build_artifact}}` = `~/.../projects/leader-01/tasks/task-0000000002/result.md`
- `{{upstream_verify_artifact}}` = `~/.../projects/leader-01/tasks/task-0000000003/result.md`
- `{{upstream_review_artifact}}` = `~/.../projects/leader-01/tasks/task-0000000004/result.md`

由 `WorkerWatcher.collectChainArtifacts` 解析 chain manifest 得到。

✅ **本轮治理**：`{{task_doc_path}}` 行已从模板移除。

## 9.5 主任务

```bash
cd ~/work/co-pagination/.worktrees/Leo
claude --append-system-prompt '<Leo identity (accepter)>' \
       -p '<rendered worker-accepter-task.md>' \
       --output-format stream-json --verbose \
  > ~/.claude-orchestrator/projects/leader-01/tasks/task-0000000005/exec-<ts>.log
```

期望生成文件：

| 路径 | 内容 |
|------|------|
| `~/.../projects/leader-01/tasks/task-0000000005/result.md` | acceptance-report.md（Leader 视角） |
| `~/.../projects/leader-01/docs/Leo/2026-05-14/accept-chain-pagination-001.md` | local_doc_path 副本 |
| `~/work/.../worktrees/Leo/.claude-orchestrator/docs/Leo/2026-05-14/acceptance-report.md` | worktree 副本 |
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

## 9.6 hook worker_message_end + CommitChecker

只产出 markdown。commit log 落 `projects/leader-01/tasks/task-0000000005/commit.log`。

## 9.7 SelfEvaluator — Accept 的决策

`NEXT_LINKS["accept"] = null`，所以 fallback 路径会输出：

```json
{
  "decision": "close_chain",
  "reason": "accept link completed after 3 eval failures"
}
```

（见 `packages/worker/src/evaluator.ts` fallback 分支）

### 9.7.A GO 时（schema 命中场景）

按 `worker-evaluate.md` "**Accept link passes** → `close_chain`"：

```json
{
  "decision": "close_chain",
  "reason": "all acceptance criteria met; deliverable approved"
}
```

### 9.7.B NO-GO 时（schema 命中场景）

模板没有给 NO-GO 明确决策。Accept 通常输出 `feedback`（要 Builder 修）或 `reject`（restart）：

```json
{
  "decision": "feedback",
  "reason": "1 criterion failed: page_size>100 unrejected",
  "feedback_to_worker": "Builder: add page_size<=100 validation",
  "feedback_target": null
}
```

✅ **issue #3 修复 + 本轮治理**：模板字段名对齐 schema；feedback 现在物化为 retry task：
- 默认 target = `manifest.link_workers[PREV_LINKS["accept"]]` = `link_workers.review` = Mia（reviewer）
- 若要直接退到 Builder（Jerry），Leo 需 `feedback_target = jerry-01`
- `dispatchFeedbackAsRetry` 会 push 新 review retry task（retry_count++、description=feedback_to_worker），assign 给 target worker，dispatch 之
- 旧 task-0000000004 仍在 completed/，可审计

`reject` 走 `closeChain("aborted")` —— 与 `close_chain` 同样关闭链，但 manifest.status 标 `aborted`，**不触发 MergeValidator**（语义为彻底退回，不进主线）。

本贯穿样例选择走 9.7.A，最终决策 `close_chain` —— 后续走 MergeValidator + ChainAudit closeChain。

## 9.8 完成报告

`task_queue.complete` → `/tasks/completed/task-0000000005`，`task_completed` hook fire。

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
  "task_id": "task-0000000005",
  "chain_id": "chain-pagination-001",
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "result_path": "~/.claude-orchestrator/projects/leader-01/tasks/task-0000000005/result.md",
  "original_requirement_path": null,
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:14:00.000Z"
}
```

## 9.9 Leader 路由 → 链关闭

`ChainRouter.route()`：`msg.link === "accept"`（非 plan）+ 内容像 EvalDecision → `handleCompletionReport(msg)`。

`packages/leader/src/chain-router.ts` `close_chain` 分支：

```typescript
case "close_chain": {
  if (msg.chain_id) {
    await this.runMergeValidation(msg.chain_id);     // ✅ #7 修复：自动跑 MergeValidator
    if (this.opts.chain_audit) {
      await this.opts.chain_audit.closeChain(msg.chain_id, "completed");
    }
    this.emitChainClosed(msg.chain_id);
    this.forgetChain(msg.chain_id);
  }
  break;
}
```

执行顺序：
1. 跑 `runMergeValidation` 遍历 chainCommits 5 个 commit
2. ChainAudit `closeChain(chainId, "completed")` —— manifest.status="completed"，completed_at 时间戳，audit.jsonl append `chain_closed` 事件
3. emit `chain_closed` → TUI 显示链关闭
4. `forgetChain` 清理 chainCommits 内存映射（chainWorkers 已不在内存中，无需清理）

## 9.10 MergeValidator ✅ issue #7 修复：close_chain 自动触发

`ChainRouter` 维护 `chainCommits: Map<chain_id, CommitInfo[]>`，每收到 completion_report：

```typescript
if (msg.chain_id && msg.link && raw.commit) {
  this.recordCommit(msg.chain_id, msg.link, msg.task_title, raw.commit);
}
```

`close_chain` 决策走 `runMergeValidation(chain_id)`：按插入序（即 plan→build→verify→review→accept）逐个调用 `merge_validator.validate(commit)`。单个 commit 验证抛错时仅 warn，下一个 commit 继续。

`merge_validator` 在 `packages/orchestrator/src/run.ts` 构造并注入：

```typescript
const mergeValidator = new MergeValidator({...});
const chainRouter = new ChainRouter({...others, merge_validator: mergeValidator});
```

`reject` 决策**不**触发 MergeValidator（语义为彻底退回）。`forgetChain` 同时清理 chainCommits 映射。

### 9.10.1 MergeValidator 行为参考（若被调用）

`packages/leader/src/merge-validator.ts` `validate(commit)`：

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

### 9.10.3 整链 5 个 commit 的自动合并

Leo 输出 `close_chain` 后，`ChainRouter.runMergeValidation(chain_id)` 按链路顺序遍历 5 个 commit：

| 顺序 | Worker | 分支 | SHA | 模板调用 | 决策 |
|------|--------|------|-----|---------|------|
| 1 | Tom | `co/tom-01` | `7c4f3a2b...` | `worker-merge-decision.md` | `merge` / `skip` / `review_first` |
| 2 | Jerry | `co/jerry-01` | `8d5e4b3c...` | 同上 | 同上 |
| 3 | Lucy | `co/lucy-01` | `9e6f5c4d...` | 同上 | 通常 `skip`（纯文档变更） |
| 4 | Mia | `co/mia-01` | `a1b2c3d4...` | 同上 | 通常 `skip` |
| 5 | Leo | `co/leo-01` | `b2c3d4e5...` | 同上 | 视 GO/NO-GO |

冲突时 `MergeValidator.validate` 抛 `MergeConflictError`，`ChainRouter.runMergeValidation` 仅 warn 然后继续下一 commit（不阻塞整体合并流程）。

## 链关闭时 ZK 终态全景

```
/claude-orchestrator/
├── leader                                   [EPHEMERAL]
├── instances/
│   ├── leader-01, tom-01, jerry-01, lucy-01, mia-01, leo-01   [EPHEMERAL] {status:"idle"}
├── tasks/
│   ├── pending/                             (空)
│   ├── claimed/                             (空)
│   └── completed/                           (5 个完成态 task，按 link 顺序)
│       ├── task-0000000001 (plan, completed_by=Tom)
│       ├── task-0000000002 (build, completed_by=Jerry)
│       ├── task-0000000003 (verify, completed_by=Lucy)
│       ├── task-0000000004 (review, completed_by=Mia)
│       └── task-0000000005 (accept, completed_by=Leo)
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

✅ **本轮治理**：5 个初始 task 经过 claim → complete 完整流转，最终都落到 `/tasks/completed/`；`/tasks/pending/` 在链关闭后为空（无沉积）。

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

中间步骤（task_dispatch / completion_report / feedback_sent / task_claimed / task_completed）不直接发到 LeaderEventBus，全部记录在 `chains/chain-pagination-001/audit.jsonl`，需要时可线性回放。

## 全程产物清单

### Cache 文件（全部位于 `~/.claude-orchestrator/projects/leader-01/`）

```
chains/chain-pagination-001/
├── requirement.md                     ← 原始用户需求
├── manifest.json                      ← link_tasks + link_workers + status="completed"
└── audit.jsonl                        ← 全程事件流（>=15 行）

messages/msg-0000000001/
├── inbound.log                        ← decompose claude-cli stream-json
└── decompose.md                       ← ChainDef JSON

tasks/task-0000000001/                 ← plan (Tom)
├── exec-<ts>.log                       ← 主执行 claude-cli 日志
├── result.md                          ← blueprint.md
├── commit.log                          ← commit message 日志
├── eval-{0,1,2}.log[.result.md]       ← self-eval claude 调用日志（视重试）

tasks/task-0000000002/                 ← build (Jerry)
tasks/task-0000000003/                 ← verify (Lucy)
tasks/task-0000000004/                 ← review (Mia)
tasks/task-0000000005/                 ← accept (Leo)
  (结构同 task-0000000001/)

docs/Leader/2026-05-14/                ← Leader 自处理 decompose 留下的 chain-def.json
docs/Tom/2026-05-14/plan-chain-pagination-001.md
docs/Jerry/2026-05-14/build-chain-pagination-001.md
docs/Lucy/2026-05-14/verify-chain-pagination-001.md
docs/Mia/2026-05-14/review-chain-pagination-001.md
docs/Leo/2026-05-14/accept-chain-pagination-001.md
                                       ← 每个 worker 的 local_doc_path 副本
```

**manifest.json 链关闭时终态（示意）**：

```json
{
  "chain_id": "chain-pagination-001",
  "created_at": "2026-05-14T03:00:01.000Z",
  "completed_at": "2026-05-14T03:14:00.500Z",
  "status": "completed",
  "leader_id": "leader-01",
  "leader_name": "Leader",
  "requirement_path": "~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/requirement.md",
  "link_tasks": {
    "plan":   "task-0000000001",
    "build":  "task-0000000002",
    "verify": "task-0000000003",
    "review": "task-0000000004",
    "accept": "task-0000000005"
  },
  "link_workers": {
    "plan":   "tom-01",
    "build":  "jerry-01",
    "verify": "lucy-01",
    "review": "mia-01",
    "accept": "leo-01"
  }
}
```

**audit.jsonl 关键事件（按时间顺序）**：

```jsonl
{"event":"chain_opened",        "link":null,    "worker_id":null,      "task_id":null,                  "payload":{...}}
{"event":"requirement_received","link":null,    "worker_id":null,      "task_id":null,                  "payload":{"requirement_path":".../requirement.md"}}
{"event":"task_dispatch",       "link":"plan",  "worker_id":"tom-01",  "task_id":"task-0000000001",     "payload":null}
{"event":"completion_report",   "link":"plan",  "worker_id":"tom-01",  "task_id":"task-0000000001",     "payload":{"decision":"activate_next"}}
{"event":"task_dispatch",       "link":"build", "worker_id":"jerry-01","task_id":"task-0000000002",     "payload":null}
{"event":"completion_report",   "link":"build", "worker_id":"jerry-01","task_id":"task-0000000002",     "payload":{"decision":"activate_next"}}
{"event":"task_dispatch",       "link":"verify","worker_id":"lucy-01", "task_id":"task-0000000003",     "payload":null}
{"event":"completion_report",   "link":"verify","worker_id":"lucy-01", "task_id":"task-0000000003",     "payload":{"decision":"activate_next"}}
{"event":"task_dispatch",       "link":"review","worker_id":"mia-01",  "task_id":"task-0000000004",     "payload":null}
{"event":"completion_report",   "link":"review","worker_id":"mia-01",  "task_id":"task-0000000004",     "payload":{"decision":"activate_next"}}
{"event":"task_dispatch",       "link":"accept","worker_id":"leo-01",  "task_id":"task-0000000005",     "payload":null}
{"event":"completion_report",   "link":"accept","worker_id":"leo-01",  "task_id":"task-0000000005",     "payload":{"decision":"close_chain"}}
{"event":"chain_closed",        "link":null,    "worker_id":null,      "task_id":null,                  "payload":{"status":"completed"}}
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

`close_chain` 触发 `runMergeValidation`，5 个 commit 按 plan→build→verify→review→accept 顺序由 `worker-merge-decision.md` 判定 `merge / skip / review_first`，决策 `merge` 时合入 `master`。

## 现状基线总结

本贯穿样例覆盖了所有 5 个链环节，共 10 个步骤。与早期基线相比，本轮治理后的运行特征：

1. **任务认领进 ZK 状态机** —— 每个 task 走 pending → claimed → completed 完整生命周期；终态时 `/tasks/completed/` 含 5 条完整审计记录（issue #1）
2. **链推进显式 dispatch + ChainAudit 持久化** —— Leader 通过 `findOrCreatePendingTask` 复用初始 5 个 task，`task_queue.assign` 派单；每次 dispatch 同步 `chain_audit.setLinkTask` + `setLinkWorker`，写到 `manifest.json`；leader 重启可恢复（issue #4 + 本轮 chainWorkers 持久化）
3. **task_dispatch 携带完整上下文** —— `task_description / task_criteria / original_requirement_path` 全部由 ChainDef / requirement.md 直传 worker prompt（issue #9）
4. **跨 worktree artifact 走 chain-shared cache** —— `WorkerWatcher.collectChainArtifacts` 读 chain manifest 解析 `tasks/<task_id>/result.md`，模板变量 `{{upstream_*_artifact}}` 注入，不再依赖 git 跨分支同步（issue #10）
5. **EvalDecision schema 严格命中** —— 模板字段 snake_case + 4 decision 分支，schema safeParse 通常成功；feedback 路径可达（issue #3）
6. **feedback / reject / NO-GO 路径完备** —— feedback 物化为 retry task（retry_count++、description=feedback_to_worker、assigned_to=prev-link worker），retry 流转走标准 claim → complete；reject 走 `closeChain('aborted')` 标 manifest 状态 + 跳过 MergeValidator；GO 走 close_chain 触发完整 MergeValidator + `closeChain('completed')`（本轮治理 #15 + issue #6 + #7）
7. **MergeValidator 自动触发** —— `close_chain` 在 `runMergeValidation` 中按链路顺序遍历 5 个 commit，逐个走 `worker-merge-decision.md` 决策；`reject` 不合并（issue #7）
8. **Worker 心跳 busy/idle 真正写 ZK** —— `WorkerWatcher.processMessage` 入口/finally 切换 `status` 字段，`findIdleWorkerByRole` 真按 status 过滤；并发派发安全（本轮治理 #13）
9. **task_claimed / task_completed hook 真正触发** —— Worker 在 `claimById` 成功后 fire `task_claimed`，`complete()` 成功后 fire `task_completed`（env 含 `duration_seconds`）；shell 脚本可观测（本轮治理 #16）
10. **schema 字段清理** —— `task_doc_path / depends_on / blocked_by / blocked_reason / TaskStatus.blocked / ITaskQueue.block` 全部移除；旧 ZK 节点反序列化时 zod strip 静默丢弃（本轮治理 #12）

未来对模板、调度策略、合并触发的进一步优化，均应基于本基线对照修订。
