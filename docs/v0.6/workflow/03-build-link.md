# 03 — Step 7：Build 链环节（Jerry 处理 task-0000000006）

> 入口状态：Jerry 收件箱有 `msg-0000000001`（task_dispatch, link=build, task_id=task-0000000006）。
> 出口状态：Jerry 发完成报告，Leader 激活 Verify，派给 Lucy。
>
> 本文档只描述与 Plan link 不同的差异化内容；流程结构完全复用 `02-plan-link.md` 的 5.1–5.9。请配合阅读。

## 6.1 任务认领

同 Plan：⚠️ 不走 `task_queue.claim`，纯消息驱动。`task-0000000006` 永远沉积在 pending。

## 6.2 模板选择

`LINK_TO_TEMPLATE["build"]` → `worker-build.md`。

- 模板路径：`templates/agents/worker-build.md`
- skill：`task-execution`（`.claude/skills/task-execution/SKILL.md`）

## 6.3 hook worker_message_start

CO_LINK = `build`，其余与 Plan 一致。

## 6.4 模板渲染

vars 传入与 Plan 同一组（`task_title / task_description / task_criteria / task_doc_path / result_path / work_dir / time / content`）。

⚠️ 本步 vars 实际值（受 `01` §5.5 信息退化影响）：
- `task_title` = `"[chain-pagination-001] build"`
- `task_description` = `"[chain-pagination-001] build"`（fallback msg.content）
- `task_criteria` = `""`
- `task_doc_path` = `""`
- `result_path` = `~/.../cache/leader-01/results/task-task-0000000006.md`
- `work_dir` = `~/work/co-pagination/.worktrees/Jerry`

**渲染后 prompt 全文**：

```markdown
Your link in the responsibility chain is **Build** — produce verifiable results according to the Planner's blueprint.

## Step 0: Restore Directory Memory

Read `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` ...

## Task

- **Title**: [chain-pagination-001] build
- **Description**: [chain-pagination-001] build
- **Criteria**:
- **Spec**:

## Process

Use the **task-execution** skill ... Follow Trace → Execute → Map → Evidence → Record.

**Trace**: Read the Planner's blueprint from `.claude-orchestrator/docs/{planner_name}/YYYY-MM-DD/blueprint.md`. Fallback: ``. Extract every implementable requirement as a checklist.

## Outputs

1. Write traceability map to **~/.../cache/leader-01/results/task-task-0000000006.md** (for Leader evaluation)
2. Write identical copy to **.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/traceability-map.md** (for Verifier)
3. Save evidence files to **.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/evidence/**

## Completion Report

```
Link: build
Status: completed
Implemented: <count> items
Deviations: <count> items (list each with reason)
Evidence: .claude-orchestrator/docs/{{name}}/YYYY-MM-DD/evidence/
Traceability Map: .claude-orchestrator/docs/{{name}}/YYYY-MM-DD/traceability-map.md
Next Link Ready: yes
```

Update `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md`. Git commit with your name signature.
```

⚠️⚠️⚠️ 三处显著退化：
1. `{{name}}` 不替换（同 Plan）
2. `task_doc_path` 为空 → "Fallback: `` " 直接是空字符串
3. `{planner_name}` 在模板里是 placeholder（无大括号），Jerry 需要自行推断 planner 名（从 system prompt 中的 team 信息推断）。当前实现没有提供 planner_name 给 Jerry

### 6.4.1 Jerry 怎么拿到 Tom 的 blueprint

依现状代码，Jerry 必须：
1. 在自己的 worktree `~/work/co-pagination/.worktrees/Jerry` 中尝试读 `.claude-orchestrator/docs/Tom/2026-05-14/blueprint.md`
2. 该文件**不在 Jerry 的 worktree**（Tom 提交在 `co/tom-01` 分支，Jerry 在 `co/jerry-01` 分支）→ 读不到
3. Jerry 可能尝试 `git fetch origin co/tom-01 && git show co/tom-01:.claude-orchestrator/docs/Tom/2026-05-14/blueprint.md` —— 但模板没指引这么做
4. 实际效果：Jerry 通常会 **以为没有 blueprint**，按 msg.content `[chain-pagination-001] build` 字面 fallback 自行设计实现

⚠️ 这是 Plan→Build artifact 跨 worktree 传递的现状缺陷。模板的 "Read planner blueprint" 与实际 worktree 隔离结构存在断链。

## 6.5 claude-cli 主执行

调用形态、log/result 路径同 Plan，区别：
- `cwd = ~/work/co-pagination/.worktrees/Jerry`
- `system_prompt` = Jerry 的 identity card（builder 身份）
- `log_path = ~/.../cache/leader-01/logs/task-task-0000000006-<ts>.log`
- `result_path = ~/.../cache/leader-01/results/task-task-0000000006.md`

### 6.5.1 期望生成的文件

| 路径 | 内容 |
|------|------|
| `~/.../cache/leader-01/results/task-task-0000000006.md` | traceability-map.md（Leader 视角） |
| `~/work/.../worktrees/Jerry/.claude-orchestrator/docs/Jerry/2026-05-14/traceability-map.md` | 同上副本 |
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

## 6.6 CommitChecker

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

⚠️ commit message 由 claude 生成，可能含中文 / 特殊字符。`commit-checker.ts:58` 用 `replace(/"/g, '\\"')` 转义引号，但其他 shell 元字符（反引号等）未转义——若 commit message 含反引号有注入风险。这是现状⚠️。

## 6.7 SelfEvaluator

同 Plan。`NEXT_LINKS["build"] = "verify"`，所以 fallback 输出 `next_link = "verify"`。

**EvalDecision 最终内容**：

```json
{
  "decision": "activate_next",
  "reason": "all plan requirements implemented; tests passing 0 failures",
  "next_link": "verify"
}
```

### 6.7.1 ⚠️ Verify 的 feedback 备选

如果 Builder 自评不通过（criteria 部分未满足），Worker 输出（自评 schema 命中时）：

```json
{
  "decision": "feedback",
  "reason": "test for page_size=200 4xx not implemented",
  "feedback_to_worker": "Add validation: page_size must be <=100, return 400 if exceeded",
  "feedback_target": null
}
```

⚠️ 但当前模板把字段名写作 `feedback`（不是 `feedback_to_worker`），schema 校验失败 → fallback `activate_next` —— 实际**很难触发** feedback 路径，除非 claude 主动用 snake_case 写法绕过模板。这是 evaluator 模板需要修复的现状⚠️。

## 6.8 完成报告

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
  "task_id": "task-0000000006",
  "chain_id": "chain-pagination-001",
  "task_title": null,
  "task_description": null,
  "task_criteria": null,
  "task_doc_path": null,
  "result_path": "~/.claude-orchestrator/cache/leader-01/results/task-task-0000000006.md",
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:05:00.000Z"
}
```

## 6.9 Leader 路由 → 激活 Verify

`ChainRouter.route()` 判定：`msg.link === "build"`（非 plan/completion_report 短路）+ 内容不像 ChainDef → `handleCompletionReport(msg)`（`packages/leader/src/chain-router.ts:71`）。

decision = `activate_next`, next_link = `verify`：
- `task_queue.push({title: "[chain-pagination-001] verify", link: "verify", ...})` → `task-0000000007`
- `findIdleWorkerByRole("verifier")` → Lucy
- `message_router.send(task_dispatch → lucy-01)` → `/messages/lucy-01/msg-0000000001`

### 6.9.1 派发给 Lucy 的 task_dispatch

```json
{
  "id": "msg-0000000001",
  "type": "task_dispatch",
  "from_instance": "leader-01",
  "from_name": "Leader",
  "from_role": "leader",
  "to_instance": "lucy-01",
  "to_name": null,
  "content": "[chain-pagination-001] verify",
  "link": "verify",
  "task_id": "task-0000000007",
  "chain_id": "chain-pagination-001",
  "task_title": "[chain-pagination-001] verify",
  "task_description": null,
  "task_criteria": null,
  "task_doc_path": null,
  "result_path": null,
  "reply_to": null,
  "read": false,
  "created_at": "2026-05-14T03:05:01.000Z"
}
```

## Build 环节产物清单

### ZK 新增

| 路径 | 备注 |
|------|------|
| `/messages/leader-01/msg-0000000003` | Jerry 完成报告 |
| `/tasks/pending/task-0000000007` | 新 verify task ⚠️ 沉积 |
| `/messages/lucy-01/msg-0000000001` | task_dispatch → Lucy |

### ZK 修改

| 路径 | 修改 |
|------|------|
| `/messages/jerry-01/msg-0000000001` | **删除** |
| `/messages/leader-01/msg-0000000003` | `read=true` |

### Cache 文件

同 Plan 五类，task_id 替换为 `task-0000000006`。

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

Lucy 的 `WorkerWatcher` 触发，开始处理 `msg-0000000001`。流程结构同 Build，差异点在 [`04-verify-link.md`](./04-verify-link.md) 展开，重点关注**跨 worktree 读 artifact** 与 **Verify feedback 决策**。
