# Skills for Multi-Agent Orchestration

Skills 是按责任链角色设计的标准化工作流。每个 skill 对应一个责任链角色，定义明确的输入、步骤、和产出。Skills 之间通过交叉引用形成闭环协作。

---

## 责任链与 Skill 映射

```
Leader (协调层)
  └── claude-orchestrator: 实例注册、任务分发、消息传递、上下文共享

责任链: Plan → Build → Verify → Review → Accept
         │        │        │         │         │
         ▼        ▼        ▼         ▼         ▼
      task-    task-    task-     task-     task-
     planning execution verification review  acceptance

跨角色横切:
  task-traceability: 代码变更 → commit → 记录 hash → 文档更新 (主要用于 Builder，所有改代码的角色适用)
```

| 角色 | Skill | 输入 | 产出 |
|------|-------|------|------|
| **Leader** | `claude-orchestrator` | 需求/目标 | 任务在队列中，Worker 在工作 |
| **Planner** | `task-planning` | 需求上下文 | 蓝图文档 + 任务队列 |
| **Builder** | `task-execution` + `task-traceability` | 蓝图 + 任务 | 代码 commit + 可追溯记录 |
| **Verifier** | `task-verification` | 蓝图 + Builder 产出 | 验证报告 |
| **Reviewer** | `task-review` | 蓝图 + Build 代码 + Verify 报告 | 审查报告 (Pass/Revise) |
| **Accepter** | `task-acceptance` | 全链产出 + 验收标准 | 验收报告 (Go/No-Go) |

---

## 各 Skill 详述

### claude-orchestrator

Multi-agent orchestration CLI backed by ZooKeeper。所有角色都使用它来完成基础设施操作：注册实例、认领任务、发送消息、读写共享上下文。

- **入口**: `claude-orchestrator <command>`
- **关键命令**: `register`, `claim-task`, `complete-task`, `push-task`, `send-message`, `set-context`, `get-context`
- **适用角色**: 所有角色

### task-planning

Planner 将需求分析拆解为可执行任务蓝图的标准化工作流。

- **触发**: "分析需求"、"拆解任务"、"制定计划"
- **六步法**: 读取需求 → 定义蓝图 → 拆解任务 → 推入队列 → 建立验收标准 → 通知 Leader
- **产出**: 蓝图文档 + orchestrator 任务队列中的任务
- **依赖**: 需求上下文（Leader 提供或文档来源）

### task-execution

Builder 认领任务后精准执行的工作流。

- **触发**: "执行任务"、"开始构建"、claim build 类型任务后
- **六步法**: 认领并获取上下文 → 理解范围 → 执行实现 → 自测验证 → 提交代码 → 报告完成
- **产出**: 代码 commit + 可追溯记录 (commit hash → 任务文档)
- **协作 skill**: `task-traceability` (提交规范)
- **依赖**: Planner 的蓝图

### task-verification

Verifier 对照蓝图独立验证 Builder 产出的工作流。

- **触发**: "验证任务"、"verify"、claim verify 类型任务后
- **六步法**: 认领并读蓝图 → 收集产出物 → 逐项验证 → 边缘检查 → 判定偏离 → 产出报告
- **产出**: 验证报告（通过/不通过 + 问题清单）
- **依赖**: Planner 的蓝图 + Builder 的代码 commit

### task-review

Reviewer 从设计意图高度审查全链产出的工作流。

- **触发**: "审查"、"review"、"code review"、claim review 类型任务后
- **六步法**: 收集全链信息 → 审查设计一致性 → 审查验证报告 → 判定问题等级 → 书写报告 → 通知流转
- **产出**: 审查报告（Pass/Revise + P0-P3 问题清单）
- **依赖**: Plan 蓝图 + Build 代码 + Verify 报告

### task-acceptance

Accepter 从业务需求角度验收最终交付物的工作流。

- **触发**: "确认并验收"、"验收一下"、"检查完成情况"
- **八步法**: 参见 `skills/task-acceptance/SKILL.md`
- **产出**: 验收报告（Go/No-Go + 问题清单）
- **依赖**: 全链产出（Plan → Build → Verify → Review）+ 业务验收标准

### task-traceability

跨角色横切工作流：确保每次代码变更都有完整的追溯链（代码 → commit hash → 任务文档 → 文档 commit）。

- **触发**: 任何涉及代码变更的任务执行
- **五步法**: 读任务文档 → 执行 → 提交代码 → 更新文档记录 hash → 提交文档
- **主要适用**: Builder（Verifier 和 Reviewer 在需要改代码时也适用）

---

## Skill 间协作关系

```
task-planning (Planner)
    │
    │ 蓝图 + 验收标准
    ▼
task-execution + task-traceability (Builder)
    │
    │ 代码 commit + 可追溯记录
    ▼
task-verification (Verifier)
    │
    │ 验证报告 + 问题清单
    ▼
task-review (Reviewer)
    │
    │ 审查报告 (Pass/Revise)
    ▼
task-acceptance (Accepter)
    │
    │ 验收报告 (Go/No-Go)
    ▼
  闭环
```

每个环节发现问题可向前反馈至对应环节。例如：
- Verifier 发现偏离 → 反馈 Builder
- Reviewer 发现设计意图未实现 → 反馈 Planner 和 Builder
- Accepter 发现验收不通过 → 反馈至对应环节的负责人

所有角色通过 `claude-orchestrator` 的消息和共享上下文进行跨角色沟通。

---

## 角色预设权重与 Skill 选择

Worker 注册时的 role 是预设权重，认领任务后才确定当前角色和对应的 skill：

| 注册 role | 预设匹配的任务 link | 认领后使用的 skill |
|-----------|-------------------|-------------------|
| `planner` | `plan` | `task-planning` |
| `builder` | `build` | `task-execution` + `task-traceability` |
| `verifier` | `verify` | `task-verification` |
| `reviewer` | `review` | `task-review` |
| `accepter` | `accept` | `task-acceptance` |

任意 Worker 可认领任意环节的任务。认领后以任务所属环节的角色身份执行，使用对应的 skill。

---

## 快速索引

| 我想做... | 使用 skill |
|-----------|-----------|
| 分析需求，拆解成任务 | `task-planning` |
| 认领并执行一个开发任务 | `task-execution` |
| 提交代码并保持可追溯 | `task-traceability` |
| 验证 Builder 的产出是否合格 | `task-verification` |
| 审查代码质量和设计一致性 | `task-review` |
| 验收最终交付物，签 Go/No-Go | `task-acceptance` |
| 注册实例、收发消息、管理任务 | `claude-orchestrator` |
