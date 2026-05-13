# 角色体系设计

## 1. 责任链模型

任何一个需求都需要经过完整的责任链：**Plan → Build → Verify → Review → Accept**。这不是技能分工，而是责任分工。每个 Worker 都可以在责任链的任意环节工作——注册时分配的角色仅是一个**预设权重**，表示"我倾向于承担哪个环节的职责"。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  Leader                                       │
│  职责: 任务拆解、责任链协调、负载感知、Worker 调度                              │
│  不直接执行任务，只做协调与决策                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  Planner    │   │  Builder    │   │  Verifier   │   │  Reviewer   │   │  Accepter   │
│             │   │             │   │             │   │             │   │             │
│ 把握整体方向 │   │ 执行具体任务 │   │ 验证执行结果 │   │ 审查产出是否 │   │ 业务需求验收 │
│ 定义任务蓝图 │   │ 按蓝图落地   │   │ 发现偏离     │   │ 符合设计意图 │   │ 签署 Go/No-Go│
│ 拆解执行路径 │   │             │   │             │   │             │   │             │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │                 │                 │
       └─────────────────┴─────────────────┴─────────────────┴─────────────────┘
                                    │
                       责任链流转方向: P → B → V → R → A
                       任一环节发现问题均可向前反馈
```

## 2. 角色定义

| 角色 | 标识 | 责任链位置 | 核心职责 |
|------|------|-----------|---------|
| **Leader** | `leader` | 协调者（不在链中） | 接收需求→拆解任务链→感知各环节负载→调度 Worker→跟踪闭环 |
| **Planner** | `planner` | 链首：定义 | 把握整体方向，定义任务蓝图和目标，拆解出清晰的执行路径 |
| **Builder** | `builder` | 链中：执行 | 按照 Planner 定义的蓝图执行任务，产出可验证的结果 |
| **Verifier** | `verifier` | 链中：验证 | 验证 Builder 的产出，发现与蓝图的偏离，反馈问题 |
| **Reviewer** | `reviewer` | 链中：审查 | 审查 Builder + Verifier 的产出是否符合 Planner 的设计意图 |
| **Accepter** | `accepter` | 链尾：验收 | 从业务需求角度验收最终交付物，签署 Go/No-Go |

**责任链解读**：

- **Planner** 回答"要做什么、为什么做、怎么做"——输出蓝图
- **Builder** 回答"做出来"——按蓝图产出结果
- **Verifier** 回答"做得对不对"——验证结果与蓝图的一致性
- **Reviewer** 回答"该不该通过"——从设计意图的高度判断产出是否合格
- **Accepter** 回答"能不能交付"——从业务需求角度验收最终交付物

## 3. 关键设计：角色是权重，不是身份

**Worker 的角色不是固定身份，而是任务认领的预设权重。**

核心规则：

1. **注册时的 role 只是预设权重**：Worker 注册时携带 `role`，表示该 Worker 倾向于认领该环节的任务。任何 Worker 都能认领任意环节的任务。

2. **认领任务后才确定当前角色**：Worker 的当前角色由认领的任务所属 link 决定。认领了 `plan` link，当前就是 Planner；认领了 `verify` link，当前就是 Verifier。

3. **空闲 Worker 可认领任意环节的任务**：当某一环节积压，即使预设 role 不匹配，也可以跨环节协助。

4. **认领权重规则**：[`TaskQueue.claim()`](../../src/modules/task-queue.ts) 按复合键排序候选 pending 任务：
   1. 显式 `assigned_to` 匹配当前实例 → 最高优先
   2. `link` 匹配实例 `role` → 次优（planner→plan、builder→build 等）
   3. `priority` 数值越小越优先（HIGH=0、MEDIUM=1、LOW=2）
   4. 任务 ID FIFO

```
示例:
  Tom 注册 role=planner
  Jerry 注册 role=builder
  Lucy 注册 role=verifier
  Bob 注册 role=reviewer (此场景不存在；v0.5 全自动分配)

场景: Plan 环节任务为 0，Build 环节任务堆积 5 个，Verify 环节 1 个

  Tom（预设 planner，当前空闲）→ 可认领 Build 任务，TUI 显示 Current Role 为 Builder
  Lucy（预设 verifier，当前空闲）→ 可认领 Build 任务，TUI 显示 Current Role 为 Builder
  Jerry（预设 builder）→ 认领 Build 任务，权重最高（role-link 匹配）
```

## 4. 名称-角色解耦

名称与角色是**独立分配**的两个维度：

- **名称**是身份标识，来自 [内置名称池](#41-内置名称池) 或 claude-cli 生成
- **角色**是权重偏好，按 [角色优先级](#42-角色优先级) 分配
- 二者绑定关系在首次启动时持久化到根 `config.json` 的 `worktree` 段落

### 4.1 内置名称池

`templates/agents/` 的 `WorktreeInitializer` 内置 20 个拟人化名称：

```typescript
const BUILTIN_NAMES = [
  "Tom", "Jerry", "Lucy", "Thomas", "Jack", "Lisa",
  "Alice", "Bob", "Charlie", "Diana", "Edward", "Fiona",
  "George", "Helen", "Ivan", "Julia", "Kevin", "Linda",
  "Mike", "Nancy",
];
```

当 `workerCount > 20` 时，超出部分由 claude-cli 生成补充。详见 [`worktree-and-identity.md`](worktree-and-identity.md) §2。

### 4.2 角色优先级

```typescript
const ROLE_PRIORITY = ["planner", "builder", "verifier", "reviewer", "accepter"];
```

按 Worker 数量分配：

| Worker 数 | 分配 | 名称 |
|-----------|------|------|
| 1 | builder | Tom |
| 2 | planner, builder | Tom, Jerry |
| 3 | planner, builder, verifier | Tom, Jerry, Lucy |
| 4 | planner, builder, verifier, reviewer | Tom, Jerry, Lucy, Thomas |
| 5 | planner, builder, verifier, reviewer, accepter | Tom, Jerry, Lucy, Thomas, Jack |
| 6 | + builder | + Lisa |
| 7+ | 超出 5 后优先扩充 builder | + Alice / Bob / ... |

## 5. 责任链流转

```
任务进入
    │
    ▼
┌─────────┐     ┌──────────┐     ┌─────────┐     ┌──────────┐     ┌──────────┐
│  Plan   │ ──▶ │  Build   │ ──▶ │ Verify  │ ──▶ │  Review  │ ──▶ │  Accept  │ ──▶ 闭环
│         │     │          │     │         │     │          │     │          │
│Planner  │     │Builder   │     │Verifier │     │Reviewer  │     │Accepter  │
└─────────┘     └──────────┘     └─────────┘     └──────────┘     └──────────┘
     │               │                │               │                │
     └───────────────┴────────────────┴───────────────┴────────────────┘
           任一环节发现问题均可向前反馈至对应环节
```

每个环节的产出和进入下一环节的条件：

| 环节 | 产出 | 进入下一环节条件 |
|------|------|----------------|
| Plan | 蓝图文档、任务规格、目标定义 | 蓝图清晰，Builder 理解无歧义 |
| Build | 实现结果、commit hash | 产出可被验证 |
| Verify | 验证报告、问题清单 | 关键问题已修复或记录 |
| Review | 审查结论 (Pass/Revise) | 质量问题已解决，交付物可供验收 |
| Accept | 验收报告、Go/No-Go 结论 | Go 则闭环完成；No-Go 则反馈至对应环节 |

链条流转由 Worker `SelfEvaluator` 输出 EvalDecision JSON，Leader `ChainRouter` 解析后机械执行 `activate_next` / `feedback` / `reject` / `close_chain`，不再二次评估。详见 [`leader-design.md`](leader-design.md) §5、[`worker-design.md`](worker-design.md) §5。

## 6. Worker 注册与认领

### 6.1 注册流程

Worker 注册由 `run` 命令在 Phase 4 自动完成，不再有独立的 `register` CLI 子命令：

```
run --worker 5
  └─ Phase 2: WorktreeInitializer 分配 name + role + worktree + instance_id
  └─ Phase 4: fork N 个子进程，每个子进程:
        ├─ chdir(worktreePath)
        ├─ ZkClient.connect()
        ├─ InstanceRegistry.register({
        │     id: instance_id,
        │     name, role,
        │     status: "idle",
        │     work_dir: worktreePath,
        │     worktree_name, worktree_path, worktree_branch, pid,
        │   })
        └─ /instances/{instance_id} EPHEMERAL 节点创建
```

`instance_id` 在 worktree 创建时预生成并保存到 `<worktree>/.claude-orchestrator/config.json`，重启时复用，保证 worktree-instance 映射稳定。

### 6.2 TUI 团队面板

```
┌─ TEAM ────────────────────────────────────────────────────────────────────┐
│   Name    Preset    Current Role    Worktree  Branch                  PID │
│ > Tom     planner   Planner         Tom       claude-or…om-workspace  48291│
│   Jerry   builder   Builder         Jerry     claude-or…ry-workspace  48292│
│   Lucy    verifier  Builder ◀←      Lucy      claude-or…cy-workspace  48293│
│   Thomas  reviewer  (idle)          Thomas    claude-or…s-workspace   48294│
│   Jack    accepter  (idle)          Jack      claude-or…k-workspace   48295│
└──────────────────────────────────────────────────────────────────────────┘

`>`         当前选中的 Worker（Tab 切换）
Preset       注册时分配的预设 role（权重偏好）
Current Role 当前认领任务的 link 决定，(idle) 表示空闲
◀←           当前角色与预设角色不同，表示跨环节协助
Worktree     git worktree 目录名（即 Worker 名）
Branch       git 分支名（自动截断显示）
PID          子进程 PID
```

### 6.3 认领权重逻辑

详见 [§3](#3-关键设计角色是权重不是身份)。核心一句话：**预设 role 决定优先级，不决定能力**。

## 7. 数据模型

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
  work_dir: string | null;
  // worktree 信息
  worktree_name: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  pid: number | null;
}
```

### TaskLink

```typescript
type TaskLink = "plan" | "build" | "verify" | "review" | "accept";
```

### Task（角色相关字段）

```typescript
interface Task {
  // ... 其他字段见 zookeeper-schema.md §2
  link: TaskLink;              // 所属责任链环节
  chain_id: string | null;     // 同一需求的链 ID，null 表示独立任务
  depends_on: string[];        // 依赖的上游任务 ID 列表
  blocked_by: string[];        // 当前阻塞该任务的任务 ID
}
```

完整 Task / Message schema 见 [`zookeeper-schema.md`](zookeeper-schema.md) §2 和 [src/models/schemas.ts](../../src/models/schemas.ts)。

## 8. 与其他文档的边界

| 关注点 | 所属文档 |
|--------|---------|
| 责任链模型、角色定义、认领权重 | `role-design.md`（本文档） |
| 名称-角色解耦、Instance schema | `role-design.md` |
| 名称分配算法、内置名称池、claude-cli 生成 | [`worktree-and-identity.md`](worktree-and-identity.md) §2 |
| git worktree 隔离、身份注入、Directory Memory | [`worktree-and-identity.md`](worktree-and-identity.md) |
| Leader 工作流程、ChainRouter 路由 | [`leader-design.md`](leader-design.md) |
| Worker 执行管线、五 link 模板 | [`worker-design.md`](worker-design.md) |
| run 命令五阶段编排 | [`orchestration.md`](orchestration.md) |
| ZK 节点树、Watch 策略 | [`zookeeper-schema.md`](zookeeper-schema.md) |
| TUI 设计、键盘交互 | [`leader-design.md`](leader-design.md) §3 |
