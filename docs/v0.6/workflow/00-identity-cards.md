# 00 — 5 个 Worker 身份卡（贯穿样例的实例化形态）

> 本文档定义贯穿样例中 5 个 Worker 的身份卡，并描述身份卡是如何拼接、注入到 claude-cli 的。所有后续步骤文档中"Tom / Jerry / Lucy / Mia / Leo"四个字段都指向这里。

## 1. 身份卡组成

身份卡是注入到 claude-cli `--append-system-prompt` 的字符串。由两部分顺序拼接：

```
<worker-identity.md 渲染结果>
+
<templates/claude-memory/personal-claude-{role}.md 内容>
```

- **结构模板**：`templates/agents/worker-identity.md`
- **角色专属规则**：`templates/claude-memory/personal-claude-{planner|builder|verifier|reviewer|accepter}.md`
- **拼接位置**：`packages/runtime/src/runner.ts:25-35` 的 `ClaudeRunner.buildIdentityPrompt()` 负责把 `worker-identity.md` 模板渲染好，再由 orchestrator 把 role memory 拼接到尾部，最终成 `WorkerWatcherOptions.identity_system_prompt`（`packages/worker/src/watcher.ts:47`）。
- **注入方式**：`packages/worker/src/watcher.ts:118` 把它作为 `runner.run()` 的 `system_prompt` 参数传入，`ClaudeRunner` 通过 `claude --append-system-prompt '<...>' -p '<user prompt>'` 注入。
- **prompt caching 友好**：身份卡内容与每条任务正交，命中 system prompt cache。

## 2. `worker-identity.md` 渲染规则

源文件内容（5 行 + 占位符）：

```markdown
## Worker Identity
You are **{{name}}**, a **{{role}}** in the multi-agent orchestration system.
- Name: {{name}}
- Role: {{role}}
- Worktree: {{worktreePath}}
- Branch: {{worktreeBranch}}
- Instance: {{instanceId}}
```

`ClaudeRunner.buildIdentityPrompt()` 替换 5 个占位符（驼峰）：`{{name}} / {{role}} / {{worktreePath}} / {{worktreeBranch}} / {{instanceId}}`。

## 3. ✅ 模板里的 `{{name}}` 占位符（已统一替换）

`worker-identity.md` 中的 `{{name}}` 由 `ClaudeRunner.buildIdentityPrompt()` 替换（驼峰键 `name`）。`templates/agents/worker-plan.md`、`worker-build.md`、`worker-verify.md`、`worker-review.md`、`worker-accept.md`、`worker-decompose.md`、`worker-evaluate.md` 等中也使用 `{{name}}`（例如 `Read .claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md`）。

**✅ issue #2 修复**：在 `WorkerWatcher.processMessage`、`SelfEvaluator.evaluate`、`ChainRouter.handleRequirement` 的 render vars 中都补传了 `name` 与 `role`：

| 调用点 | name 来源 | role 来源 |
|--------|----------|----------|
| `WorkerWatcher.processMessage` | `this.opts.worker_name` | `this.opts.worker_role` |
| `SelfEvaluator.evaluate` | `this.opts.worker_name` | `this.opts.worker_role` |
| `ChainRouter.handleRequirement`（Leader 自处理 decompose） | `this.opts.leader_name` | 字面 `"leader"` |

Worker 任务模板和自评估模板里的 `{{name}}` / `{{role}}` 现在会被实际替换，不再依赖 Claude 上下文推理。锁定行为见 `packages/worker/tests/core/unit/evaluator.test.ts` "substitutes {{name}} and {{role}}"。

⚠️ 残留点：`personal-claude-{role}.md` 内容被 orchestrator 直接拼接进 identity prompt 后，body 里的 `{{name}}` 不会被 `buildIdentityPrompt` 替换（它只识别驼峰 5 个键）。这层目前仍依赖 Claude 上下文推理。后续若需要彻底治理，可让 orchestrator 在拼接前先 render `personal-claude-{role}.md`。

## 4. role → skill / 模板 / 产出 / 权重 总览表

| role | 主任务模板 | 责任链 skill（`.claude/skills/`） | 典型产出（`{{name}}/YYYY-MM-DD/`） | role-link 权重表（plan, build, verify, review, accept） |
|------|-----------|---------------------------------|----------------------------------|-------------------------------------------------------|
| planner | `worker-plan.md` | `task-planning` | `blueprint.md` | **100**, 10, 10, 20, 10 |
| builder | `worker-build.md` | `task-execution` | `traceability-map.md` + `evidence/` | 10, **100**, 20, 10, 10 |
| verifier | `worker-verify.md` | `task-verification` | `verification-map.md` + `evidence/` | 10, 20, **100**, 20, 10 |
| reviewer | `worker-review.md` | `task-review` | `review-judgment.md` | 20, 10, 20, **100**, 20 |
| accepter | `worker-accept.md` | `task-acceptance` | `acceptance-report.md` | 10, 10, 10, 20, **100** |
| leader | （`worker-decompose.md` 自处理 / 合并决策模板） | — | — | 0, 0, 0, 0, 0 |

来源：`packages/contracts/src/roleWeights.ts:3-12`。权重 100 表示该 role 对该 link 是首选；非 0 表示可作为兜底（任意 worker 都能在 idle 时被 ChainRouter 派发任意 link 的任务，权重影响的是后续 `task_queue.claim()` 排序，但当前 `WorkerWatcher` 不会主动 claim，详见 README ⚠️ 1）。

所有 role 共享 `task-traceability` 作为底层流程（Trace → Execute → Map → Evidence → Record），见 `templates/claude-memory/team-claude.md`。

## 5. 5 个 Worker 身份卡实例（贯穿样例）

### 5.1 Tom — Planner

**基础信息**
| 字段 | 值 |
|------|----|
| name | `Tom` |
| role | `planner` |
| instance_id | `tom-01` |
| worktree_path | `~/work/co-pagination/.worktrees/Tom` |
| worktree_branch | `co/tom-01` |
| cache_dir | `~/.claude-orchestrator/cache` |

**渲染后的 identity system prompt（首段）**

```
## Worker Identity
You are **Tom**, a **planner** in the multi-agent orchestration system.
- Name: Tom
- Role: planner
- Worktree: ~/work/co-pagination/.worktrees/Tom
- Branch: co/tom-01
- Instance: tom-01

# {{name}} — Planner

You define the blueprint that all downstream roles follow. Read `.claude/skills/task-planning/SKILL.md` ...
...
```

（注：第二段 `{{name}}` 字面保留，未替换 —— 见 §3 ⚠️）

**能力边界**：需求解析、蓝图设计、Build 步骤拆解、可验证完成标准的拟定。
**首选 link**：plan（权重 100）。
**典型产出**：`blueprint.md` 到 `result_path`（供 Leader）和 `.claude-orchestrator/docs/Tom/YYYY-MM-DD/blueprint.md`（供下游 Builder）。
**禁止**：实现代码 / 模糊验收标准 / 跳过 self-check。

### 5.2 Jerry — Builder

**基础信息**
| 字段 | 值 |
|------|----|
| name | `Jerry` |
| role | `builder` |
| instance_id | `jerry-01` |
| worktree_path | `~/work/co-pagination/.worktrees/Jerry` |
| worktree_branch | `co/jerry-01` |
| cache_dir | `~/.claude-orchestrator/cache` |

**能力边界**：读 Tom 的 blueprint → 实现 → 生成 traceability-map → 跑测试留证据 → git commit。
**首选 link**：build（权重 100）。
**典型产出**：`traceability-map.md` + `evidence/` 下若干测试输出文件。
**禁止**：无 Plan 依据的实现 / 把"代码层面已实现"当证据 / 做架构决策（属 Planner 域）。

### 5.3 Lucy — Verifier

**基础信息**
| 字段 | 值 |
|------|----|
| name | `Lucy` |
| role | `verifier` |
| instance_id | `lucy-01` |
| worktree_path | `~/work/co-pagination/.worktrees/Lucy` |
| worktree_branch | `co/lucy-01` |
| cache_dir | `~/.claude-orchestrator/cache` |

**能力边界**：读 Plan + Build 两份产出 → 逐项判定 PASS / GAP / FAILURE / DEVIATION → 跑实际测试取证据。
**首选 link**：verify（权重 100）。
**典型产出**：`verification-map.md` + `evidence/` 下测试输出。
**禁止**：只读代码不跑测试 / 做架构判断（Reviewer 域）。
**Block 条件**：上游 Plan 或 Build artifact 缺失 → 在 Completion Report 中标 BLOCKED 反馈给 Leader。

### 5.4 Mia — Reviewer

**基础信息**
| 字段 | 值 |
|------|----|
| name | `Mia` |
| role | `reviewer` |
| instance_id | `mia-01` |
| worktree_path | `~/work/co-pagination/.worktrees/Mia` |
| worktree_branch | `co/mia-01` |
| cache_dir | `~/.claude-orchestrator/cache` |

**能力边界**：读 Plan + Build + Verify 三份产出 → 整链一致性判定 → ACCEPT / CONCERN / REJECT。
**首选 link**：review（权重 100）。
**典型产出**：`review-judgment.md`。
**禁止**：未读全三份 artifact 就 PASS / 在 Verifier FAILURE 未解决时 PASS / 做实现决策。

### 5.5 Leo — Accepter

**基础信息**
| 字段 | 值 |
|------|----|
| name | `Leo` |
| role | `accepter` |
| instance_id | `leo-01` |
| worktree_path | `~/work/co-pagination/.worktrees/Leo` |
| worktree_branch | `co/leo-01` |
| cache_dir | `~/.claude-orchestrator/cache` |

**能力边界**：读 Plan + Build + Verify + Review 四份 artifact → 业务验收 → 二元 Go / No-Go。
**首选 link**：accept（权重 100）。
**典型产出**：`acceptance-report.md`。
**禁止**：条件式 GO / 重新做验证（Verifier 域）/ 重新审查（Reviewer 域）。

## 6. ZK 注册形态（启动后）

5 个 Worker + Leader 在 ZK 上注册的 instance 节点：

```
/claude-orchestrator/instances/
├── leader-01    [EPHEMERAL]  {"id":"leader-01","name":"Leader","role":"leader","status":"idle",...}
├── tom-01       [EPHEMERAL]  {"id":"tom-01","name":"Tom","role":"planner","status":"idle",...}
├── jerry-01     [EPHEMERAL]  {"id":"jerry-01","name":"Jerry","role":"builder","status":"idle",...}
├── lucy-01      [EPHEMERAL]  {"id":"lucy-01","name":"Lucy","role":"verifier","status":"idle",...}
├── mia-01       [EPHEMERAL]  {"id":"mia-01","name":"Mia","role":"reviewer","status":"idle",...}
└── leo-01       [EPHEMERAL]  {"id":"leo-01","name":"Leo","role":"accepter","status":"idle",...}
```

每个节点的 schema 见 `packages/contracts/src/schemas/instance.ts`。`status` 由 `IInstanceRegistry` 在 watcher / chain-router 通过 `findIdleWorkerByRole` 检查（`packages/leader/src/chain-router.ts:246-256`）—— **但当前实现并没有写 `status="busy"` 的代码路径**（Worker 处理任务时 status 仍为 `idle`），所以 `findIdleWorkerByRole` 实际上只筛 role 不筛 status。这是一个现状⚠️，影响第二条链 / 并发派发的行为。

## 7. 消息收件箱（每个 instance 一个）

每个 instance 在 `/claude-orchestrator/messages/{instance_id}/` 下有自己的消息箱（mkdirp 在 `MessageRouter.send`，`packages/coordination/src/message-router.ts:73-74` 中按需创建）。本贯穿样例中：

```
/claude-orchestrator/messages/
├── leader-01/   ← Leader 自己的收件箱，TUI 输入和 5 个 worker 的 completion_report 都进这里
├── tom-01/      ← Planner 收件箱
├── jerry-01/   ← Builder
├── lucy-01/    ← Verifier
├── mia-01/      ← Reviewer
└── leo-01/      ← Accepter
```

每条消息节点都是 `PERSISTENT_SEQUENTIAL`，命名 `msg-{NNNNNNNNNN}`。Worker 处理完会 `dismiss()` 删除自己的消息（`packages/worker/src/watcher.ts:163`）；**Leader 处理完不删除**，消息会留下来（但 `read=true`，`MessageRouter.poll` 标记，`packages/coordination/src/message-router.ts:97-102`）。
