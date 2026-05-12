---
name: task-acceptance
description: PM task-level acceptance verification. Use when the PM needs to verify completed work from team members, run acceptance on daily work assignments, or confirm deliverables before signing off. Triggers on keywords like "确认并验收", "验收一下", "verify and accept", "检查完成情况", "task acceptance", "任务验收". Covers per-task-assignment verification workflow with cross-worktree git checks, commit signature validation, and report data cross-validation.
---

# Task Acceptance

> 验收不是读报告，是逐项验证代码、测试、git commit 的真实存在。本技能确保每次验收不走形式、不漏步骤。

---

## 何时触发

- 用户说"确认并验收"、"验收一下"、"检查一下完成情况"
- 团队成员报告任务完成，PM 需要核实
- daily work assignment 文档中所有任务标记为已完成
- PM 准备签阶段验收报告

---

## 验收八步法

按顺序执行，每一步通过才进入下一步。任一步不通过 → 记录问题，最终 No-Go。

### 1. 读取工作分配文档

找到对应的任务分配文档（如 `docs/pm/YYYY-MM-DD/daily-work-assignment.md`），提取：
- 每个成员的任务清单和验收标准
- 预期的产出物路径
- 依赖链（谁依赖谁先完成）

### 2. 检查产出物是否存在

对每个成员，检查指定的产出目录下是否有对应的产出文件。

```bash
ls -la docs/{member}/YYYY-MM-DD/
```

如果报告引用了产出物但文件不存在 → P1 问题。

### 3. 验证代码变更真实存在

**不要轻信报告中的描述。** 对每项声称的代码修改，直接 grep 验证：

```bash
# 示例：验证某组件是否真的引入了某个依赖
grep -n "<key-symbol>" <source-file-path>

# 示例：验证是否替换了特定常量
grep -n "<new-value>" <spec-file-path>

# 验证旧引用已清除
grep "<old-value>" <spec-file-path>  # 应无结果
```

如果代码变更不存在但报告声称已完成 → P0 问题（虚假报告）。

### 4. 运行测试验证数字

报告中的测试数字必须可复现：

```bash
# 运行单元测试
<project-test-command> 2>&1 | tail -20

# 统计测试文件中的实际测试数量
for f in <test-glob-pattern>; do
  count=$(grep -c "test(" "$f")
  echo "$f: $count tests"
done
```

将实际测试数与报告中的数字对比。不一致 → P2 问题（报告错误）。

### 5. 验证 git commit 真实存在

**关键**：如项目使用多个独立 git worktree 或子模块，必须在对应目录下检查 commit。

```bash
# 检查各仓库的 git log
cd <subdir> && git log --oneline -10
```

对报告中引用的每个 commit hash：

```bash
cd <subdir> && git log --all --oneline | grep "^<commit-hash>"
```

如果 commit hash 不存在 → P0 问题（commits 未生成或引用了虚构 hash）。

同时检查**工作区是否干净**（`git status`）—— 如果有未提交的变更，成果可能未真正落盘。

### 6. 验证 commit message 格式

根据项目 CLAUDE.md 中的 Git Commit Rules 检查 commit message 格式：

```bash
# 检查每个相关 commit 的完整 message
cd <subdir> && git log --format="%B" <commit-hash> -1
```

格式不符合项目规范 → P1 问题（规范违规）。

> **amend 边界**：如果 commit 未 push 到 remote，可 amend 修复；已 push 则必须新建 commit。

### 7. 交叉验证报告数据

报告中的数字必须自洽：

- 分项测试数相加是否等于合计？
- 表格是否有重复行？
- 截图数量是否与声称一致？
- 引用文件路径是否真实存在？

```bash
# 检查截图文件是否存在
ls -la docs/{member}/YYYY-MM-DD/*.png
```

不一致 → P2 问题。

### 8. 产出验收报告

写入 PM 的验收报告文件（如 `docs/pm/YYYY-MM-DD/acceptance-report.md`），使用以下模板：

```markdown
# 验收报告

> PM | YYYY-MM-DD | 验收范围：成员 A / 成员 B / ... 交付物

## 验收结论：Go / No-Go

（一句话结论 + 原因）

---

## 逐项验收

### 成员 A — 任务名称

| 检查项 | 预期 | 实际 | 结果 |
|--------|------|------|------|
| ... | ... | ... | ✅/❌/⚠️ |

### 成员 B — 任务名称

...

---

## 问题清单

| # | 严重度 | 问题 | 责任人 | 修复方案 |
|---|--------|------|--------|---------|
| 1 | P0/P1/P2 | 描述 | @name | 具体操作 |

---

## 验收完成标准重检

- [ ] 标准 1 ✅/❌
- [ ] 标准 2 ✅/❌
...

---

*PM — YYYY-MM-DD*
```

---

## 问题严重度分级

| 级别 | 定义 | 示例 |
|------|------|------|
| P0 | 虚假报告、代码变更不存在、commit 不存在 | 引用不存在的 commit hash |
| P1 | 规范违规、产出物缺失、签名格式错误 | commit 格式不符合项目要求 |
| P2 | 报告数据错误、表格笔误 | 测试数分项与合计不对应 |

验收标准：**零问题才能签 Go**。不做"条件通过"。

---

## 特别注意

- **外部阻塞不是缺陷**：如外部依赖未就绪导致某些验收项无法执行，在报告中标注为外部阻塞，不计入问题清单，但须明确放行条件。
- **worktree / 多仓库**：如项目使用多个独立 git worktree 或子模块，git 操作必须 `cd` 到对应子目录执行。根目录的 `git log` 看不到子目录的 commit。
- **报告 ≠ 真相**：报告中的 claim 必须可独立验证。如果某项验收标准无法复现（如需要外部系统产出），标记为 ⏸ Blocked，不打 ☑。
- **commit 后验收**：团队成员应在验收前完成 commit。如果发现未 commit，退回要求先 commit 再验收。
