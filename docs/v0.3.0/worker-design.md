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
claude-orchestrator register --name Jerry --role builder --work-dir ~/project
│
├─ 1. 连接 ZK
├─ 2. 创建 /instances/{instance_id} EPHEMERAL 节点
│     写入: {name, role: "builder", status: "idle"}
├─ 3. 保存 instance_id 到 ~/.claude-orchestrator/config.json
├─ 4. 创建 /messages/{instance_id} 消息目录
├─ 5. 读取 Leader 的 CACHE_DIR 路径（从 ZK 或配置获取）
├─ 6. 确保 CACHE_DIR/{leader_instance_id}/ 可访问
├─ 7. 加载五个 link 模板:
│     .claude-orchestrator/agents/worker-plan.md
│     .claude-orchestrator/agents/worker-build.md
│     .claude-orchestrator/agents/worker-verify.md
│     .claude-orchestrator/agents/worker-review.md
│     .claude-orchestrator/agents/worker-accept.md
├─ 8. 启动 Worker Watcher（监听 /messages/{instance_id}）
├─ 9. 进入事件循环
└─ 10. 等待 SIGINT → 清理 /instances/{id} → 断开 ZK
```

### 2.2 任务获取方式

当前阶段仅支持被动分配——Worker 等待 Leader 通过消息分配任务。

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
    │ Leader    │  │ 消息到达   │  │ 心跳/SIGINT│
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

Worker 根据 message 中的 `link` 字段选择对应模板，按标准流程执行。四种 link 对应两类标准流程：

| 标准流程 | 适用 link | 核心思想 |
|---------|----------|---------|
| `task-acceptance` | Plan, Accept | 产出 → 自检 → 提交验收。规划者定义蓝图并确保其完整可执行；验收者逐项核实交付物并签署 Go/No-Go |
| `task-traceability` | Build, Verify, Review | 追溯 → 执行 → 映射 → 举证。执行者的每一步都追溯到上游要求，产出需附带追溯证据 |

**Phase 3 — 报告结果**

Worker 按照对应模板的报告格式，通过 send_message 向 Leader 汇报。报告包含当前 link 的完成情况、result_path 和执行日志路径。

## 3. 标准执行流程

### 3.1 task-acceptance（Plan 专用）

Plan 是责任链的起点，其核心问题是"要做什么、为什么做、怎么做"。Plan 的交付物是蓝图——它必须是完整的、可执行的，后续的 Builder 才能依照执行。

task-acceptance 流程确保 Plan 产出经过充分验证后才交付：

```
┌─────────────────────────────────────────────────────────────┐
│                    task-acceptance                            │
│                                                             │
│  1. 分析需求                                                 │
│     理解目标、范围、约束                                      │
│         │                                                   │
│         ▼                                                   │
│  2. 设计蓝图                                                 │
│     定义架构、接口、数据流                                    │
│     拆解 Build 步骤、定义完成标准                             │
│         │                                                   │
│         ▼                                                   │
│  3. 自检                                                     │
│     验证蓝图的完整性和可执行性:                                │
│     - 每个 Build 步骤是否有清晰的输入输出？                    │
│     - Builder 能否仅凭此蓝图开始实施？                         │
│     - 异常路径和边界条件是否覆盖？                              │
│     - 完成标准是否可被 Verify 验证？                            │
│         │                                                   │
│         ▼                                                   │
│  4. 提交验收                                                 │
│     产出 → 随完成报告提交给 Leader                            │
│     Leader/Reviewer 判断蓝图是否验收通过                      │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 task-traceability（Build / Verify / Review 专用）

Build、Verify、Review 是责任链的执行和验证环节，每一项工作都基于上游的产出。task-traceability 流程确保每一步都可以追溯到上游要求：

```
┌─────────────────────────────────────────────────────────────┐
│                   task-traceability                           │
│                                                             │
│  1. 追溯                                                     │
│     读取上游产出，提取所有要求项:                               │
│     - Build: 追溯 Planner 蓝图中的每条实现要求                 │
│     - Verify: 追溯 Planner 蓝图 + Builder 产出的每条验证点     │
│     - Review: 追溯整条链的意图、实现、验证结果                  │
│         │                                                   │
│         ▼                                                   │
│  2. 执行                                                     │
│     按追溯到的要求逐项执行:                                    │
│     - Build: 逐项实现                                        │
│     - Verify: 逐项验证                                        │
│     - Review: 逐项审查                                        │
│         │                                                   │
│         ▼                                                   │
│  3. 映射                                                     │
│     将执行结果与上游要求建立一一映射:                           │
│     - 要求 X → 执行结果 Y → 状态: 完成/偏离/遗漏              │
│     - 记录所有偏离和遗漏，附原因                               │
│         │                                                   │
│         ▼                                                   │
│  4. 举证                                                     │
│     提供执行证据，让下游或 Reviewer 无需重做即可验证:           │
│     - 关键决策的理由                                          │
│     - 测试结果或验证数据                                      │
│     - 结果路径（可被复查的产出文件）                            │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 task-acceptance（Accept 专用）

Accept 是责任链的终点，其核心问题是"能不能交付"。Accepter 不重新执行验证或审查，而是从业务需求角度对照验收标准，逐项核实交付物是否满足要求，做出最终的 Go/No-Go 决策。

```
┌─────────────────────────────────────────────────────────────┐
│                    task-acceptance (Accept)                   │
│                                                             │
│  1. 读取全链产出                                             │
│     读取 Planner 蓝图、Builder 产出、                         │
│     Verifier 验证报告、Reviewer 审查结论                      │
│         │                                                   │
│         ▼                                                   │
│  2. 对照验收标准逐项核实                                      │
│     以原始需求的验收标准为基准:                                │
│     - 每项验收标准是否有对应的交付物？                          │
│     - 交付物是否真实存在（代码、测试、文档）？                  │
│     - 上游各环节的未解决问题是否影响交付？                      │
│         │                                                   │
│         ▼                                                   │
│  3. 做出 Go/No-Go 决策                                       │
│     Go: 所有验收标准满足，签署通过                             │
│     No-Go: 存在问题，反馈至对应环节                            │
│         │                                                   │
│         ▼                                                   │
│  4. 签署验收报告                                             │
│     产出验收报告，记录逐项核实结果和最终决策                    │
│     零问题才能签 Go，不做"条件通过"                            │
└─────────────────────────────────────────────────────────────┘
```

## 4. Worker 模板设计

### 4.1 四模板概览

每个 link 对应一个独立模板。模板不仅包含角色职责指引，更重要的是内置了该 link 的标准执行流程。

| 模板文件 | link | 标准流程 | 核心关注点 |
|---------|------|---------|-----------|
| `worker-plan.md` | `plan` | task-acceptance | 分析→设计→自检→提交验收 |
| `worker-build.md` | `build` | task-traceability | 追溯要求→逐项实现→映射→举证 |
| `worker-verify.md` | `verify` | task-traceability | 追溯蓝图→逐项验证→映射→举证 |
| `worker-review.md` | `review` | task-traceability | 追溯全链→逐项审查→映射→举证 |
| `worker-accept.md` | `accept` | task-acceptance | 读取全链产出→逐项核实验收标准→签署 Go/No-Go |

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

注意：与旧版不同，不再有 `{{current_link}}` 变量——link 已经内嵌在模板中，每个模板只服务于一个 link。

### 4.3 worker-plan.md — Planner 模板（task-acceptance）

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

## Execution Standard: task-acceptance

You follow the **task-acceptance** process. Your deliverable must pass
acceptance before the chain can proceed to Build.

### Step 1: Analyze

Analyze the requirement thoroughly:
- What is the goal? What problem does this solve?
- What are the scope and boundaries?
- What constraints exist?
- What does "success" look like for the end user?

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

### Step 3: Self-Check

Before submitting, validate your blueprint against these questions:
- [ ] Does each Build step have clear inputs and expected outputs?
- [ ] Can a Builder start implementing from this blueprint alone?
- [ ] Are edge cases and error paths covered?
- [ ] Are all interfaces and contracts unambiguous?
- [ ] Can the Verify criteria be objectively checked?
- [ ] Are there any hidden assumptions that need to be made explicit?

If any answer is "no", fix the blueprint before proceeding.

### Step 4: Submit for Acceptance

Write your blueprint document to {{result_path}}.

Then prepare a completion report. Your report must include:
- **Blueprint Summary**: one paragraph describing the design
- **Build Steps**: the ordered list of Build tasks you defined
- **Self-Check Results**: confirmation that all checklist items passed
- **Open Questions**: anything you could not resolve (if any)

Format:

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

### 4.4 worker-build.md — Builder 模板（task-traceability）

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

Write your traceability map and evidence to {{result_path}}.

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

### 4.5 worker-verify.md — Verifier 模板（task-traceability）

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

Write your verification map and evidence to {{result_path}}.

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

### 4.6 worker-review.md — Reviewer 模板（task-traceability）

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

Write your review map and evidence to {{result_path}}.

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

### 4.7 worker-accept.md — Accepter 模板（task-acceptance）

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

## Execution Standard: task-acceptance

You follow the **task-acceptance** process. Your job is NOT to re-verify
or re-review — the Verifier and Reviewer have already done that. Your job
is to validate the deliverable against the original business acceptance
criteria and sign off.

### Step 1: Read Full Chain Output

Read all upstream artifacts:
- The Planner's blueprint (original intent and acceptance criteria)
- The Builder's traceability map (what was built)
- The Verifier's verification map (what was checked)
- The Reviewer's review judgment (what was approved/flagged)

### Step 2: Verify Against Acceptance Criteria

For each acceptance criterion:
- Is there a corresponding deliverable that satisfies it?
- Does the deliverable actually exist (code, tests, documentation)?
- Are there unresolved issues from upstream links that affect delivery?
- Is the evidence sufficient and independently verifiable?

### Step 3: Make Go/No-Go Decision

- **Go**: All acceptance criteria are met. The deliverable is ready to ship.
- **No-Go**: One or more criteria are not met. Specific issues must be
  addressed by the responsible link before re-acceptance.

There is no "conditional pass". Zero issues for Go.

### Step 4: Sign Acceptance Report

Write your acceptance report to {{result_path}}. Include:
- Per-criteria verification results
- Go/No-Go decision with rationale
- If No-Go: specific issues, responsible link, and required fixes

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

  Lucy 不需要"回忆她的预设 role 是 verifier"——
  模板的内容就是 Builder 的完整执行指令。
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

## 7. Worker Watcher 实现

```typescript
// src/worker/watcher.ts
class WorkerWatcher {
  private zk: ZkClient;
  private instance: Instance;
  private workDir: string;
  private command: string;
  private cacheDir: string;
  private leaderInstanceId: string;
  private inFlight: Set<string> = new Set();
  private stopped = false;

  // 五个模板，按 link 索引
  private templates: Record<string, string> = {};

  async start(instance: Instance, workDir: string): Promise<void> {
    this.instance = instance;
    this.workDir = workDir;
    this.command = config.command;
    this.cacheDir = config.cache_dir;
    this.leaderInstanceId = await this.resolveLeaderInstanceId();

    // 加载五个 link 模板
    this.templates = {
      plan:   await this.loadTemplate("worker-plan.md"),
      build:  await this.loadTemplate("worker-build.md"),
      verify: await this.loadTemplate("worker-verify.md"),
      review: await this.loadTemplate("worker-review.md"),
      accept: await this.loadTemplate("worker-accept.md"),
    };

    await this.zk.mkdirp(paths.messageDirPath(instance.id));
    this.watchLoop();
  }

  private async watchLoop(): Promise<void> {
    if (this.stopped) return;
    const children = await this.zk.watchMessageDir(
      this.instance.id,
      (newChildren) => {
        for (const cid of newChildren) this.processMessage(cid);
        this.watchLoop();
      }
    );
    for (const cid of children) await this.processMessage(cid);
  }

  private async processMessage(msgId: string): Promise<void> {
    if (this.inFlight.has(msgId)) return;
    const msg = await this.zk.getMessage(this.instance.id, msgId);
    if (!msg || msg.read) return;

    this.inFlight.add(msgId);

    const link = msg.link || "build";
    const template = this.templates[link];
    if (!template) {
      console.error(`Unknown link: ${link}, skipping message`);
      await this.zk.markMessageRead(this.instance.id, msgId);
      this.inFlight.delete(msgId);
      return;
    }

    const uniqueKey = `task-${msg.task_id || msgId}-${Date.now().toString(36)}`;
    const logPath = path.join(this.cacheDir, this.leaderInstanceId, `${uniqueKey}.log`);
    const resultPath = path.join(this.cacheDir, this.leaderInstanceId, `${uniqueKey}-result.md`);

    // 1. 读取任务文档
    const taskDoc = msg.task_doc_path
      ? await fs.readFile(path.join(this.cacheDir, this.leaderInstanceId, msg.task_doc_path), "utf-8")
      : msg.content;

    // 2. 读取上游产出
    const upstreamContext = await this.readUpstreamOutputs(msg);

    // 3. 构建执行 prompt
    const prompt = template
      .replace("{{name}}", this.instance.name)
      .replace("{{preset_role}}", this.instance.role)
      .replace("{{task_title}}", msg.task_title || "")
      .replace("{{task_description}}", msg.task_description || taskDoc)
      .replace("{{task_criteria}}", msg.task_criteria || "")
      .replace("{{task_doc_path}}", msg.task_doc_path || "")
      .replace("{{result_path}}", resultPath)
      .replace("{{work_dir}}", this.workDir)
      .replace("{{time}}", new Date().toISOString());

    // 4. 执行
    console.log(`[${new Date().toLocaleTimeString()}] Executing as ${link}: ${msg.task_title}`);
    const { code } = await this.execWithTee(
      `${this.command} -p ${escapeShell(prompt)}`,
      logPath
    );

    // 5. 发送完成报告给 Leader
    if (code === 0) {
      const report = [
        `Link: ${link}`,
        `Status: completed`,
        `Result Path: ${resultPath}`,
        `Task completed. Leader, please review and decide next step.`,
      ].join("\n");
      await this.zk.sendMessage(this.instance.id, this.instance.name,
        report, this.leaderInstanceId);
      console.log(`Done. Report sent to Leader.`);
    }

    await this.zk.markMessageRead(this.instance.id, msgId);
    this.inFlight.delete(msgId);
  }
}
```

## 8. 与 Leader 的交互协议

### 8.1 Leader → Worker（任务分配）

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

### 8.2 Worker → Leader（完成报告）

Worker 通过 `send_message` 向 Leader 发送完成报告，报告格式由各模板定义：

```
Message:
  type: "direct"
  from_name: "Jerry"
  task_id: "task-0000000002"
  link: "build"
  status: "completed"
  result_path: "./task-0000000002-20260512T103000-result.md"
  content: "Link: build\nStatus: completed\nImplemented: 5 items...\nResult Path: ...\nNext Link Ready: yes"
```

### 8.3 Worker → Worker（协助请求）

Worker 可以向其他 Worker 发送求助消息（非任务分配，不走模板）：

```
Message:
  type: "direct"
  from_name: "Jerry" (Builder)
  to_name: "Lucy" (Verifier)
  content: "我正在实现认证模块，有个关于测试策略的问题想请教..."
```

## 9. 实施影响

### 9.1 需要修改/新增的文件

| 文件 | 说明 |
|------|------|
| `src/templates/worker-plan.md` | 新增：Planner 模板（task-acceptance 流程） |
| `src/templates/worker-build.md` | 新增：Builder 模板（task-traceability 流程） |
| `src/templates/worker-verify.md` | 新增：Verifier 模板（task-traceability 流程） |
| `src/templates/worker-review.md` | 新增：Reviewer 模板（task-traceability 流程） |
| `src/templates/worker-accept.md` | 新增：Accepter 模板（task-acceptance 流程） |
| `src/templates/worker.md` | 删除：被五个 link 模板替代 |
| `src/worker/watcher.ts` | 重写：按 link 选择模板，注入变量，构建 prompt，发送报告 |
| `src/modules/message-router.ts` | Message 增加 task_id/link/task_title/task_description/task_criteria/task_doc_path 字段 |
| `tests/unit/worker.test.ts` | 更新 Worker 测试用例，覆盖五个 link 的模板选择逻辑 |
