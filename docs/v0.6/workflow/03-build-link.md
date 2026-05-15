# 03 — Step 7：Build 链环节（Jerry 处理 task-0000000002）

> 入口状态：Jerry 收件箱有 `msg-0000000001`（task_dispatch, link=build, task_id=task-0000000002, assigned_to=jerry-01）；`/tasks/pending/task-0000000002` 已被 leader 在 5.9 中 assign 给 jerry-01。
> 出口状态：Jerry 发完成报告，Leader 复用 `task-0000000003`（verify link），更新 manifest.link_workers，并派给 Lucy。
>
> 本文档只描述与 Plan link 不同的差异化内容；流程结构完全复用 `02-plan-link.md` 的 5.1–5.9。请配合阅读。

## 6.1 任务认领

同 Plan 5.1：`registry.heartbeat(busy)` → `task_queue.claimById(task-0000000002, jerry-01)` → `task_claimed` hook fire。`task-0000000002` 节点从 `/tasks/pending/` 原子搬到 `/tasks/claimed/jerry-01-task-0000000002`（EPHEMERAL）。

## 6.2 模板选择

`LINK_TO_TASK_TEMPLATE["build"]` → `worker-builder-task.md`（per-task wrapper）。Jerry 的常驻 system prompt 是 `worker-builder.md` + `personal-claude-builder.md`（boot 时载入，`{{name}}` 已替换为 Jerry）。

- per-task 模板：`templates/agents/worker-builder-task.md`
- skill：`task-execution`（`.claude/skills/task-execution/SKILL.md`）

## 6.3 hook worker_message_start

CO_LINK = `build`，其余与 Plan 一致。

## 6.4 模板渲染

✅ **issue #9 修复**：本步 vars 完整来自初始 ChainDef，不再退化：
- `task_title` = `"实现 /api/users 分页查询"`
- `task_description` = `"按 Plan 实现 controller / service / repository 三层修改..."`
- `task_criteria` = `"(1) curl -G /api/users -d 'page=2&page_size=5' 返回 200..."`
- `result_path` = `~/.../projects/leader-01/tasks/task-0000000002/result.md`
- `local_doc_path` = `~/.../projects/leader-01/docs/Jerry/2026-05-14/build-chain-pagination-001.md`
- `work_dir` = `~/work/co-pagination/.worktrees/Jerry`
- `upstream_plan_artifact` = `~/.../projects/leader-01/tasks/task-0000000001/result.md`（Tom 的 blueprint，由 `WorkerWatcher.collectChainArtifacts` 解析 chain manifest 得到）
- `upstream_build_artifact / upstream_verify_artifact / upstream_review_artifact` = ""（build 阶段无下游 artifact）
- `original_requirement_path` = `chains/chain-pagination-001/requirement.md`

**渲染后 prompt 关键段**（template = `templates/agents/worker-builder-task.md`）：

```markdown
## Task to Execute

**Title**: 实现 /api/users 分页查询
**Description**: 按 Plan 实现 controller / service / repository 三层修改，加入参数校验，保持现有未带 page 参数时的兼容行为，并补充单元 / 集成测试。
**Acceptance Criteria**: (1) curl -G /api/users -d 'page=2&page_size=5' 返回 200 且 items.length<=5...

## Origin
The user's original requirement is preserved verbatim at `~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/requirement.md`. Cross-check the Planner blueprint against this file before implementing — if the blueprint contradicts the original intent, surface the conflict in your output instead of silently following the blueprint.

## Upstream Artifacts (read first, in order)
1. Planner blueprint (authoritative): `~/.claude-orchestrator/projects/leader-01/tasks/task-0000000001/result.md`
2. In-worktree resume copy (only if a previous build attempt exists): `~/.claude-orchestrator/projects/leader-01/docs/Jerry/2026-05-14/build-chain-pagination-001.md`
3. If both are missing → BLOCK and report to Leader via the completion report.

Extract every implementable requirement as a checklist before writing code.

## Intent
Implement the requirements in the Planner's blueprint, leaving an evidence trail the Verifier can independently re-walk. ...

## Required Output Files
- `result_path`:  ~/.claude-orchestrator/projects/leader-01/tasks/task-0000000002/result.md
- `local_doc_path`: ~/.claude-orchestrator/projects/leader-01/docs/Jerry/2026-05-14/build-chain-pagination-001.md
...
```

✅ **issue #2 修复**：`{{name}}` 渲染为 `Jerry`、`{{role}}` 渲染为 `builder`。

✅ **issue #10 修复 + 本轮巩固（cross-worktree artifact）**：原现状下 Jerry 跨 worktree 读 Tom 的 blueprint 需要 git fetch / cherry-pick，存在断链风险；现在通过 chain-shared cache 路径解决：

1. Tom 完成 plan 时 `WorkerWatcher` 把 blueprint 写到 `projects/leader-01/tasks/task-0000000001/result.md`（`result_path`，与 Leader / 所有 worker 共享）
2. ChainAudit `manifest.json.link_tasks.plan = "task-0000000001"`
3. Jerry 启动任务时，`WorkerWatcher.collectChainArtifacts` 读 chain manifest（`chains/chain-pagination-001/manifest.json`），按 `cachePaths.taskResultPath` 解析出 Tom 的 result.md 路径
4. 注入到模板 `{{upstream_plan_artifact}}` 变量
5. Jerry 直接读 chain-shared cache，跨 worktree 完全可解析；本地 worktree 副本只作"续做时的快速恢复"

✅ **本轮治理**：`task_doc_path` fallback 已从模板移除（同时从 Task/Message schema 移除），上游 artifact 路径完全依赖 `upstream_*_artifact` 变量。

## 6.5 claude-cli 主执行

调用形态、log/result 路径同 Plan，区别：
- `cwd = ~/work/co-pagination/.worktrees/Jerry`
- `system_prompt` = Jerry 的 identity card（builder 身份）
- `log_path = ~/.../projects/leader-01/tasks/task-0000000002/exec-<ts>.log`
- `result_path = ~/.../projects/leader-01/tasks/task-0000000002/result.md`

### 6.5.1 期望生成的文件

| 路径 | 内容 |
|------|------|
| `~/.../projects/leader-01/tasks/task-0000000002/result.md` | traceability-map.md（Leader / 下游 worker 视角） |
| `~/.../projects/leader-01/docs/Jerry/2026-05-14/build-chain-pagination-001.md` | local_doc_path：同上副本 |
| `~/work/.../worktrees/Jerry/.claude-orchestrator/docs/Jerry/2026-05-14/traceability-map.md` | 同上 worktree 副本（Builder 可能也写一份） |
| `~/work/.../worktrees/Jerry/.claude-orchestrator/docs/Jerry/2026-05-14/evidence/*.{md,log,json}` | 测试/构建证据 |
| `~/work/.../worktrees/Jerry/.claude-orchestrator/docs/Jerry/2026-05-14/CLAUDE.md` | 当日记忆 |
| `~/work/.../worktrees/Jerry/src/api/users-controller.ts`、`src/api/users-service.ts` 等 | 实际实现代码（贯穿样例） |
| `~/work/.../worktrees/Jerry/tests/users.test.ts` | 新增测试 |

**traceability-map.md 内容（示意）**：

```markdown
# Builder Traceability Map — /api/users 分页

| Plan Requirement | Implementation | Status | Evidence |
|------------------|----------------|--------|----------|
| 接口签名 GET /api/users?page=&page_size= | src/api/users-controller.ts:55 | done | evidence/curl-page-2.log |
| page>=1 校验 | src/api/users-service.ts:23 | done | evidence/test-out.log |
| page_size 范围 1..100 | src/api/users-service.ts:34 | done | evidence/test-out.log |
| 默认 page=1/page_size=20 | src/api/users-service.ts:18 | done | evidence/curl-default.log |
| total/page/page_size/items 响应结构 | src/api/users-controller.ts:62 | done | evidence/curl-page-2.log |
| 4xx 错误响应 | src/api/users-controller.ts:78 | done | evidence/curl-page-0.log |

Deviations: none
```

## 6.6 hook worker_message_end

CO_LINK = `build`，env 含 exit_code。

## 6.7 CommitChecker

`git status --porcelain` 此刻应有大量变更（实现文件 + 测试）。生成 commit message 模板调用、commit 同 Plan。

返回 `CommitResult`：

```json
{
  "sha": "8d5e4b3c0a2f6e7d9c5b4a3e2f1098765432bcde",
  "message": "feat(users): paginate /api/users with page/page_size",
  "changed_files": [
    " M src/api/users-controller.ts",
    " M src/api/users-service.ts"
  ],
  "untracked_files": [
    "tests/users.test.ts",
    ".claude-orchestrator/docs/Jerry/2026-05-14/traceability-map.md",
    ".claude-orchestrator/docs/Jerry/2026-05-14/evidence/curl-page-2.log",
    ".claude-orchestrator/docs/Jerry/2026-05-14/evidence/curl-default.log",
    ".claude-orchestrator/docs/Jerry/2026-05-14/evidence/curl-page-0.log",
    ".claude-orchestrator/docs/Jerry/2026-05-14/evidence/test-out.log",
    ".claude-orchestrator/docs/Jerry/2026-05-14/CLAUDE.md"
  ]
}
```

commit log 落 `projects/leader-01/tasks/task-0000000002/commit.log`。

✅ **issue #11 修复**：`execFileSync("git", ["commit", "-m", message], …)` 跳过 shell 解析，message 作为单独 argv 传递。锁定行为见 `packages/worker/tests/core/unit/commit-checker.test.ts`。

## 6.8 SelfEvaluator

同 Plan，eval log 落 `projects/leader-01/tasks/task-0000000002/eval-<N>.log`。`NEXT_LINKS["build"] = "verify"`，fallback 输出 `next_link = "verify"`。

**EvalDecision 最终内容**：

```json
{
  "decision": "activate_next",
  "reason": "all plan requirements implemented; tests passing 0 failures",
  "next_link": "verify"
}
```

### 6.8.1 Verify 的 feedback 备选（Builder 自评不通过的情形）

如果 Builder 自评不通过（criteria 部分未满足），EvalDecision schema 命中时输出：

```json
{
  "decision": "feedback",
  "reason": "test for page_size=200 4xx not implemented",
  "feedback_to_worker": "Add validation: page_size must be <=100, return 400 if exceeded",
  "feedback_target": null
}
```

✅ **issue #3 修复**：模板字段名已对齐 schema（`feedback_to_worker / feedback_target` 等）。

✅ **本轮治理（feedback 物化为 retry task）**：Leader 收到 build 自评 feedback 后，`ChainRouter.dispatchFeedbackAsRetry` 会 push 一条 retry build task（retry_count++、`description = feedback_to_worker`、`assigned_to = msg.from_instance` 即 jerry-01），通过 `task_dispatch` 派回给 Jerry，Worker 走标准 claimById → run → evaluate 循环。旧 `tasks/task-0000000002/result.md` 不被覆盖，审计可追溯。详情见 `04` §7.9.1（Verifier feedback 同一机制）。

## 6.9 完成报告 + 收尾

`task_queue.complete` → `/tasks/completed/task-0000000002`，`task_completed` hook fire（env 含 `duration_seconds`）。`processMessage` finally 写回 idle 心跳。

ZK 路径：`/claude-orchestrator/messages/leader-01/msg-0000000003`

**完整 Message JSON**：

```json
{
  "id": "msg-0000000003",
  "type": "completion_report",
  "from_instance": "jerry-01",
  "from_name": "Jerry",
  "from_role": "builder",
  "to_instance": "leader-01",
  "to_name": null,
  "content": "{\"decision\":\"activate_next\",\"reason\":\"all plan requirements implemented; tests passing 0 failures\",\"next_link\":\"verify\",\"commit\":{\"sha\":\"8d5e4b3c0a2f6e7d9c5b4a3e2f1098765432bcde\",\"message\":\"feat(users): paginate /api/users with page/page_size\",\"branch\":\"co/jerry-01\",\"changed_files\":[\" M src/api/users-controller.ts\",\" M src/api/users-service.ts\"],\"untracked_files\":[\"tests/users.test.ts\",\".claude-orchestrator/docs/Jerry/2026-05-14/traceability-map.md\",\".claude-orchestrator/docs/Jerry/2026-05-14/CLAUDE.md\"]}}",
  "link": "build",
  "task_id": "task-0000000002",
  "chain_id": "chain-pagination-001",
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "result_path": "~/.claude-orchestrator/projects/leader-01/tasks/task-0000000002/result.md",
  "original_requirement_path": null,
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:05:00.000Z"
}
```

## 6.10 Leader 路由 → 激活 Verify

`ChainRouter.route()` 判定：`msg.link === "build"`（非 plan/completion_report 短路）+ 内容不像 ChainDef → `handleCompletionReport(msg)`。

decision = `activate_next`, next_link = `verify`：
- `findOrCreatePendingTask("chain-pagination-001", "verify")` → 复用初始 `task-0000000003`
- `findIdleWorkerByRole("verifier")` → Lucy
- `task_queue.assign(task-0000000003, lucy-01, "Lucy")`
- `chain_audit.setLinkTask("verify", task-0000000003)` + `setLinkWorker("verify", lucy-01)` + record `task_dispatch`
- `message_router.send(task_dispatch → lucy-01)` → `/messages/lucy-01/msg-0000000001`

### 6.10.1 派发给 Lucy 的 task_dispatch

```json
{
  "id": "msg-0000000001",
  "type": "task_dispatch",
  "from_instance": "leader-01",
  "from_name": "Leader",
  "from_role": "leader",
  "to_instance": "lucy-01",
  "to_name": null,
  "content": "独立验证分页实现与蓝图一致",
  "link": "verify",
  "task_id": "task-0000000003",
  "chain_id": "chain-pagination-001",
  "task_title": "独立验证分页实现与蓝图一致",
  "task_description": "对照 Plan 的 5 条以上测试用例逐项执行；逐字段比对响应 schema...",
  "task_criteria": "verification-map.md 列出全部 Plan 条目的 PASS/GAP/FAILURE/DEVIATION 分类...",
  "result_path": null,
  "original_requirement_path": "~/.claude-orchestrator/projects/leader-01/chains/chain-pagination-001/requirement.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:05:01.000Z"
}
```

## Build 环节产物清单

### ZK 新增

| 路径 | 备注 |
|------|------|
| `/tasks/claimed/jerry-01-task-0000000002` | EPHEMERAL（短暂）|
| `/tasks/completed/task-0000000002` | PERSISTENT |
| `/messages/leader-01/msg-0000000003` | Jerry 完成报告 |
| `/messages/lucy-01/msg-0000000001` | task_dispatch → Lucy |

### ZK 修改

| 路径 | 修改 |
|------|------|
| `/tasks/pending/task-0000000002` | 5.9 删除（claim 时）|
| `/tasks/pending/task-0000000003` | `assigned_to` 设为 `lucy-01` |
| `/messages/jerry-01/msg-0000000001` | **删除** |
| `/messages/leader-01/msg-0000000003` | `read=true` |
| `/instances/jerry-01` | status: idle → busy → idle |

### Cache 文件（projects/leader-01/）

| 路径 | 来源 |
|------|------|
| `tasks/task-0000000002/exec-<ts>.log` | claude-cli 主执行 stream-json |
| `tasks/task-0000000002/result.md` | traceability-map.md |
| `tasks/task-0000000002/commit.log` | commit message claude 调用日志 |
| `tasks/task-0000000002/eval-{0,1,2}.log` | self-eval claude 调用日志（视重试） |
| `docs/Jerry/2026-05-14/build-chain-pagination-001.md` | local_doc_path 副本 |
| `chains/chain-pagination-001/manifest.json` | `link_tasks.verify = task-0000000003`、`link_workers.verify = lucy-01` 更新 |
| `chains/chain-pagination-001/audit.jsonl` | append `completion_report`（build）+ `task_dispatch`（verify）两行 |

### Worktree 内文件（Jerry 分支）

| 路径 | 内容 |
|------|------|
| `~/work/.../worktrees/Jerry/src/api/users-controller.ts` | 改动实现 |
| `~/work/.../worktrees/Jerry/src/api/users-service.ts` | 改动实现 |
| `~/work/.../worktrees/Jerry/tests/users.test.ts` | 新增测试 |
| `~/work/.../worktrees/Jerry/.claude-orchestrator/docs/Jerry/2026-05-14/traceability-map.md` | 追溯表 |
| `~/work/.../worktrees/Jerry/.claude-orchestrator/docs/Jerry/2026-05-14/evidence/*.log` | 测试证据 |
| `~/work/.../worktrees/Jerry/.claude-orchestrator/docs/Jerry/2026-05-14/CLAUDE.md` | 当日记忆 |

### Git commit

| 分支 | SHA | message |
|------|-----|---------|
| `co/jerry-01` | `8d5e4b3c...` | `feat(users): paginate /api/users with page/page_size` |

## 衔接到 Step 8

Lucy 的 `WorkerWatcher` 触发，开始处理 `msg-0000000001`。流程结构同 Build，差异点在 [`04-verify-link.md`](./04-verify-link.md) 展开，重点关注**chain-shared cache 读 artifact** 与 **Verify feedback 物化为 retry task** 的语义。
