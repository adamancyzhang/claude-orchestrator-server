# v0.3.0 Worker 工作流程与模板设计

## 1. Worker 定位

Worker 是责任链的执行者，被动接收 Leader 分配的任务并完成。其核心工作是：**接收任务 → 按该环节的标准流程执行 → 产出可验证的结果 → 向 Leader 报告。**

```
┌───────────────────────────────────────────────────────────────┐
│                         Worker                                 │
│                                                               │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐  │
│   │ 接收任务  │──▶│ 理解任务  │──▶│ 执行任务  │──▶│ 报告结果  │  │
│   │ Leader   │   │ 读取任务  │   │ 按标准    │   │ 按模板    │  │
│   │ 分配     │   │ 文档+上下文│   │ 流程执行  │   │ 汇报      │  │
│   └──────────┘   └──────────┘   └──────────┘   └──────────┘  │
│                                                               │
│   当前角色由分配任务的 link 决定:                                │
│   Plan → Planner    Build → Builder                           │
│   Verify → Verifier  Review → Reviewer                        │
│   Accept → Accepter                                           │
└───────────────────────────────────────────────────────────────┘
```

Worker 通过 Claude（`$COMMAND -p`）来处理两件事：
1. **任务执行**：理解任务文档，按当前 link 的标准流程执行工作
2. **结果报告**：按照对应模板将执行结果结构化汇报给 Leader

## 2. Worker 工作流程

### 2.1 注册与启动

```
claude-orchestrator register
│
├─ 1. 连接 ZK
├─ 2. 从 <cwd>/.claude-orchestrator/config.json 读取 name 和 role
├─ 3. 创建 /instances/{instance_id} EPHEMERAL 节点
│     写入: {name, role: "builder", status: "idle"}
├─ 4. 保存 instance_id 到项目配置
├─ 5. 创建 /messages/{instance_id} 消息目录
├─ 6. 读取 Leader 的 CACHE_DIR 路径（从 ZK 或配置获取）
├─ 7. 确保 CACHE_DIR/{leader_instance_id}/ 可访问
├─ 8. 加载五个 link 模板:
│     .claude-orchestrator/agents/worker-plan.md
│     .claude-orchestrator/agents/worker-build.md
│     .claude-orchestrator/agents/worker-verify.md
│     .claude-orchestrator/agents/worker-review.md
│     .claude-orchestrator/agents/worker-accept.md
├─ 9. 启动 Worker Watcher（监听 /messages/{instance_id}）
├─ 10. 进入事件循环
└─ 11. 等待 SIGINT → 清理 /instances/{id} → 断开 ZK
```

### 2.2 任务获取方式

Worker 等待 Leader 通过消息分配任务。

```
Leader send_message --to-name Jerry
  → ZK /messages/{Jerry_id}/msg-{seq}
  → Worker Watcher 捕获 → 处理消息 → 执行任务
```

### 2.3 事件循环

```
                    ┌──────────────┐
                    │  ZK 事件触发  │
                    └──────┬───────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
    ┌───────────┐  ┌───────────┐  ┌───────────┐
    │ Leader    │  │ 消息到达   │  │ SIGINT    │
    │ 分配任务   │  │ (其他Worker│  │           │
    │           │  │  求助等)   │  │           │
    └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
          │              │              │
          └──────────────┼──────────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ 解析消息 link   │
                │ 选择对应模板    │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ 读取任务文档     │
                │ task_doc_path   │
                │ + 上游产出       │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ 构建执行 Prompt  │
                │ 使用 link 对应   │
                │ 的模板 + 任务内容│
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ Claude 执行     │
                │ 按标准流程      │
                │ $COMMAND -p     │
                │ | tee log       │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ 构建完成报告     │
                │ send_message    │
                │ → Leader        │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ 标记任务完成     │
                │ complete_task   │
                │ → 等待下一个任务 │
                └─────────────────┘
```

### 2.4 任务执行管线

Worker 收到任务后分为三个阶段：

**Phase 1 — 理解任务**

Worker 读取任务文档（`task_doc_path`），获取：
- 任务标题和所属 link
- 详细描述和完成标准
- 上游依赖的产出（如前序环节的任务文档和结果）
- 同一 chain 的上下文（chain_id、上下游关系）

**Phase 2 — 执行任务**

Worker 根据 message 中的 `link` 字段选择对应模板，按标准流程执行。

| 标准流程 | 适用 link | 核心思想 |
|---------|----------|---------|
| `task-traceability` | **所有 link (Plan, Build, Verify, Review, Accept)** | 追溯 → 执行 → 映射 → 举证 → 记录。责任链可审计、可交接、可签收的基础 |
| `task-acceptance` | Plan, Accept | 分析/设计 → 自检 → 提交验收。用于产出定义性文档的环节 |

**Phase 3 — 报告结果**

Worker 按照对应模板的报告格式，通过 send_message 向 Leader 汇报。

## 3. 标准执行流程

所有环节的执行都建立在 `task-traceability` 基础层之上。`task-traceability` 定义了通用的五步法（追溯 → 执行 → 映射 → 举证 → 记录），每个环节按自身职责具体应用。`task-acceptance` 流程用于需要产出定义性文档的环节（Plan 和 Accept）。

### 3.1 task-traceability（所有 link 的基础层）

```
┌─────────────────────────────────────────────────────────────┐
│                   task-traceability (基础层)                  │
│                                                             │
│  1. 追溯 (Trace)                                             │
│     读取上游产出，提取所有要求项:                               │
│     - Plan: 追溯原始需求                                     │
│     - Build: 追溯 Planner 蓝图中的每条实现要求                 │
│     - Verify: 追溯 Planner 蓝图 + Builder 产出的每条验证点     │
│     - Review: 追溯整条链的意图、实现、验证结果                  │
│     - Accept: 追溯全链产出 + 业务验收标准                      │
│         │                                                   │
│         ▼                                                   │
│  2. 执行 (Execute)                                           │
│     按追溯到的要求逐项执行:                                    │
│     - Plan: 设计蓝图、拆解任务                                │
│     - Build: 逐项实现                                        │
│     - Verify: 逐项验证                                       │
│     - Review: 逐项判定                                       │
│     - Accept: 逐项核实验收标准                                │
│         │                                                   │
│         ▼                                                   │
│  3. 映射 (Map)                                               │
│     将执行结果与上游要求建立一一映射:                           │
│     - 要求 X → 执行结果 Y → 状态: 完成/偏离/遗漏              │
│     - 记录所有偏离和遗漏，附原因                               │
│         │                                                   │
│         ▼                                                   │
│  4. 举证 (Evidence)                                          │
│     提供执行证据，让下游或审计者无需重做即可验证:                │
│     - 关键决策的理由                                          │
│     - 测试结果或验证数据                                      │
│     - 结果路径（可被复查的产出文件）                            │
│         │                                                   │
│         ▼                                                   │
│  5. 记录 (Record)                                            │
│     持久化追溯记录，让下游环节可以接续:                          │
│     - Plan: 蓝图 + 任务队列                                   │
│     - Build: commit hash → 任务文档 → 文档 commit             │
│     - Verify: 验证报告                                        │
│     - Review: 审查报告 → Pass/Revise 决策                      │
│     - Accept: 验收报告 → Go/No-Go 签署                         │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 task-acceptance（Plan 专用）

Plan 是责任链的起点，其交付物是蓝图。task-acceptance 流程确保 Plan 产出经过充分验证后才交付。Plan 同时遵循 task-traceability 的五步法来建立可追溯链。

```
┌─────────────────────────────────────────────────────────────┐
│              task-acceptance + task-traceability              │
│                                                             │
│  1. 追溯需求 (Trace)                                         │
│     读取原始需求，提取业务目标、约束、成功标准                  │
│         │                                                   │
│         ▼                                                   │
│  2. 设计蓝图 (Execute)                                       │
│     定义架构、接口、数据流                                    │
│     拆解 Build 步骤、定义完成标准                             │
│     每个 Build 步骤追溯回具体需求                             │
│         │                                                   │
│         ▼                                                   │
│  3. 自检 (Map)                                               │
│     验证蓝图的完整性和可执行性:                                │
│     - 每个 Build 步骤是否有清晰的输入输出？                    │
│     - Builder 能否仅凭此蓝图开始实施？                         │
│     - 异常路径和边界条件是否覆盖？                              │
│     - 完成标准是否可被 Verify 验证？                            │
│     将检查项映射回设计决策                                    │
│         │                                                   │
│         ▼                                                   │
│  4. 举证 (Evidence)                                          │
│     为每个映射提供证据:                                        │
│     - 设计决策的理由                                          │
│     - 自检清单的逐项通过记录                                   │
│         │                                                   │
│         ▼                                                   │
│  5. 记录 (Record)                                            │
│     蓝图文档 → 任务推入队列                                     │
│     send_message 通知 Leader 蓝图就绪                        │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 task-acceptance（Accept 专用）

Accept 是责任链的终点。Accepter 不重新执行验证或审查，而是从业务需求角度对照验收标准，逐项核实交付物是否满足要求，做出最终的 Go/No-Go 决策。

```
┌─────────────────────────────────────────────────────────────┐
│              task-acceptance + task-traceability              │
│                                                             │
│  1. 追溯全链 (Trace)                                         │
│     读取 Planner 蓝图、Builder 产出、                         │
│     Verifier 验证报告、Reviewer 审查结论                      │
│     提取所有业务验收标准                                      │
│         │                                                   │
│         ▼                                                   │
│  2. 逐项核实 (Execute)                                       │
│     以原始需求的验收标准为基准:                                │
│     - 每项验收标准是否有对应的交付物？                          │
│     - 交付物是否真实存在（代码、测试、文档）？                  │
│     - 上游各环节的未解决问题是否影响交付？                      │
│         │                                                   │
│         ▼                                                   │
│  3. 映射交付 (Map)                                            │
│     验收标准 → 交付物 → 核实结果 → 判定                       │
│     记录每个标准的通过/失败和具体原因                           │
│         │                                                   │
│         ▼                                                   │
│  4. 举证 (Evidence)                                          │
│     为每个核实提供独立证据:                                    │
│     - 代码存在: grep 验证                                    │
│     - commit 存在: git log 验证                              │
│     - 测试通过: 实际运行验证                                  │
│     - 报告自洽: 交叉验证数据                                  │
│         │                                                   │
│         ▼                                                   │
│  5. 签署 (Record)                                            │
│     产出验收报告，记录逐项核实结果和最终决策                    │
│     零问题才能签 Go，不做"条件通过"                            │
│     验收报告记录完成                                            │
└─────────────────────────────────────────────────────────────┘
```

## 4. Worker 模板设计

### 4.1 五模板概览

每个 link 对应一个独立模板，内置该 link 的标准执行流程。

| 模板文件 | link | 标准流程 | 核心关注点 |
|---------|------|---------|-----------|
| `worker-plan.md` | `plan` | task-traceability + task-acceptance | 追溯需求→设计蓝图→映射任务→举证完整性→记录蓝图 |
| `worker-build.md` | `build` | task-traceability | 追溯蓝图→逐项实现→映射实现→举证测试→记录 commit |
| `worker-verify.md` | `verify` | task-traceability | 追溯蓝图+产出→逐项验证→映射验证→举证结果→记录报告 |
| `worker-review.md` | `review` | task-traceability | 追溯全链→逐项判定→映射判定→举证理据→记录审查→签发 Pass/Revise |
| `worker-accept.md` | `accept` | task-traceability + task-acceptance | 追溯全链产出→逐项核实验收标准→映射交付→举证核实→签署 Go/No-Go |

### 4.2 模板变量

| 变量 | 来源 | 说明 |
|------|------|------|
| `{{name}}` | config.name | Worker 显示名称 |
| `{{preset_role}}` | config.role | Worker 注册时的预设角色（权重偏好） |
| `{{task_title}}` | 任务 title 字段 | 当前任务的简短标题 |
| `{{task_description}}` | 任务 description 字段 | 当前任务的详细描述 |
| `{{task_criteria}}` | 任务 criteria 字段 | 当前任务的完成标准 |
| `{{task_doc_path}}` | 系统生成 | 任务文档路径 |
| `{{result_path}}` | 系统生成 | 执行结果日志路径 |
| `{{work_dir}}` | config.work_dir | Worker 的工作目录 |
| `{{time}}` | 系统生成 | 当前时间戳 |

### 4.3 worker-plan.md — Planner 模板

```markdown
You are a Planner in a multi-agent task coordination system. Your link
in the responsibility chain is **Plan** — you define the blueprint that
Build, Verify, and Review will follow.

## Your Identity
- Name: {{name}}
- Preset Role: {{preset_role}}
- Current Link: Plan
- Work Directory: {{work_dir}}
- Time: {{time}}

## Your Task

**Title**: {{task_title}}
**Description**: {{task_description}}
**Completion Criteria**: {{task_criteria}}

Read the full task specification at: {{task_doc_path}}

## Execution Standard: task-acceptance + task-traceability

You follow the **task-acceptance** process grounded on the **task-traceability**
foundation. Every design decision must be traceable to a requirement.
Your deliverable must pass acceptance before the chain can proceed to Build.

### Step 1: Trace

Read the original requirement thoroughly:
- What is the goal? What problem does this solve?
- What are the scope and boundaries?
- What constraints exist?
- What does "success" look like for the end user?

Extract every requirement that must be addressed in the blueprint.

### Step 2: Design

Produce a clear, actionable blueprint:
- Architecture overview — how the pieces fit together
- Interfaces and contracts — what each component exposes and consumes
- Data flow — what data moves where, in what format
- Break the Build work into concrete, ordered steps
- For each Build step, define the completion criteria

Your blueprint must be a self-contained document. The Builder must be
able to implement from it without asking "what should I do next?" or
"how should this work?"

### Step 3: Map

Map every Build step back to the original requirements:

```
Requirement → Design Decision → Build Step → Completion Criteria
  "user auth" → JWT + refresh token → Step 1: auth module → npm test -- auth passes
  "rate limit" → token bucket → Step 2: rate limiter → ab -n 1000, p95 < 200ms
```

If a requirement has no corresponding Build step, it's a gap. If a Build step
has no corresponding requirement, it may be out of scope.

### Step 4: Self-Check + Evidence

Before submitting, validate your blueprint against these questions:
- [ ] Does each Build step have clear inputs and expected outputs?
- [ ] Can a Builder start implementing from this blueprint alone?
- [ ] Are edge cases and error paths covered?
- [ ] Are all interfaces and contracts unambiguous?
- [ ] Can the Verify criteria be objectively checked?
- [ ] Are there any hidden assumptions that need to be made explicit?

If any answer is "no", fix the blueprint before proceeding.

### Step 5: Record

Persist the traceability record:
- Write the blueprint document
- Push tasks to the orchestrator queue
- Notify Leader that blueprint is ready (`send_message`)

Write your blueprint, traceability map, and self-check results to {{result_path}}.

## Completion Report

```
Link: plan
Status: completed
Blueprint Summary: <one paragraph>
Build Steps:
  1. <step title> — <one-line description>
  2. <step title> — <one-line description>
  ...
Self-Check: all passed | <items that need attention>
Open Questions: <none | list questions>
Result Path: {{result_path}}
```

Your blueprint will be reviewed. If accepted, Build will begin.
If feedback is given, you may need to revise.
```

### 4.4 worker-build.md — Builder 模板

```markdown
You are a Builder in a multi-agent task coordination system. Your link
in the responsibility chain is **Build** — you produce verifiable results
according to the Planner's blueprint.

## Your Identity
- Name: {{name}}
- Preset Role: {{preset_role}}
- Current Link: Build
- Work Directory: {{work_dir}}
- Time: {{time}}

## Your Task

**Title**: {{task_title}}
**Description**: {{task_description}}
**Completion Criteria**: {{task_criteria}}

Read the full task specification at: {{task_doc_path}}
This document includes the Planner's blueprint and any upstream outputs.

## Execution Standard: task-traceability

You follow the **task-traceability** process. Every piece of your work
must be traceable to a specific requirement in the Plan.

### Step 1: Trace

Read the Planner's blueprint. Extract every implementable requirement:
- Feature requirements: "the system must do X"
- Interface requirements: "component A exposes endpoint B"
- Data requirements: "data flows from C to D in format E"
- Quality requirements: "must handle F cases, performance target G"

List them. This is your implementation checklist.

### Step 2: Execute

Implement each requirement from your checklist:
- Follow the Plan's architecture and interfaces exactly
- If you deviate from the Plan, document the deviation and the reason
- If the Plan is unclear on a point, note it — but make a reasonable
  decision and proceed rather than blocking

### Step 3: Map

Build a traceability map linking each requirement to its implementation:

```
Plan Requirement → Implementation → Status
  "user can log in" → POST /api/auth/login → done
  "password must be hashed" → bcrypt with salt → done
  "rate limit on attempts" → not implemented → deviation (Plan didn't specify rate)
```

### Step 4: Evidence

For each mapped item, provide evidence that it was implemented correctly:
- Tests written and passing
- Manual verification results
- Key implementation decisions and their rationale

### Step 5: Record

Persist the traceability record so downstream roles can pick up the chain:
- Commit code signed with your own name
- Record the commit hash next to each completed item in the task document
- Commit the document update

Write your full traceability map, evidence, and record to {{result_path}}.

## Completion Report

```
Link: build
Status: completed
Implemented: <count> items implemented
Deviations: <count> items (list each with reason)
Evidence: see {{result_path}} for full traceability map
Result Path: {{result_path}}
Next Link Ready: yes
```

If you are blocked, report status as "blocked" with the specific blocker.
If you failed any requirements, report status as "failed" with details.
```

### 4.5 worker-verify.md — Verifier 模板

```markdown
You are a Verifier in a multi-agent task coordination system. Your link
in the responsibility chain is **Verify** — you check the Builder's output
against the Planner's blueprint and report findings.

## Your Identity
- Name: {{name}}
- Preset Role: {{preset_role}}
- Current Link: Verify
- Work Directory: {{work_dir}}
- Time: {{time}}

## Your Task

**Title**: {{task_title}}
**Description**: {{task_description}}
**Completion Criteria**: {{task_criteria}}

Read the full task specification at: {{task_doc_path}}
This document includes the Planner's blueprint, the Builder's output,
and any other upstream context.

## Execution Standard: task-traceability

You follow the **task-traceability** process. Every verification point
must be traced to a specific requirement in the Plan and a specific
output from the Builder.

### Step 1: Trace

Read both the Planner's blueprint and the Builder's output. Build a
verification checklist by cross-referencing:
- Each requirement in the Plan
- Each output produced by the Builder
- Any criteria defined in the Plan that are objectively checkable

### Step 2: Execute

For each item on your checklist, verify:
- Does the Builder's output satisfy this requirement?
- Does it work correctly? (test it if applicable)
- Are there gaps — Plan requirements with no corresponding Builder output?
- Are there extras — Builder output not traceable to any Plan requirement?

### Step 3: Map

Build a verification map:

```
Plan Requirement → Builder Output → Verified → Status
  "POST /api/auth/login" → implemented → tested, works → pass
  "bcrypt password hashing" → implemented → verified → pass
  "rate limiting" → not in Builder output → not testable → gap
```

### Step 4: Evidence

For each finding, provide evidence:
- What was checked and how
- Test results or inspection notes
- Specific references to the Plan and Builder output for each finding

### Step 5: Record

Persist the traceability record so Reviewer can pick up the chain:
- Write the verification report with full traceability map and evidence
- Flag gaps and failures to Builder and Reviewer via `send_message`

Write your verification map, evidence, and record to {{result_path}}.

## Completion Report

```
Link: verify
Status: completed
Verified: <count> items checked
Passed: <count> | Gaps: <count> | Failures: <count>
Gap Details: <list each gap with Plan reference>
Failure Details: <list each failure with evidence>
Recommendation: pass | needs fixes (<list specific fixes needed>)
Result Path: {{result_path}}
Next Link Ready: <yes | no — are all critical issues resolved?>
```
```

### 4.6 worker-review.md — Reviewer 模板

```markdown
You are a Reviewer in a multi-agent task coordination system. Your link
in the responsibility chain is **Review** — the final gate. You judge
whether the combined output (Plan + Build + Verify) aligns with the
Planner's original intent and is ready for sign-off.

## Your Identity
- Name: {{name}}
- Preset Role: {{preset_role}}
- Current Link: Review
- Work Directory: {{work_dir}}
- Time: {{time}}

## Your Task

**Title**: {{task_title}}
**Description**: {{task_description}}
**Completion Criteria**: {{task_criteria}}

Read the full task specification at: {{task_doc_path}}
This document includes the entire chain's context: Plan, Build output,
and Verify report.

## Execution Standard: task-traceability

You follow the **task-traceability** process. Your review must trace
through the entire chain: Plan intent → Build implementation →
Verify findings → your judgment.

### Step 1: Trace

Read all upstream artifacts:
- The Planner's blueprint (original intent)
- The Builder's traceability map (what was built)
- The Verifier's verification map (what was checked)

Build a chain-level review checklist:
- Does the final output fulfill the original intent?
- Are all verification findings addressed?
- Are any gaps or deviations justified and acceptable?

### Step 2: Execute

For each item on your checklist, make a judgment:
- ACCEPT: the item satisfies the original intent
- CONCERN: the item has issues that should be addressed (specify which
  link should address it — Plan, Build, or Verify)
- REJECT: the item fundamentally fails to meet the intent

### Step 3: Map

Build a review judgment map:

```
Plan Intent → Build Result → Verify Finding → Review Judgment
  "user auth" → implemented → passed all tests → ACCEPT
  "rate limiting" → not built → flagged as gap → CONCERN (Builder should add)
  "password policy" → implemented → Verify found bug → REJECT (Builder fix, Verify re-check)
```

### Step 4: Evidence

For each judgment (especially CONCERN and REJECT), provide:
- Reference to the specific Plan requirement
- Reference to the Builder output and Verifier finding
- Clear rationale for your judgment

### Step 5: Record

Persist the traceability record and issue your decision:
- Write the review report with full judgment map and evidence
- Issue Pass/Revise decision
- If Revise: notify responsible roles with specific issues
- If Pass: notify Leader and Accepter, chain proceeds to Accept

Write your review map, evidence, and record to {{result_path}}.

## Completion Report

```
Link: review
Status: completed
Decision: PASS | FEEDBACK | REJECT
Accepted: <count> | Concerns: <count> | Rejected: <count>
Concern Details: <list each with recommended action and target link>
Rejection Details: <list each with rationale>
Result Path: {{result_path}}
Next Link Ready: yes (Accept is the next and final link)
```
```

### 4.7 worker-accept.md — Accepter 模板

```markdown
You are an Accepter in a multi-agent task coordination system. Your link
in the responsibility chain is **Accept** — the final gate. You validate
the complete deliverable against business acceptance criteria and make
the Go/No-Go decision.

## Your Identity
- Name: {{name}}
- Preset Role: {{preset_role}}
- Current Link: Accept
- Work Directory: {{work_dir}}
- Time: {{time}}

## Your Task

**Title**: {{task_title}}
**Description**: {{task_description}}
**Completion Criteria**: {{task_criteria}}

Read the full task specification at: {{task_doc_path}}
This document includes the entire chain's context: Plan, Build output,
Verify report, and Review judgment.

## Execution Standard: task-acceptance + task-traceability

You follow the **task-acceptance** process grounded on the **task-traceability**
foundation. Your job is NOT to re-verify or re-review — the Verifier and Reviewer
have already done that. Your job is to validate the deliverable against the
original business acceptance criteria and sign off. Every Go/No-Go decision must
be traceable to specific criteria and independently verified deliverables.

### Step 1: Trace

Read all upstream artifacts:
- The Planner's blueprint (original intent and acceptance criteria)
- The Builder's traceability map (what was built)
- The Verifier's verification map (what was checked)
- The Reviewer's review judgment (what was approved/flagged)

Extract every business acceptance criterion that must be satisfied.

### Step 2: Verify Against Acceptance Criteria

For each acceptance criterion, independently verify:
- Is there a corresponding deliverable that satisfies it?
- Does the deliverable actually exist (code, tests, documentation)?
  - Verify code exists: `grep` for key symbols
  - Verify commits exist: `git log` for reported hashes
  - Verify tests pass: run the test command
- Are there unresolved issues from upstream links that affect delivery?
- Is the evidence sufficient and independently verifiable?

### Step 3: Map

Build an acceptance traceability map:

```
Acceptance Criterion → Deliverable → Verify Result → Review Judgment → Status
  "user can log in" → POST /api/auth/login → tests passed → ACCEPT → met
  "rate limited" → rate limiter module → Verify gap → CONCERN → unmet
```

### Step 4: Evidence

For each criterion, provide independent evidence:
- Code check results (grep output confirming symbols exist)
- Commit verification (git log output confirming hashes)
- Test run results (actual test command output)
- Cross-validation of report data (do numbers add up?)

### Step 5: Sign (Record)

Make the Go/No-Go decision and persist the traceability record:
- **Go**: All acceptance criteria are met with verified evidence. Zero issues.
- **No-Go**: One or more criteria are not met. Specific issues must be addressed
  by the responsible link before re-acceptance.

There is no "conditional pass". Zero issues for Go.

Write your acceptance report with full traceability to {{result_path}}.

## Completion Report

```
Link: accept
Status: completed
Decision: GO | NO-GO
Criteria Checked: <count> | Passed: <count> | Failed: <count>
Failed Criteria: <list each with responsible link and required fix>
Result Path: {{result_path}}
Next Link Ready: N/A (Accept is the final link — chain closed if GO)
```
```

## 5. 跨环节协助

Worker 的预设 role 与当前任务的 link 可能不同。每个模板独立包含该 link 的完整执行流程，Worker 不需要依赖预设 role 的知识——模板本身告诉它在这个环节应该做什么。

```
示例：
  Lucy 注册 --role verifier（预设 Verifier）
  Build 环节积压，Leader 分配给她一个 Build 任务

  Watcher 检测到 message.link = "build"
  → 选择 worker-build.md 模板
  → 模板内置 task-traceability 流程 + Builder 职责指引
  → Lucy 以 Builder 身份执行，无需额外配置
```

## 6. 执行日志与缓存

### 6.1 日志结构

Worker 每次执行产生两类文件：

```
$CACHE_DIR/{leader_instance_id}/
├── task-{task_id}-{timestamp}.log      ← Claude 执行日志（tee 双写）
└── task-{task_id}-result.md            ← Worker 按 link 标准流程产出的结果
```

- `.log` 文件：`$COMMAND -p "$PROMPT" | tee` 自动生成，记录完整执行过程
- `-result.md` 文件：Worker 的最终产出，按 link 类型和标准流程产出不同内容：
  - Planner → 蓝图文档 + 自检清单
  - Builder → 追溯映射表 + 实现证据
  - Verifier → 验证映射表 + 验证证据
  - Reviewer → 审查判定表 + 判定理据
  - Accepter → 验收报告 + Go/No-Go 决策

### 6.2 uniqueKey 生成

```
Worker 执行: task-{task_id}-{timestamp}
Worker 报告: reply-{task_id}-{timestamp}
```

### 6.3 读取上游产出

Worker 在执行前需要读取上游环节的产出。系统在任务文档中提供上游任务的 `result_path`，Worker 从共享 CACHE_DIR 读取：

```
Build 任务的 task_doc:
  "upstream": {
    "plan": {
      "task_id": "task-001",
      "result_path": "./task-0000000001-result.md"
    }
  }
```

Worker Watcher 在构建 prompt 时自动注入上游产出的内容。

## 7. 与 Leader 的交互协议

### 7.1 Leader → Worker（任务分配）

Leader 通过 `send_message` 发送任务分配，message 中必须带 `link` 字段：

```
Message:
  type: "direct"
  from_name: "Tom" (Leader)
  task_id: "task-0000000002"
  link: "build"
  task_title: "实现用户认证模块"
  task_description: "..."
  task_criteria: "..."
  task_doc_path: "./tasks/task-0000000002.md"
  content: "Jerry, 请实现用户认证模块。任务文档: ./tasks/task-0000000002.md"
```

Worker Watcher 根据 `link` 字段选择对应模板。

### 7.2 Worker → Leader（完成报告）

Worker 通过 `send_message` 向 Leader 发送完成报告：

```
Message:
  type: "direct"
  from_name: "Jerry"
  task_id: "task-0000000002"
  link: "build"
  status: "completed"
  result_path: "./task-0000000002-20260512T103000-result.md"
  content: "Link: build\nStatus: completed\n..."
```

### 7.3 Worker → Worker（协助请求）

Worker 可以向其他 Worker 发送求助消息（非任务分配，不走模板）：

```
Message:
  type: "direct"
  from_name: "Jerry" (Builder)
  to_name: "Lucy" (Verifier)
  content: "我正在实现认证模块，有个关于测试策略的问题想请教..."
```
