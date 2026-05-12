---
name: task-execution
description: Guided task execution for the Builder role. Use when the Builder claims a task from the orchestrator queue and needs to execute it — reading the blueprint, making code changes, running verification, and reporting results with full traceability from every code change back to the Plan. Triggers on keywords like "执行任务", "开始构建", "claim task", "build", "implement", "开发", "写代码", or when a Builder has claimed a task and is ready to work. Complements task-traceability as the foundational traceability layer.
---

# Task Execution

> 执行不是凭感觉写代码，是理解蓝图 → 精准实现 → 自证正确 → 记录可追溯的完整闭环。本技能与 [[task-traceability]] 协作，确保 Builder 的每次执行产出可被 Verifier 独立验证，每个代码变更都可追溯到具体的 Plan 要求。

---

## 何时触发

- Worker 通过 `claude-orchestrator claim-task` 认领了 build 类型的任务
- 用户说"开始执行"、"开始构建"、"implement this task"
- Leader 直接分配了 build 任务给 Builder
- 任务蓝图中标记为 build 的项需要开工

---

## 执行六步法

按顺序执行，每一步通过才进入下一步。

### 1. 认领任务并获取上下文

```bash
# 认领任务
claude-orchestrator claim-task

# 获取蓝图
claude-orchestrator get-context --key plan-<目标slug>
```

从任务和蓝图中提取：
- 本任务的验收标准（具体到命令和文件路径）
- 前序依赖任务的产出物（Plan 的输出、上游 Build 的产出）
- 本任务的预期产出物

如果蓝图不在共享上下文中，通过消息向 Planner 索要。

### 2. 理解执行范围

通读蓝图中的相关部分，确认理解无误：

- 明确"做什么"和"不做什么"——不要在实现中越界
- 识别与上游产出物的接口（API 契约、文件协议等）
- 确认验收标准的可复现性——如果你无法按验收标准自测，验收标准本身有缺陷，反馈给 Planner

如果蓝图有歧义或不清晰 → 通过消息联系 Planner 澄清，不要猜测。

### 3. 执行实现

按照蓝图执行代码变更：

- 只做任务范围内的事，不顺手重构无关代码
- 遵循项目现有的代码规范和架构模式
- 编写必要的测试（如果验收标准要求）
- 产出物（测试报告、截图等）放入约定的输出路径

**与 [[task-traceability]] 协作**：每次代码提交遵循可追溯工作流——自己的名字签名、commit hash 记录回任务文档。

### 4. 自测验证

在报告完成之前，自行运行验收标准中的验证命令：

```bash
# 示例：运行测试
npm test -- <test-pattern> 2>&1

# 示例：检查产出物
ls -la <expected-output-path>
```

如果验收标准中定义了多个检查点，逐项执行并记录结果。所有检查点通过后才进入下一步。

如果某项检查失败但属于外部原因（非本任务引入的问题），在报告中标注为已知问题，不阻塞完成。

### 5. 提交代码

按照 [[task-traceability]] Step 3-5 完成提交链：

```bash
# Step 3: 提交代码（用自己的名字签名）
git add <changed-files>
git commit -m "feat(<scope>): <description>

<details>

<Your Name>"

# Step 4: 记录 commit hash 到任务文档
# Step 5: 提交文档更新
```

关键规则：
- 一个逻辑单元一个 commit，不批量提交不相关的变更
- commit message 末尾签自己的名字
- 记录 commit hash 回任务文档

### 6. 报告完成

标记任务完成并通知：

```bash
claude-orchestrator complete-task \
  --task-id <task-id> \
  --result "完成了 XXX，commit: a1b2c3d。测试全部通过。产出物: <path>"
```

---

## 执行完成检查清单

```
□ 已认领任务并从蓝图获取上下文
□ 已理解执行范围和验收标准
□ 代码变更只在任务范围内，无越界修改
□ 验收标准中的命令自测全部通过
□ 代码已提交，签名为自己的名字 (task-traceability Step 3)
□ commit hash 已记录回任务文档 (task-traceability Step 4)
□ 任务文档更新已提交 (task-traceability Step 5)
□ 已通过 orchestrator complete-task 报告完成
```

---

## 与其他技能的协作

- **[[task-traceability]]**：基础层。Builder 严格遵循追溯 → 执行 → 映射 → 举证 → 记录的五步法。每个代码变更必须追溯至 Plan 的具体要求，映射到实现，附带测试证据，并通过 commit hash 记录回任务文档。
- **[[task-planning]]**：Builder 依赖 Planner 的蓝图和追溯链来理解执行范围。如果蓝图有歧义，反馈给 Planner 澄清。
- **[[task-verification]]**：Verifier 将独立验证 Builder 的产出。Builder 的自测和可追溯记录降低了 Verifier 发现基础问题的概率。

---

## 常见错误

- **不读蓝图直接写代码**：跳过 Step 1-2，凭任务标题猜测需求。结果往往偏离 Planner 的设计意图。
- **越界修改**：顺手"优化"了无关代码。增加了 Reviewer 的审查负担和 Verifier 的验证范围，可能引入新 bug。
- **不跑验收命令就报完成**：验收标准写明了 `npm test -- foo`，但 Builder 没跑就说完成了。Verifier 一跑就挂。
- **跳过自测结果记录**：只完成了代码，但验收标准要求产出截图/测试报告，Builder 没产出。Verifier 无法验证。
- **commit 没签自己的名**：commit hash 记录了但签名用的是别人。追溯链断了——谁做的不可知。
