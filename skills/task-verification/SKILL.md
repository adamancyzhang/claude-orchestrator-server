---
name: task-verification
description: Independent verification of Builder output for the Verifier role. Use when the Verifier needs to verify that a Builder's output matches the Planner's blueprint — running tests, checking deliverables, identifying deviations, and producing a verification report with full traceability from every finding back to acceptance criteria. Triggers on keywords like "验证任务", "verify", "check", "测试验证", "排查问题", "验证产出", or when a Builder reports completion and the task enters the Verify stage of the responsibility chain.
---

# Task Verification

> 验证不是跑一遍测试就完了，是对照蓝图逐项核实 Builder 的产出与计划的一致性。本技能与 [[task-traceability]] 协作，确保每次验证独立、客观、可复现、可追溯——每个验证结果都可追溯到具体的验收标准。

---

## 何时触发

- Builder 标记任务完成，责任链流转到 Verify 阶段
- Worker 通过 `claude-orchestrator claim-task` 认领了 verify 类型的任务
- 用户说"验证一下 XXX 的产出"、"检查一下有没有问题"
- 蓝图中有 verify 类型的任务需要开工

---

## 验证六步法

按顺序执行，每一步通过才进入下一步。任一步发现偏离 → 记录问题，最终报告中体现。

### 1. 认领 Verify 任务并读取蓝图

```bash
# 认领验证任务
claude-orchestrator claim-task

# 读取蓝图
claude-orchestrator get-context --key plan-<目标slug>
```

从蓝图中提取：
- 被验证的 Build 任务的验收标准
- 预期的产出物类型和路径
- 上下游依赖（谁依赖这个验证结果）

明确验证范围：只验证蓝图定义的范围内内容。不验证蓝图未定义的东西。

### 2. 收集 Builder 的产出物

定位 Builder 在 `complete_task` 中声明的产出物：

```bash
# 通过 orchestrator 或任务文档找到 Builder 的 commit hash
claude-orchestrator list-tasks --status completed | grep <task-id>

# 查看 Builder 的代码变更
git show <commit-hash> --stat
git diff <commit-hash>^..<commit-hash>
```

确认产出物是否存在且可访问：
- 代码 commit 是否存在且可检出？
- 测试报告/截图文件是否存在？
- Builder 声明的产出物是否都可以独立检查？

如果产出物不存在或不可访问 → 立即记录为 P1 问题，退还给 Builder。

### 3. 逐项对照验证

按照蓝图中的验收标准，逐项独立验证（不依赖 Builder 的自测报告）：

```bash
# 运行蓝图指定的测试命令
npm test -- <test-pattern> 2>&1

# 检查蓝图要求的文件产出
ls -la <expected-output-path>

# 验证代码变更是否匹配任务描述
git show <commit-hash> --name-only
```

对每一项验收标准记录：
- 验收标准原文
- 验证方法和命令
- 实际结果
- 判定（通过 / 偏离 / 未覆盖）

如果某项验收标准无法独立复现（如依赖 Builder 的本地环境），标记为 ⏸ 无法验证，记录原因。

### 4. 检查边缘情况

蓝图定义了 happy path，Verifier 检查边缘情况：

- 异常输入的处理是否正确？
- 边界值是否行为正确？
- 空状态、加载中状态是否处理？
- 与现有功能的兼容性是否被破坏？（回归测试）
- 错误信息是否有意义？

```bash
# 运行全量测试确认无回归
npm test 2>&1 | tail -30
```

### 5. 判断偏离类型

对每个发现的问题进行分类：

| 类型 | 定义 | 处理 |
|------|------|------|
| **偏离** | 产出与蓝图不一致（少做了、做错了、多做了） | 退回 Builder 修复 |
| **遗漏** | 蓝图的验收标准未满足 | 退回 Builder 补齐 |
| **越界** | 做了蓝图范围外的事 | 标记给 Reviewer 判断是否需要回退 |
| **隐患** | 表面上满足验收标准但存在隐蔽问题 | 写入验证报告，提醒 Reviewer 关注 |

### 6. 产出验证报告

写入验证报告文件（如 `docs/verify/<目标slug>-YYYY-MM-DD.md`）：

```markdown
# 验证报告

> Verifier | YYYY-MM-DD | 验证范围：Builder <name> 对 <task> 的产出

## 验证结论

（一句话：通过 / 不通过）

## 验证范围

| Build 任务 | Builder | Commit | 产出物 |
|------------|---------|--------|--------|
| <任务名> | <name> | `hash` | <path> |

## 逐项验证

| # | 验收标准 | 验证方法 | 实际结果 | 判定 |
|---|---------|---------|---------|------|
| 1 | `npm test -- auth` 通过 | 执行 `npm test -- auth` | 5/5 passed | ✅ |
| 2 | 截图 `login-flow.png` 存在 | `ls -la screenshots/` | 文件存在，尺寸 1200x800 | ✅ |
| ... | ... | ... | ... | ... |

## 问题清单

| # | 类型 | 描述 | 影响 |
|---|------|------|------|
| 1 | 遗漏 | 未实现错误重试逻辑（蓝图要求 3 次重试） | 生产环境可能因瞬时故障失败 |

## 回归检查

| 检查项 | 结果 |
|--------|------|
| 全量测试 | 42/42 passed |
| lint | 0 errors, 0 warnings |

---

*Verifier — YYYY-MM-DD*
```

验证报告写入后记录到共享上下文：

```bash
claude-orchestrator set-context \
  --key verify-<目标slug> \
  --value "$(cat docs/verify/<目标slug>-YYYY-MM-DD.md)"
```

---

## 验证完成检查清单

```
□ 已从蓝图获取验收标准
□ Builder 的产出物全部可独立访问
□ 逐项验证了每条验收标准
□ 检查了边缘情况和回归测试
□ 每个问题已分类（偏离/遗漏/越界/隐患）
□ 验证报告已产出并存入共享上下文
□ 如有不通过项，已通过消息通知 Builder 和 Reviewer
```

---

## 与其他技能的协作

- **[[task-traceability]]**：基础层。Verifier 严格遵循追溯 → 执行 → 映射 → 举证 → 记录的五步法。每个验证结果必须追溯到蓝图的验收标准（Trace），逐项独立验证（Execute），映射验证结果到标准（Map），记录命令输出作为证据（Evidence），产出验证报告并存入共享上下文（Record）。
- **[[task-planning]]**：Verifier 以 Planner 的蓝图为标准。蓝图中的验收标准是唯一的判断依据。
- **[[task-execution]]**：Verifier 验证 Builder 的产出。Builder 的自测报告仅供参考，Verifier 独立验证。
- **[[task-review]]**：Reviewer 读取 Verifier 的验证报告来判断是否进入下一环节。Verifier 发现的问题直接进入 Reviewer 的审查视野。

---

## 常见错误

- **只跑 Builder 的测试命令**：Builder 的测试可能在 Builder 的本地环境通过，但 Verifier 的环境不同导致失败。环境差异本身就是有价值的发现。
- **信任 Builder 的自测报告**：Verifier 不独立验证，只是转述 Builder 的报告。这丧失了验证的意义——如果 Builder 的报告可作为真相，就不需要 Verifier。
- **不检查越界修改**：Builder 顺手重构了无关代码，Verifier 没发现。越界修改可能引入未被验收标准覆盖的 bug。
- **验证报告太抽象**：只写"通过了"没有附上实际命令输出。Reviewer 无法判断验证的可信度。
