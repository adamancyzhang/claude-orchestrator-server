---
name: task-review
description: Quality review of the full Plan→Build→Verify chain for the Reviewer role. Use when the Reviewer needs to assess whether the implementation matches the Planner's design intent — checking code quality, architecture compliance, verification completeness, and producing a review report with a pass/revise decision. Triggers on keywords like "审查", "review", "code review", "检查代码", "审批", "复核", or when verification is complete and the task enters the Review stage of the responsibility chain.
---

# Task Review

> 审查不是挑刺，是从设计意图的高度判断实现是否"做对了"——不是"代码写得怎么样"，而是"该不该通过"。本技能确保每次审查有依据、有深度、有结论。

---

## 何时触发

- Verifier 完成验证，责任链流转到 Review 阶段
- Worker 通过 `claude-orchestrator claim-task` 认领了 review 类型的任务
- 用户说"审查一下这个 PR"、"review 一下代码"
- 蓝图中有 review 类型的任务需要开工

---

## 审查六步法

按顺序执行，每一步通过才进入下一步。

### 1. 认领 Review 任务并收集全链信息

```bash
# 认领审查任务
claude-orchestrator claim-task

# 获取蓝图
claude-orchestrator get-context --key plan-<目标slug>

# 获取验证报告
claude-orchestrator get-context --key verify-<目标slug>
```

收集审查所需的完整上下文：
- Planner 的蓝图（设计意图、验收标准、范围边界）
- Builder 的代码变更（commit diff）
- Verifier 的验证报告（问题清单、回归结果）
- Builder 的 task-traceability 记录（commit hash 链）

如果缺少任何一环的产出 → 退回要求补齐。Reviewer 不做信息不完整的审查。

### 2. 审查设计一致性

对照蓝图检查实际实现，回答三个核心问题：

**做对了吗？**（功能正确性）
- 代码变更是否实现了蓝图定义的全部功能？
- 是否有蓝图定义但未实现的部分？
- 是否有蓝图未定义但被实现了的部分（越界）？

**做合适吗？**（架构合规性）
- 代码结构是否符合项目现有的架构模式？
- 是否引入了新的依赖或模式变更？（如有，是否必要且有充分理由？）
- 命名、目录组织、接口设计与项目现有风格是否一致？

**技术债务可控吗？**
- 是否有明显的性能问题、安全问题、可维护性问题？
- 是否引入了难以测试的逻辑？
- 错误处理是否合理？

```bash
# 查看完整 diff
git show <commit-hash> --patch

# 查看变更的文件列表
git show <commit-hash> --stat
```

### 3. 审查验证报告的完整性

审查 Verifier 的工作质量：

- 验证报告是否覆盖了蓝图中所有验收标准？
- 验证方法是否独立可复现？（不是转述 Builder 的结果）
- 回归测试是否被执行且通过？
- Verifier 发现的问题是否被充分描述和分类？

如果验证报告有缺陷（漏检、方法不当）→ 标记为 Review 前置条件不满足，退回 Verifier 补充。

### 4. 判定问题等级

对发现的问题按严重度分级：

| 级别 | 定义 | 示例 | 处理 |
|------|------|------|------|
| **P0** | 阻断：设计意图未实现，核心功能缺失或不正确 | 蓝图要求的功能完全没做、引入安全漏洞 | 退回 Builder 重做 |
| **P1** | 严重：实现偏离设计意图，但不影响核心功能 | 错误处理不完整、UI 与设计不一致、性能明显下降 | 退回 Builder 修改 |
| **P2** | 一般：代码质量、风格、可维护性问题 | 命名不清晰、缺少注释、测试覆盖面不足 | 建议修改，不阻断通过 |
| **P3** | 建议：优化建议，不影响通过 | 更好的实现方式、可选的性能优化 | 记录，Builder 自行决定 |

### 5. 书写审查报告

```markdown
# 审查报告

> Reviewer | YYYY-MM-DD | 审查范围：<目标名称> (P→B→V 全链)

## 审查结论：Pass / Revise

（一句话结论）

---

## 审查范围

| 环节 | 负责人 | 产出 | Commit / 文档 |
|------|--------|------|--------------|
| Plan | <Planner> | 蓝图 | plan-<slug> |
| Build | <Builder> | 代码 | `a1b2c3d` |
| Verify | <Verifier> | 验证报告 | verify-<slug> |

---

## 设计一致性审查

| 蓝图要求 | 实现情况 | 判定 |
|---------|---------|------|
| 功能 A：XXX | 已实现，见 `src/a.ts:42` | ✅ |
| 功能 B：YYY | 部分实现，缺少边界处理 | ⚠️ |
| 功能 C：ZZZ | 未实现 | ❌ |

---

## 代码质量审查

| 检查项 | 结果 |
|--------|------|
| 架构合规 | ✅ / ⚠️ / ❌ |
| 命名规范 | ✅ / ⚠️ / ❌ |
| 错误处理 | ✅ / ⚠️ / ❌ |
| 性能影响 | ✅ / ⚠️ / ❌ |
| 安全问题 | ✅ / ⚠️ / ❌ |

---

## 验证报告审查

| 检查项 | 结果 |
|--------|------|
| 验收标准覆盖 | 3/3 ✅ |
| 验证方法独立 | ✅ |
| 回归测试通过 | ✅ (42/42) |
| Verifier 问题充分描述 | ✅ |

---

## 问题清单

| # | 级别 | 描述 | 位置 | 责任人 |
|---|------|------|------|--------|
| 1 | P1 | 缺少错误重试逻辑 | `src/auth.ts:L42` | @Builder |
| 2 | P2 | 变量名 `tmp` 不够清晰 | `src/utils.ts:L18` | @Builder |

---

## 审查建议

（对 Builder/Planner/Verifier 的非强制性建议）

---

*Reviewer — YYYY-MM-DD*
```

### 6. 通知结果并流转

```bash
# 存入共享上下文
claude-orchestrator set-context \
  --key review-<目标slug> \
  --value "$(cat docs/review/<目标slug>-YYYY-MM-DD.md)"

# Revise → 通知 Builder 和 Planner
claude-orchestrator send-message \
  --to <builder-id> \
  --content "审查结论 Revise。P1: 缺少错误重试逻辑。详见 review-<slug>"

# Pass → 通知 Leader 和 Accepter，流转到 Accept 阶段
claude-orchestrator send-message \
  --broadcast \
  --content "审查结论 Pass。<目标> 通过 Review，流转至 Accept 阶段。"
```

---

## 审查完成检查清单

```
□ 已收集完整的 P→B→V 链产出
□ 蓝图验收标准全部检查
□ 代码 diff 完整审阅
□ 验证报告质量和完整性已评估
□ 问题已按 P0/P1/P2/P3 分级
□ 审查报告已产出并存入共享上下文
□ 结论（Pass/Revise）已通知相关角色
```

---

## 与其他技能的协作

- **[[task-planning]]**：Reviewer 以 Planner 的蓝图为审查标准。设计意图是唯一的判断基准。
- **[[task-execution]]**：Reviewer 审查 Builder 的代码实现质量和设计一致性。
- **[[task-verification]]**：Reviewer 审查 Verifier 的验证报告质量和完整性。验证报告有缺陷的，退回 Verifier。
- **[[task-acceptance]]**：Accepter 依赖 Reviewer 的 Pass 结论来决定是否进入最终验收。Review 不通过的无须进入 Accept。
- **[[task-traceability]]**：Reviewer 依赖 traceability 链来追溯每个变更的 commit。如果 traceability 链断裂，标记为 P1 问题。

---

## 常见错误

- **只审代码不审设计一致性**：陷入代码风格审查，忘记了 Reviewer 的核心职责是判断"是否实现了设计意图"。代码写得再好，与蓝图不一致也是不合格。
- **跳过对 Verifier 的审查**：假设 Verifier 的报告总是完整正确的。Verifier 也可能遗漏或误判。
- **不分级的问题清单**：把所有问题列出但不定级，Builder 不知道哪些必须修改、哪些可以忽略。
- **审查报告不写位置**：问题只描述不定位（缺少文件路径和行号）。Builder 不知道在哪里改。
- **Pass 但有问题未解决**：P0/P1 问题未解决就签 Pass。零 P0/P1 是 Pass 的前提。
