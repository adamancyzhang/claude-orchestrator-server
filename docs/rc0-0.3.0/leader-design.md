# v0.3.0 Leader 工作流程与任务生成设计

## 1. Leader 定位

Leader 是责任链的协调者，不直接执行任务。其核心工作是：**将需求转化为可执行的任务链，并推动任务走完 Plan → Build → Verify → Review → Accept 闭环。**

```
                     ┌─────────────┐
                     │   需求输入   │
                     └──────┬──────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                              Leader                                        │
│                                                                          │
│   ┌──────────┐   ┌──────────┐   ┌──────────────────┐                     │
│   │ 任务生成  │──▶│ 调度分发  │──▶│ 进度跟踪 & 闭环   │                     │
│   │ Claude   │   │ 权重匹配  │   │ 负载感知          │                     │
│   │ 拆解需求  │   │ 瓶颈疏解  │   │ 反馈协调          │                     │
│   └──────────┘   └──────────┘   └──────────────────┘                     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┬───────────────────┐
        ▼                   ▼                   ▼                   ▼
    Planner             Builder             Verifier         Reviewer/Accepter
```

Leader 通过 Claude（`$COMMAND -p`）来处理三类消息：
1. **任务生成**：通过 TaskGenerator 将自然语言需求拆解为结构化的环节任务
2. **调度决策**：通过 DecisionEngine 理解 Worker 的完成报告，决定下一步调度
3. **回退执行**：当 TaskGenerator 不可用时，直接执行 Claude CLI 处理消息

## 2. Leader 工作流程

### 2.1 启动阶段

```
claude-orchestrator leader
│
├─ 1. 连接 ZK，创建 /leader EPHEMERAL 节点（声明领导权）
├─ 2. 注册自身 Instance（role=leader），获得 instance_id
├─ 3. 初始化 CACHE_DIR：~/.claude-orchestrator/sessions/{instance_id}/
├─ 4. 加载 .claude-orchestrator/agents/leader-decompose.md 和 leader-decide.md 模板
├─ 5. 扫描 ZK 状态：
│     - 读取 /instances  → 重建团队视图
│     - 读取 /tasks      → 重建任务队列视图
│     - 执行孤儿回收     → 将断线 Worker 的 claimed 任务移回 pending
├─ 6. 启动 Leader Watcher（监听 /messages/{leader_id}）
├─ 7. 启动 Worker Monitor（监听 /instances 变化）
├─ 8. 启动 Task Monitor（监听 /tasks 变化）
├─ 9. 初始化 TUI 面板（含键盘输入支持）
├─ 10. 注册 TUI 输入回调 → 用户输入文本以 ZK 消息形式发送到自身消息队列
└─ 11. 进入事件循环
```

### 2.2 事件循环

Leader 启动后进入阻塞式事件循环，所有行为由 ZK 事件驱动：

```
                    ┌──────────────┐
                    │  ZK 事件触发  │
                    └──────┬───────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
    ┌───────────┐  ┌───────────┐  ┌───────────┐
    │Worker 变化 │  │ Task 变化  │  │ Message   │
    │           │  │           │  │ 到达      │
    └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
          │              │              │
          ▼              ▼              ▼
    ┌───────────┐  ┌───────────┐  ┌─────────────────────┐
    │更新团队视图│  │更新任务视图│  │ 消息分流处理:        │
    │重绘 TUI   │  │重绘 TUI   │  │ - 有 link → Decision │
    └───────────┘  └───────────┘  │ - 无 link → TaskGen  │
                                  │ - 回退 → 直接 Claude │
                                  └──────────┬──────────┘
                                             │
                                             ▼
                                       ┌───────────┐
                                       │ 更新 ZK   │
                                       │ 重绘 TUI  │
                                       └───────────┘
```

### 2.3 三个 Monitor

| Monitor | 监听路径 | 触发事件 | 处理逻辑 |
|---------|---------|---------|---------|
| **Worker Monitor** | `/instances` | Worker 上线/下线/状态变更 | 更新团队视图，若 Worker 断线则回收其 claimed 任务 |
| **Task Monitor** | `/tasks/pending`, `/tasks/claimed` | 任务新增/认领/完成/阻塞 | 更新任务队列视图，检测孤儿任务 |
| **Leader Watcher** | `/messages/{leader_id}` | Worker 发送完成报告/求助 / TUI 用户输入 | 三分支分流: DecisionEngine（带 link） / TaskGenerator 拆解需求 / 直接 Claude 执行 |

## 3. 任务生成：Claude 驱动的需求拆解

### 3.1 生成管线

Leader 接收到需求后，通过 Claude 将需求拆解为结构化的环节任务：

```
需求输入（自然语言）
    │
    ▼
┌─────────────────────────────────────────────┐
│ Step 1: 构建 Task Generation Prompt         │
│         使用 leader-decompose.md 模板        │
│         + 团队状态 + 需求内容                │
└────────────────────┬────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│ Step 2: Claude 处理                         │
│         $COMMAND -p "$PROMPT"               │
│         | tee $CACHE_DIR/task-gen-{ts}.log  │
│                                             │
│         Claude 输出结构化任务链对象:          │
│         {chain_id, chain_title,              │
│          tasks: {plan?, build, verify,        │
│                  review, accept}}            │
│         每个链固定五类任务，plan 可选          │
└────────────────────┬────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│ Step 3: 解析 Claude 输出                    │
│         提取结构化任务，写入任务文档          │
│         每个任务写为 .md 文件到              │
│         $CACHE_DIR/{id}/tasks/{task_id}.md  │
└────────────────────┬────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│ Step 4: 写入 ZK 任务队列                    │
│         push_task --title "..."             │
│         --link plan|build|verify|review|accept │
│         --chain-id {chain_id}               │
│         --task-doc ./tasks/{task_id}.md     │
└─────────────────────────────────────────────┘
```

### 3.2 模板分离：两个独立模板

| 场景 | 模板文件 | 触发时机 | 输入 | 输出 |
|------|---------|---------|------|------|
| **任务分解** | `leader-decompose.md` | 收到用户需求 | 需求描述 + 团队状态 | chain 对象 (tasks: {plan?, build, verify, review, accept}) |
| **调度决策** | `leader-decide.md` | 收到 Worker 完成报告 | Worker 报告 + 任务状态 + 团队状态 | 调度指令 |

### 3.3 任务文档生成

Claude 输出的是一个 chain 对象，其中 `tasks` 为固定结构。每个非空任务被写入独立的 `.md` 文件：

```
$CACHE_DIR/{leader_instance_id}/
└── tasks/
    ├── task-0000000001.md   ← Plan: 用户认证模块蓝图 (可选，可能不存在)
    ├── task-0000000002.md   ← Build: 实现用户认证模块
    ├── task-0000000003.md   ← Verify: 认证模块验证
    ├── task-0000000004.md   ← Review: 认证模块审查
    └── task-0000000005.md   ← Accept: 认证模块验收
```

### 3.4 任务间依赖

同一 chain 内最多 5 个任务，按责任链顺序单向依赖：

```
chain-001:
  task-001 (Plan)    ──无依赖，可直接认领（若存在）
  task-002 (Build)   ──依赖 Plan 完成（若 Plan 存在），否则无依赖
  task-003 (Verify)  ──依赖 Build 完成
  task-004 (Review)  ──依赖 Verify 完成
  task-005 (Accept)  ──依赖 Review 完成
```

Plan 可选意味着：当需求足够清晰时，可以跳过 Plan 直接从 Build 开始。但 Build、Verify、Review、Accept 四者必须存在。每个环节只有一个任务。

## 4. 任务优先级模型

### 4.1 三维优先级

```
Priority_Score = f(urgency, link, dependencies)

urgency:     0 (紧急) / 1 (高) / 2 (普通) / 3 (低)
link:        plan=5, build=4, verify=3, review=2, accept=1
             越靠链首越优先——解除后续阻塞
dependencies: 被阻塞的下游任务数——阻塞越多，优先级越高
```

### 4.2 Leader 调度优先级规则（从高到低）

| 优先级 | 规则 | 说明 |
|--------|------|------|
| 1 | **紧急插队** | `urgency=0` 的任务直接排到队列头部 |
| 2 | **链首优先** | Plan 任务优先于 Build，Build 优先于 Verify（上游解除下游阻塞） |
| 3 | **阻塞价值** | 一个 Plan 任务阻塞了 3 个 Build → 比孤立的 Build 更优先 |
| 4 | **权重匹配** | 同优先级下，分配给预设 role 匹配的 Worker |
| 5 | **负载均衡** | 同环节内，分配给当前任务数最少的 Worker |

### 4.3 队列视图

Leader TUI 按环节分组，每个任务标注推荐分配人：

```
┌─ Pending Tasks ───────────────────────────────────────────────────────┐
│ [Plan]   高  chain-001: 用户认证模块蓝图    → Alice (planner, idle)   │
│ [Build]  普通 chain-001: 实现用户认证模块    → Jerry (builder, idle)   │
│ [Verify] 高   chain-001: 认证模块验证        → Lucy (verifier, idle)   │
│ [Review] 普通 chain-001: 认证模块审查        → Bob (reviewer, idle)    │
│ [Accept] 普通 chain-001: 认证模块验收        → Eve (accepter, idle)    │
│ ──────────────────────────────────────────────────────────────────── │
│ [Build]  低   chain-002: 修复分页 Bug        → 任意空闲                │
│ [Verify] 普通 chain-002: 分页 Bug 验证       → 任意空闲                │
│ [Review] 普通 chain-002: 分页修复审查        → 任意空闲                │
│ [Accept] 普通 chain-002: 分页修复验收        → 任意空闲                │
└──────────────────────────────────────────────────────────────────────┘
```

## 5. Leader 调度决策流程

### 5.1 消息分流处理

Leader Watcher 收到消息后，根据消息类型进行三分支分流：

```
消息到达 /messages/{leader_id}/msg-{seq}
    │
    ▼
┌─────────────────────────────────────────────┐
│ 1. 读取消息内容，解析 MessageSchema          │
│    输出 [Watcher] 日志记录消息来源和内容      │
└────────────────────┬────────────────────────┘
                     │
                     ▼
              ┌──────┴──────┐
              │  消息带 link? │
              └──────┬──────┘
                     │
         ┌───────────┴───────────┐
         │ 是 (Worker 完成报告)    │ 否 (通用消息/用户输入)
         ▼                       ▼
┌────────────────────┐  ┌────────────────────────────┐
│ DecisionEngine     │  │ TaskGenerator.decompose()  │
│ .evaluate()        │  │                            │
│                    │  │ 使用 leader-decompose.md    │
│ 使用 leader-decide │  │ 模板将自然语言需求拆解为    │
│ .md 模板评估环节   │  │ 结构化任务链，写入 ZK       │
│ 是否通过，决定     │  │ 任务队列。Worker 在正确的   │
│ 下一步调度动作     │  │ 工作目录中拾取并执行。      │
│                    │  │                            │
│ 输出: pass/feedback│  │ 若 TaskGenerator 不可用，   │
│ /reject 决策       │  │ 回退到直接 Claude 执行。    │
└────────┬───────────┘  └────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ 执行决策:                                     │
│    - 通过 → push_task 下一环节 / 更新依赖     │
│    - 驳回 → send_message 反馈给原 Worker      │
│    - 阻塞 → 记录阻塞原因，调度其他任务         │
└─────────────────────────────────────────────┘
```

**分流原因**：Leader 自身的工作目录可能与实际项目目录不同，直接执行 `claude-cli -p` 无法正确访问项目文件。通过 TaskGenerator 将需求拆解为任务链后，由 Worker 在其正确的工作目录中执行。

### 5.2 Worker 完成报告处理 (DecisionEngine 路径)

消息带有 `link` 字段时，表示 Worker 的环节完成报告：

### 5.3 任务分配决策

```
assign(worker, task):
  1. 依赖检查: task 的上游依赖是否已满足？
     - 否 → 跳过，等上游完成
  2. 权重匹配: worker.preset_role == task.link？
     - 是 → 优先分配（权重 × 2）
     - 否 → 可以分配，但权重较低
  3. 负载检查: worker 当前任务数是否 < 阈值？
     - 是 → 适合分配
     - 否 → 寻找其他 worker
```

## 6. Leader 提示词设计：两个独立模板

### 6.1 模板概览

| | leader-decompose.md | leader-decide.md |
|------|---------|------|
| **触发时机** | Leader 收到用户需求 | Worker 发来完成报告 |
| **输入变量** | `{{team_status}}`, `{{content}}` | `{{team_status}}`, `{{task_queues}}`, `{{chain_status}}`, `{{content}}` |
| **输出** | 结构化任务链 JSON | 调度决策指令 |
| **关注点** | "这个需求应该拆成哪些任务" | "这个环节通过了没有，下一步做什么" |

### 6.2 模板变量

| 变量 | 来源 | decompose | decide | 说明 |
|------|------|:---:|:---:|------|
| `{{leader_name}}` | config.name | — | ✓ | Leader 显示名称 |
| `{{team_status}}` | 系统生成 | ✓ | ✓ | 当前团队状态 JSON |
| `{{task_queues}}` | 系统生成 | — | ✓ | 各环节任务队列摘要 |
| `{{chain_status}}` | 系统生成 | — | ✓ | 当前处理中的 chain 状态（各环节完成情况） |
| `{{content}}` | 系统输入 | ✓ | ✓ | decompose: 用户需求；decide: Worker 完成报告 |

### 6.3 leader-decompose.md — 任务分解

```markdown
You are a task decomposition specialist. Your job is to break down a
requirement into a chain of tasks following the Plan → Build → Verify →
Review → Accept responsibility chain.

## Responsibility Chain

1. **Plan** — Define the blueprint. What needs to be done, why, and how.
2. **Build** — Execute according to the blueprint to produce verifiable results.
3. **Verify** — Check the Builder's output against the Planner's blueprint.
4. **Review** — Quality gate. Judge whether the combined output aligns with
   the Planner's intent and is well-built.
5. **Accept** — Final acceptance. Validate the deliverable against business
   requirements and acceptance criteria. Make the Go/No-Go decision.

## Current Team

{{team_status}}

## Requirement

{{content}}

## Instructions

1. Analyze the requirement. Identify how many independent delivery chains
   are needed (usually one, but complex requirements may need multiple).
2. For each chain, define the five link tasks. Plan is optional — omit it
   (set to null) when the requirement is already clear enough to start
   building directly. Build, Verify, Review, and Accept are mandatory.
3. For each task, specify clear completion criteria — what "done" means
   for that specific link.
4. Assign a priority to each task:
   - 0: Urgent (blocks critical path)
   - 1: High
   - 2: Normal
   - 3: Low

## Output Format

Output exactly one JSON object per chain. tasks is a fixed object with five
slots: plan (nullable), build (required), verify (required), review (required),
accept (required).

```json
{
  "chain_id": "chain-<seq>",
  "chain_title": "<short summary of the requirement>",
  "tasks": {
    "plan": {
      "title": "<short title>",
      "description": "<detailed description, what the Planner should produce>",
      "criteria": "<completion criteria for this link>",
      "priority": 1
    },
    "build": {
      "title": "<short title>",
      "description": "<detailed description, what the Builder should implement>",
      "criteria": "<completion criteria for this link>",
      "priority": 1
    },
    "verify": {
      "title": "<short title>",
      "description": "<what and how to verify>",
      "criteria": "<completion criteria for this link>",
      "priority": 1
    },
    "review": {
      "title": "<short title>",
      "description": "<what to review, key concerns>",
      "criteria": "<completion criteria for this link>",
      "priority": 1
    },
    "accept": {
      "title": "<short title>",
      "description": "<what to validate for final acceptance, acceptance criteria>",
      "criteria": "<completion criteria for this link>",
      "priority": 1
    }
  }
}
```

If plan is not needed, set it to null:
```json
{
  "chain_id": "chain-<seq>",
  "chain_title": "<short summary>",
  "tasks": {
    "plan": null,
    "build": { ... },
    "verify": { ... },
    "review": { ... },
    "accept": { ... }
  }
}
```

Output ONLY the JSON. No explanation before or after.
```

### 6.4 leader-decide.md — 调度决策

```markdown
You are the decision engine for a task coordination system. Your job is to
evaluate a worker's completion report and decide the next action. You do NOT
decompose new requirements — that is handled by a separate process.

## Responsibility Chain (for context)

Plan → Build → Verify → Review → Accept. A task is only CLOSED after all five
links sign off. Each link has completion criteria set when the task was created.

## Current State

### Team
{{team_status}}

### Task Queues
{{task_queues}}

### Current Chain
{{chain_status}}

## Worker Report

{{content}}

## Decision Rules

1. **Evaluate the report against the task's completion criteria.**
   - If the criteria are met → the link PASSES
   - If the criteria are partially met → FEEDBACK (tell worker what's missing)
   - If the criteria are not met → REJECT (explain why, return for rework)

2. **Check chain position.**
   - If this was the Accept link and it passes → the chain is CLOSED
   - Otherwise → the next link's tasks become unblocked

3. **Consider team load when assigning the next task.**
   - Prefer workers whose preset role matches the next link
   - If all role-matched workers are busy, any idle worker can take it
   - If a different link is a bottleneck, suggest cross-role assistance

4. **Priority override.**
   - If there is an urgency=0 task in the queue, suggest handling it first

## Output Format

Output exactly one JSON decision:

```json
{
  "decision": "pass" | "feedback" | "reject",
  "reason": "<one-line explanation>",
  "feedback_to_worker": "<only if decision is feedback or reject: specific guidance>",
  "next_action": {
    "action": "activate_next_link" | "reassign" | "close_chain" | "broadcast_help" | "none",
    "next_link": "build" | "verify" | "review" | "accept" | null,
    "suggested_worker": "<worker name or null for auto-assign>",
    "message_to_worker": "<task assignment message if activating next link>"
  }
}
```

Output ONLY the JSON. No explanation before or after.
```

## 7. TUI 设计

### 7.1 布局

Leader TUI 分为五个区域，支持键盘输入向 Leader 发送消息：

```
┌─ Team Panel ─────────────────────────────────────────────────────────┐
│ Name    Preset      Current Role   Status   Current Task             │
│ Alice   planner     Planner        busy     task-001 (Plan)          │
│ Jerry   builder     Builder        busy     task-002 (Build)         │
│ Lucy    verifier    (idle)         idle     -                        │
│ Bob     reviewer    (idle)         idle     -                        │
│ Eve     accepter    (idle)         idle     -                        │
└──────────────────────────────────────────────────────────────────────┘

┌─ Pending Tasks ─────────────────────┐ ┌─ In Progress ───────────────┐
│ [Plan]   高  chain-01: 认证模块蓝图  │ │ Alice: task-001 (Plan)       │
│ [Build]  普通 chain-01: 实现认证    │ │ Jerry: task-002 (Build)      │
│ [Verify] 高   chain-01: 认证验证    │ │                              │
│ [Review] 普通 chain-01: 认证审查    │ │                              │
│ [Accept] 普通 chain-01: 认证验收    │ │                              │
└─────────────────────────────────────┘ └──────────────────────────────┘

┌─ Event Log ──────────────────────────────────────────────────────────┐
│ [10:00:00] Leader started (instance: a1b2c3...)                     │
│ [10:00:05] ✓ Alice joined (planner)                                  │
│ [10:00:10] ✓ Jerry joined (builder)                                  │
│ [10:01:00] 📋 Chain chain-001 created: 用户认证模块 (5 tasks)         │
│ [10:01:05] 📨 Alice ← Plan task task-001 assigned                    │
│ [10:05:30] 📨 Alice → Leader: task-001 completed, result: ...        │
│ [10:05:40] ✅ task-001 passed. Activating Build tasks.               │
│ [10:05:45] 📨 Jerry ← Build task task-002 assigned                   │
└──────────────────────────────────────────────────────────────────────┘

┌─ Input ──────────────────────────────────────────────────────────────┐
│ > 实现用户登录功能█                                                    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘

Leader: Tom | Instance: a1b2c3... | CACHE_DIR: .../sessions/a1b2c3.../ | Ctrl+C to stop
```

### 7.2 键盘输入

TUI 支持键盘输入，用户可在输入框中直接输入文本，按 Enter 发送给 Leader：

| 按键 | 功能 |
|------|------|
| 可打印字符 | 追加到输入缓冲区 |
| Enter | 发送消息到 Leader（创建 ZK 消息到自身消息队列，经 LeaderWatcher 分流至 TaskGenerator 拆解为任务链） |
| Backspace | 删除最后一个字符 |
| Escape | 清空输入缓冲区 |

输入框空闲时显示提示文字 "Type a message and press Enter to send"。

### 7.3 更新策略

TUI 由 EventBus 事件驱动，在以下时机重绘：

| 事件 | 重绘区域 |
|------|---------|
| `worker_joined` / `worker_left` / `worker_status_changed` | Team Panel |
| `task_created` / `task_claimed` / `task_completed` | Task Panels |
| `message_received` / `message_processed` | Event Log |
| 任何事件 / 键盘输入 | Footer + Input Panel |

### 7.4 日志前缀

系统使用统一日志前缀标识不同来源的输出：

| 前缀 | 含义 | 示例 |
|------|------|------|
| `[Exec]` | Shell 命令执行 | `[Exec] claude -p '实现登录功能...' \| tee -a '/path/to/log'` |
| `[Watcher]` | 消息接收与处理 | `[Watcher] [17:08:57] Message from Alice (direct): task-001 completed` |

## 8. 孤儿任务回收

Leader 检测到 Worker 断线时，回收其 claimed 任务：

```
Worker 断线
  → /instances/{id} EPHEMERAL 节点删除（ZK session timeout）
  → Leader Worker Monitor 触发 worker_left 事件
  →
  ├─ 扫描 /tasks/claimed/{id}-*
  │   对每个孤儿任务:
  │     - 保留: title, description, link, priority, chain_id
  │     - status = "pending"
  │     - retry_count += 1
  │     - 若 retry_count > 3 → 标记为 failed，通知 Leader
  │     - 否则 → 重新写入 /tasks/pending
  │
  └─ TUI 事件: ↻ task-xxx 重新入队（{worker_name} 断线）
```
