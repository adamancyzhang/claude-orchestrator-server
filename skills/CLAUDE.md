# Skills for Multi-Agent Orchestration

Skills 是按责任链角色设计的标准化工作流。每个 skill 对应一个责任链角色,定义明确的输入、步骤、和产出。Skills 之间通过交叉引用形成闭环协作。

---

## 责任链与 Skill 映射

```
Leader (协调层)
  └── claude-orchestrator: 实例注册、任务分发、消息传递、上下文共享

责任链 (默认): Plan → Execute → Verify → Review → Accept
责任链 (--magic): Plan → Execute → Verify → Review → Accept → Explore
                  │        │        │         │         │         │
                  ▼        ▼        ▼         ▼         ▼         ▼
               task-    task-    task-     task-     task-     task-
              planning execution verification review  acceptance exploration

基础层 (所有角色):
  task-traceability: 追溯 → 执行 → 映射 → 举证 → 记录 — 责任链可审计、可交接、可签收的基础
```

| 角色 | Skill | 输入 | 产出 |
|------|-------|------|------|
| **Leader** | `claude-orchestrator` | 需求/目标 | 任务在队列中,Worker 在工作 |
| **Planner** | `task-planning` + `task-traceability` | 需求上下文 | 蓝图文档 + 任务队列 + 可追溯记录 |
| **Executor** | `task-execution` + `task-traceability` | 蓝图 + 任务 | 代码 commit + 可追溯记录 |
| **Verifier** | `task-verification` + `task-traceability` | 蓝图 + Executor 产出 | 验证报告 + 可追溯记录 |
| **Reviewer** | `task-review` + `task-traceability` | 蓝图 + Execute 代码 + Verify 报告 | 审查报告 (Pass/Revise) + 可追溯记录 |
| **Accepter** | `task-acceptance` + `task-traceability` | 全链产出 + 验收标准 | 验收报告 (Go/No-Go) + 可追溯记录 |
| **Explorer** (v0.7 NEW, `--magic` only) | `task-exploration` + `task-traceability` | 全链产出 + 父链摘要 | spawn_chain (含 next_requirement) 或 close_chain |

---

## 各 Skill 详述

### claude-orchestrator

Multi-agent orchestration CLI backed by ZooKeeper。所有角色都使用它来完成基础设施操作:注册实例、认领任务、发送消息、读写共享上下文。

- **入口**: `claude-orchestrator <command>`
- **关键命令**: `register`, `claim-task`, `complete-task`, `push-task`, `send-message`
- **适用角色**: 所有角色

### task-planning

Planner 将需求分析拆解为可执行任务蓝图的标准化工作流。

- **触发**: "分析需求"、"拆解任务"、"制定计划"
- **六步法**: 读取需求 → 定义蓝图 → 拆解任务 → 推入队列 → 建立验收标准 → 通知 Leader
- **产出**: 蓝图文档 + orchestrator 任务队列中的任务
- **依赖**: 需求上下文(Leader 提供或文档来源)

### task-execution

Executor 认领任务后精准执行的工作流。

- **触发**: "执行任务"、"开始构建"、claim execute 类型任务后
- **六步法**: 认领并获取上下文 → 理解范围 → 执行实现 → 自测验证 → 提交代码 → 报告完成
- **产出**: 代码 commit + 可追溯记录 (commit hash → 任务文档)
- **协作 skill**: `task-traceability` (提交规范)
- **依赖**: Planner 的蓝图

### task-verification

Verifier 对照蓝图独立验证 Executor 产出的工作流。

- **触发**: "验证任务"、"verify"、claim verify 类型任务后
- **六步法**: 认领并读蓝图 → 收集产出物 → 逐项验证 → 边缘检查 → 判定偏离 → 产出报告
- **产出**: 验证报告(通过/不通过 + 问题清单)
- **依赖**: Planner 的蓝图 + Executor 的代码 commit

### task-review

Reviewer 从设计意图高度审查全链产出的工作流。

- **触发**: "审查"、"review"、"code review"、claim review 类型任务后
- **六步法**: 收集全链信息 → 审查设计一致性 → 审查验证报告 → 判定问题等级 → 书写报告 → 通知流转
- **产出**: 审查报告(Pass/Revise + P0-P3 问题清单)
- **依赖**: Plan 蓝图 + Execute 代码 + Verify 报告

### task-acceptance

Accepter 从业务需求角度验收最终交付物的工作流。

- **触发**: "确认并验收"、"验收一下"、"检查完成情况"
- **八步法**: 参见 `skills/task-acceptance/SKILL.md`
- **产出**: 验收报告(Go/No-Go + 问题清单)
- **依赖**: 全链产出(Plan → Execute → Verify → Review) + 业务验收标准

### task-exploration (v0.7 NEW, `--magic` only)

Explorer 在 magic 模式下决定是否派生子链的工作流。

- **触发**: 链跑完前五环,处于 explore 链节;`--magic` 模式
- **六步法**: Trace → Survey → Map → Evidence → Record → Decide
- **产出**: `spawn_chain` (含 `next_requirement`) 或 `close_chain` (终止 magic 循环)
- **依赖**: 当前链全产出 + 父链摘要(若有) + `chain_depth` + `magic_max_chains`
- **闸阀**: 当 `chain_depth + 1 >= magic_max_chains`,Leader 会把 spawn_chain 静默降级为 close_chain

### task-traceability

基础层工作流:责任链可审计、可交接、可签收的基石。所有角色都依赖它来建立可追溯记录。

- **触发**: 任何责任链环节的任务执行
- **五步法**: 追溯上游要求 → 按追溯到的要求执行 → 将产出映射回上游要求 → 为每个映射提供证据 → 持久化追溯记录
- **适用**: 所有角色(Plan / Execute / Verify / Review / Accept / Explore)
- **为什么是基础层**: 没有追溯,Plan 的蓝图无法被 Execute 执行,Execute 的产出无法被 Verify 验证,Verify 的报告无法被 Review 采信,Review 的判定无法被 Accept 签收,Accept 的报告无法被 Explorer 总结。任何一个环节的追溯断裂,整个责任链就断了。

---

## Skill 间协作关系

```
┌─────────────────────────────────────────────────────────────┐
│                   task-traceability (基础层)                  │
│   追溯 → 执行 → 映射 → 举证 → 记录 — 每个环节的通用模式        │
└─────────────────────────────────────────────────────────────┘
         │           │            │            │           │           │
         ▼           ▼            ▼            ▼           ▼           ▼
   task-planning  task-execution  task-verification  task-review  task-acceptance  task-exploration
     (Planner)     (Executor)     (Verifier)        (Reviewer)   (Accepter)       (Explorer, --magic)
         │           │            │                 │            │                │
         │ 蓝图+标准  │ 代码+记录   │ 验证报告+问题     │ 审查报告    │ 验收报告        │ spawn/close
         ▼           ▼            ▼                 ▼            ▼                ▼
                    责任链流转: Plan → Execute → Verify → Review → Accept [→ Explore]
```

每个环节发现问题可向前反馈至对应环节。例如:

- Verifier 发现偏离 → 反馈 Executor
- Reviewer 发现设计意图未实现 → 反馈 Planner 和 Executor
- Accepter 发现验收不通过 → 反馈至对应环节的负责人
- Explorer 发现可继续迭代 → 派生子链 (`spawn_chain`),否则终止 magic 循环 (`close_chain`)

`task-traceability` 确保每个环节的产出都有完整的追溯链:谁做的 → 基于什么要求 → 产出是什么 → 证据在哪里 → 记录存在哪里。没有追溯链,反馈就找不到锚点,交接就不可靠,签收就无法审计。

所有角色通过 `claude-orchestrator` 的消息和共享上下文进行跨角色沟通。

---

## 角色预设权重与 Skill 选择

Worker 注册时的 role 是预设权重,认领任务后才确定当前角色和对应的 skill:

| 注册 role | 预设匹配的任务 link | 认领后使用的 skill |
|-----------|-------------------|-------------------|
| `planner` | `plan` | `task-planning` + `task-traceability` |
| `executor` | `execute` | `task-execution` + `task-traceability` |
| `verifier` | `verify` | `task-verification` + `task-traceability` |
| `reviewer` | `review` | `task-review` + `task-traceability` |
| `accepter` | `accept` | `task-acceptance` + `task-traceability` |
| `explorer` (v0.7 NEW) | `explore` | `task-exploration` + `task-traceability` |

任意 Worker 可认领任意环节的任务。认领后以任务所属环节的角色身份执行,使用对应的 skill。

`--magic` 模式只在 `--magic` 启动开关启用时填充第 6 个 worker 为 explorer;默认模式下第 6 个 worker 是 executor。

---

## 快速索引

| 我想做... | 使用 skill |
|-----------|-----------|
| 分析需求,拆解成任务 | `task-planning` + `task-traceability` |
| 认领并执行一个开发任务 | `task-execution` + `task-traceability` |
| 建立可追溯的执行记录 | `task-traceability` |
| 验证 Executor 的产出是否合格 | `task-verification` + `task-traceability` |
| 审查代码质量和设计一致性 | `task-review` + `task-traceability` |
| 验收最终交付物,签 Go/No-Go | `task-acceptance` + `task-traceability` |
| 决定 magic 循环是否继续 (派生子链或终止) | `task-exploration` + `task-traceability` |
| 注册实例、收发消息、管理任务 | `claude-orchestrator` |
