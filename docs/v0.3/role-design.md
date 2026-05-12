# v0.3.0 角色体系设计

## 1. 责任链模型

任何一个任务都需要经过完整的责任链：**Plan → Build → Verify → Review → Accept。** 这不是技能分工，而是责任分工。每个人都可以在责任链的任意节点上工作——注册时的角色只是一个预设权重，表示"我倾向于承担哪个环节的职责"。

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                    Leader                                             │
│  职责: 任务拆解、责任链协调、负载感知、Worker 调度                                       │
│  不直接执行任务，只做协调和决策                                                         │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┬───────────────────┐
          ▼                           ▼                           ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   Planner     │   │   Builder     │   │   Verifier    │   │   Reviewer    │   │   Accepter    │
│               │   │               │   │               │   │               │   │               │
│ 把握整体方向   │   │ 执行具体任务   │   │ 验证执行结果   │   │ 审查产出是否   │   │ 从业务需求角度 │
│ 定义任务蓝图   │   │ 按蓝图落地     │   │ 发现偏离      │   │ 符合设计意图   │   │ 验收最终交付物 │
│ 拆解执行路径   │   │               │   │               │   │               │   │ 签署 Go/No-Go │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │                   │                   │
        └───────────────────┴───────────────────┴───────────────────┴───────────────────┘
                                      │
                         责任链流转方向: P → B → V → R → A
                         每个环节可向前反馈纠正
```

## 2. 角色定义

| 角色 | 标识 | 责任链位置 | 核心职责 |
|------|------|-----------|---------|
| **Leader** | `leader` | 协调者（不在链中） | 接收需求→拆解为责任链任务→感知各环节负载→调度 Worker→跟踪闭环 |
| **Planner** | `planner` | 链首：定义 | 把握整体方向，定义任务蓝图和目标，拆解出清晰的执行路径 |
| **Builder** | `builder` | 链中：执行 | 按照 Planner 定义的蓝图执行任务，产出可验证的结果 |
| **Verifier** | `verifier` | 链中：验证 | 验证 Builder 的产出，发现与蓝图的偏离，反馈问题 |
| **Reviewer** | `reviewer` | 链中：审查 | 审查 Builder 和 Verifier 的产出是否符合 Planner 的设计意图，进行质量把关 |
| **Accepter** | `accepter` | 链尾：验收 | 从业务需求角度验收最终交付物，对照验收标准逐项核实，签署 Go/No-Go |

**责任链解读**：
- **Planner** 回答"要做什么、为什么做、怎么做"——输出蓝图
- **Builder** 回答"做出来"——按蓝图产出结果
- **Verifier** 回答"做得对不对"——验证结果与蓝图的一致性
- **Reviewer** 回答"该不该通过"——从设计意图的高度判断产出是否合格
- **Accepter** 回答"能不能交付"——从业务需求角度验收最终交付物，做出最终的 Go/No-Go 决策

## 3. 关键设计：角色是权重，不是身份

**Worker 的角色不是固定身份，而是任务认领的预设权重。**

核心规则：

1. **注册时的 role 只是预设权重**：Worker 注册时标注 `--role builder`，表示该 Worker 倾向于认领 Build 环节的任务。任何 Worker 都能认领任意环节的任务。

2. **认领任务后才确定当前角色**：Worker 的角色由当前认领的任务所处环节决定。认领了 Plan 环节的任务，当前就是 Planner；认领了 Verify 环节的任务，当前就是 Verifier。

3. **空闲 Worker 可认领任意环节的任务**：当某一环节的任务积压，即使 Worker 的预设 role 不匹配，也可以认领该环节的任务来协助疏解。

4. **认领权重规则**：Worker 认领任务时，预设 role 匹配的任务优先级更高（权重更大），但不匹配的任务依然可以认领。具体表现为：
   - 预设 role 匹配 → 优先展示、优先推送
   - 预设 role 不匹配但空闲 → 可以认领，TUI 中显示当前承担的角色

```
示例：
  Alice 注册 role=planner
  Jerry 注册 role=builder
  Lucy  注册 role=verifier
  Bob   注册 role=accepter

  场景：Plan 环节任务为 0，Build 环节任务堆积了 5 个，Verify 环节 1 个

  Alice（预设 planner，当前空闲）→ 可以认领 Build 任务，TUI 显示当前角色为 Builder
  Lucy（预设 verifier，当前空闲）  → 可以认领 Build 任务，TUI 显示当前角色为 Builder
  Jerry（预设 builder）         → 认领 Build 任务，权重最高，优先分配
  Bob（预设 accepter，当前空闲）  → 可以认领 Build 任务协助疏解，TUI 显示当前角色为 Builder
```

## 4. 责任链流转

```
任务进入
    │
    ▼
┌─────────┐     ┌──────────┐     ┌─────────┐     ┌──────────┐     ┌──────────┐
│  Plan   │ ──▶ │  Build   │ ──▶ │ Verify   │ ──▶ │  Review  │ ──▶ │  Accept  │ ──▶ 闭环完成
│         │     │          │     │         │     │          │     │          │
│Planner  │     │Builder   │     │Verifier │     │Reviewer  │     │Accepter  │
│ 定义蓝图 │     │ 按图执行  │     │ 验证结果 │     │ 审查合规  │     │ 验收交付  │
└─────────┘     └──────────┘     └─────────┘     └──────────┘     └──────────┘
     │               │                │               │                │
     └───────────────┴────────────────┴───────────────┴────────────────┘
           任一环节发现问题均可向前反馈至对应环节
```

每个环节的产出和进入下一环节的条件：
- **Plan** → 产出：蓝图文档、任务规格、目标定义 → 进入 Build 条件：蓝图清晰，Builder 理解无歧义
- **Build** → 产出：执行结果 → 进入 Verify 条件：产出可被验证
- **Verify** → 产出：验证报告、问题清单 → 进入 Review 条件：关键问题已修复或记录
- **Review** → 产出：审查结论 → 进入 Accept 条件：质量问题已解决，交付物可供验收
- **Accept** → 产出：验收报告、Go/No-Go 结论 → Go 则闭环完成，No-Go 则反馈至对应环节

## 5. Worker 注册与认领

### 5.1 注册命令

```bash
# 注册为 Builder（预设权重：倾向于认领 Build 环节任务）
claude-orchestrator register --name Jerry --role builder --work-dir ~/project

# 注册为 Planner
claude-orchestrator register --name Alice --role planner --work-dir ~/project

# 注册为 Verifier
claude-orchestrator register --name Lucy --role verifier --work-dir ~/project

# 注册为 Reviewer
claude-orchestrator register --name Bob --role reviewer --work-dir ~/project

# 注册为 Accepter
claude-orchestrator register --name Eve --role accepter --work-dir ~/project
```

`--role` 仅作为认领任务时的权重偏好。任意 Worker 可认领任意环节的任务。

### 5.2 TUI 团队面板

```
┌─ Team: 5 workers ────────────────────────────────────────────────────┐
│ Name    Preset      Current Role   Status   Current Task              │
│ Alice   planner     Planner        busy     task-001 (Plan)           │
│ Jerry   builder     Builder        busy     task-002 (Build)          │
│ Lucy    verifier    Builder ◀←     busy     task-004 (Build)          │
│ Bob     reviewer    (idle)         idle     -                         │
│ Eve     accepter    (idle)         idle     -                         │
└───────────────────────────────────────────────────────────────────────┘

Preset:      注册时的预设 role（权重偏好）
Current Role: 由当前认领的任务所处环节决定，(idle) 表示未认领任务
◀←:          当前角色与预设角色不同，表示跨环节协助
```

### 5.3 认领权重逻辑

Worker 认领任务时，系统按以下规则排序候选任务：

1. **权重匹配优先**：任务环节与 Worker 预设 role 匹配的任务排在前面
2. **空闲可认领任意任务**：当没有匹配的待处理任务时，Worker 可以认领任意环节的任务
3. **Leader 可显式指定**：Leader 可以通过 `push_task --assignee <name>` 直接分配任务给指定 Worker，绕过权重匹配

## 6. 数据模型

### Instance

```typescript
interface Instance {
  id: string;
  name: string;
  role: "planner" | "builder" | "verifier" | "reviewer" | "accepter" | "leader";
  // role 语义: 预设权重偏好，不代表当前实际角色
  // 当前实际角色由认领的任务所属 link 决定
  status: "idle" | "busy";
  current_task_id: string | null;
  connected_since: string;
  work_dir: string;
}
```

### TaskLink

```typescript
type TaskLink = "plan" | "build" | "verify" | "review" | "accept";
```

### Task（角色相关字段）

```typescript
interface Task {
  // ... 其他字段
  link: TaskLink;              // 所属责任链环节
  chain_id: string | null;     // 同一需求的链 ID，null 表示独立任务
  depends_on: string[];        // 依赖的上游任务 ID 列表
  blocked_by: string[];        // 当前阻塞该任务的任务 ID
}
```

## 7. 与 Leader/Worker 设计的边界

| 关注点 | 所属文档 |
|--------|---------|
| 角色定义、责任链模型 | `role-design.md`（本文档） |
| Worker 注册与认领权重 | `role-design.md`（本文档） |
| Instance 数据模型 | `role-design.md`（本文档） |
| Leader 工作流程、事件循环 | `leader-design.md` |
| Claude 任务生成管线 | `leader-design.md` |
| 任务优先级与调度 | `leader-design.md` |
| leader-decompose.md / leader-decide.md 提示词 | `leader-design.md` |
| Worker 执行流程与模板 | `worker-design.md` |
| Task 完整数据模型 | `README.md` |
| TUI 设计 | `leader-design.md` |
