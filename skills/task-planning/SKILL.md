---
name: task-planning
description: Requirement analysis and task breakdown for the Planner role. Use when the Planner needs to analyze requirements, define task blueprints, break down work into executable tasks with acceptance criteria, establish responsibility chain ordering, and push tasks to the orchestrator queue — all with full traceability from requirements to tasks. Triggers on keywords like "分析需求", "拆解任务", "制定计划", "task planning", "blueprint", "break down", "define tasks", "规划", or when starting a new work cycle that needs tasks created.
---

# Task Planning

> 规划不是猜测，是分析需求 → 定义蓝图 → 拆解可执行任务 → 建立可验证的验收标准。本技能与 [[task-traceability]] 协作，确保每次规划产出清晰、可执行、可追溯——每个任务都可追溯到具体需求。

---

## 何时触发

- Leader 分配新的需求/目标给 Planner
- 用户说"分析一下这个需求"、"拆解任务"、"制定执行计划"
- 新的工作周期开始，需要产出任务列表
- 现有蓝图需要修订或补充

---

## 规划六步法

按顺序执行，每一步通过才进入下一步。任一步产出不清晰 → 回退澄清。

### 1. 读取需求上下文

定位并理解需求来源：

- 如果是 Leader 通过 orchestrator 分配的需求，通过 `claude-orchestrator get-context --key <需求key>` 获取
- 如果是本地文档（如 `docs/pm/YYYY-MM-DD/`），读取完整内容
- 如果是代码库需求（如 Issue、PR 描述），读取相关文档和代码

提取关键信息：
- 业务目标和背景
- 约束条件和边界
- 期望的交付标准和截止时间

### 2. 定义任务蓝图

输出蓝图文档，包含以下要素：

```markdown
# 任务蓝图：[目标名称]

> Planner | YYYY-MM-DD | 版本 v1

## 目标

（一句话描述要达成什么）

## 背景

（为什么需要做这个，解决什么问题）

## 范围与非范围

**范围内：**
- 具体要做的事项 1
- 具体要做的事项 2

**不在范围内：**
- 明确不做的事项 1

## 约束条件

- 技术约束（如必须兼容 Node.js 18+）
- 时间约束
- 依赖约束（如依赖外部服务 X 先就绪）

## 成功定义

（可验证的成功标准，不是抽象描述）
- 标准 1：所有单元测试通过，覆盖率 ≥ X%
- 标准 2：UI 交互流程可在浏览器中完成
- ...
```

### 3. 拆解可执行任务

将蓝图拆解为独立的任务项。每个任务必须满足：

- **可独立执行**：Builder 无需频繁跨任务上下文切换
- **可验证**：有明确的验收标准（测试命令、UI 检查点、文件路径等）
- **有产出物**：代码变更、测试报告、截图、文档等

```markdown
## 任务清单

| # | 任务 | 类型 | 验收标准 | 预估 | 依赖 |
|---|------|------|---------|------|------|
| 1 | 实现 XXX 模块 | build | `npm test -- XXX` 全部通过 | 2h | - |
| 2 | 编写 YYY 集成测试 | build | `npm test -- YYY` 覆盖 3 个场景 | 1h | #1 |
| 3 | 验证 ZZZ 边界情况 | verify | 运行边界测试套件，0 失败 | 0.5h | #2 |
| 4 | 审查整体方案一致性 | review | 审查报告无 P0/P1 问题 | 0.5h | #2, #3 |
| 5 | 验收最终交付物 | accept | 对照验收标准逐项通过 | 0.5h | #4 |
```

任务类型对应责任链环节：`plan` / `build` / `verify` / `review` / `accept`。

依赖字段确保责任链顺序：P → B → V → R → A。

### 4. 推入任务队列

通过 orchestrator 将任务推入队列，指定每个任务的责任链环节：

```bash
# Build 任务
claude-orchestrator push-task \
  --title "实现 XXX 模块" \
  --link build \
  --priority 0

# Verify 任务
claude-orchestrator push-task \
  --title "验证 ZZZ 边界情况" \
  --link verify \
  --priority 1

# Review 任务
claude-orchestrator push-task \
  --title "审查整体方案一致性" \
  --link review \
  --priority 1

# Accept 任务
claude-orchestrator push-task \
  --title "验收最终交付物" \
  --link accept \
  --priority 1
```

优先级建议：`plan` 和下游瓶颈任务用 `0`（HIGH），其余用 `1`（MEDIUM）。

### 5. 建立验收标准可追溯

每个任务的验收标准必须具体到可独立复现。拒绝模糊描述：

| 模糊（拒绝） | 具体（通过） |
|-------------|------------|
| "功能正常" | `npm test -- auth` 全部通过，覆盖登录/登出/超时 3 个场景 |
| "UI 没问题" | 截图 `screenshots/login-flow.png` 展示登录→首页完整流程 |
| "性能合格" | `ab -n 1000 -c 10 /api/users` p95 < 200ms |
| "代码质量好" | `npx eslint src/auth/` 0 errors, 0 warnings |

### 6. 记录蓝图并通知 Leader

将蓝图文档存入共享上下文，通知 Leader 蓝图就绪：

```bash
# 存为共享上下文
claude-orchestrator set-context --key plan-<目标slug> --value "$(cat docs/plans/<目标slug>.md)"

# 通知 Leader
claude-orchestrator send-message --broadcast --content "蓝图 <目标slug> 已就绪，任务已推入队列，共 N 个任务。"
```

---

## 蓝图完整性检查清单

```
□ 目标描述一句话清晰
□ 范围和边界明确（不做的比要做的更重要）
□ 每项任务可独立执行
□ 每项任务有具体验收标准（不是模糊描述）
□ 依赖链完整（P→B→V→R→A 无断点）
□ 所有任务已推入 orchestrator 队列
□ 蓝图文档已存入共享上下文
□ Leader 已收到蓝图就绪通知
```

---

## 与其他技能的协作

- **[[task-traceability]]**：基础层。Planner 的每一步都需要可追溯：需求 → 蓝图 → 任务清单 → 验收标准。Plan 是责任链的起点，如果 Plan 的追溯链断裂，Builder 不知道做什么，Verifier 不知道验什么，Reviewer 不知道审什么。
- **[[task-execution]]**：Builder 依赖 Planner 的蓝图和追溯链来理解执行范围。
- **[[task-verification]]**：Verifier 以 Planner 蓝图的验收标准为验证基准。
- **[[task-review]]**：Reviewer 以 Planner 蓝图为审查标准。

---

## 常见错误

- **任务拆得太粗**：一个任务包含多个独立模块，Builder 无法一次完成。拆到一个人能在 2-4 小时内完成为宜。
- **验收标准是废话**：写"功能正常"等于没写。必须写具体的测试命令、文件路径、预期输出。
- **跳过依赖声明**：没有依赖链，责任链流转就断了。每个非 Plan 任务必须声明它依赖什么产出物。
- **蓝图没有存共享上下文**：其他 Worker 看不到蓝图就无法理解自己在做什么。蓝图必须是团队可见的。
