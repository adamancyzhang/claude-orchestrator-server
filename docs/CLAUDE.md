# Docs 目录规范

本目录是项目文档的唯一来源，所有工作记录和计划必须保存在此。

---

## 目录结构

```
docs/
├── CLAUDE.md              ← 本文件（文档规范）
├── tui.md                 ← TUI 布局参考
├── daily-log/             ← 每日工作日志（按成员→日期）
│   ├── team-lead/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/   ← 决策依据
│   ├── dev-1/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/   ← 测试输出、验证截图
│   ├── dev-2/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/
│   ├── dev-3/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/
│   ├── code-reviewer/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/   ← 审查依据
│   ├── testing-1/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/   ← 测试报告
│   ├── testing-2/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/
│   ├── testing-3/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/
│   ├── architect/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/   ← 审查依据
│   ├── verifier/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/   ← 验证依据
│   ├── cxo/
│   │   └── YYYY-MM-DD/
│   │       ├── work-log.md
│   │       └── evidence/   ← 用户体验报告
│   └── product-manager/
│       └── YYYY-MM-DD/
│           ├── work-log.md
│           └── evidence/   ← 需求文档
├── plans/                 ← 当前迭代计划
│   └── YYYY-MM-DD/
│       └── iteration-N-*.md  ← 迭代计划（按序号排列）
└── archive/               ← 已完成内容归档
    └── YYYY-MM-DD/
        └── YYYY-MM-DD_iteration-N-*.md  ← 日期前缀 + UUID 追踪
```

---

## 责任链工作流

```
需求 → Planner → Executor → Verifier → Reviewer → Accepter
        (计划)    (执行)     (验证)     (审查)     (验收)
```

### 团队角色映射

| 责任链角色 | 团队成员 | 职责 |
|-----------|----------|------|
| Planner | team-lead | 制定计划，定义可验证的验收标准 |
| Executor | dev-1/2/3 | 按计划实现，留下证据链 |
| Verifier | verifier | 验证执行结果，对照计划检查 |
| Reviewer | architect | 审查架构合规性 |
| Accepter | team-lead | 最终验收，决定通过或退回 |
| Code Review | code-reviewer | 代码审查，质量检查 |
| Testing | testing-1/2/3 | 测试验证，边界条件检查 |
| UX | cxo | 用户体验测试 |
| Requirements | product-manager | 需求定义，优先级排序 |

---

## 工作流程（每个任务）

### 1. 规划阶段（team-lead）

```markdown
## 计划
- **Task:** #XX
- **目标:** [具体目标]
- **验收标准:** [可验证的条件]
  - 条件1: "运行 xxx 返回 200"
  - 条件2: "测试覆盖率达到 80%"
- **依赖:** [前置任务]
```

**输出：** 保存到 `docs/plans/YYYY-MM-DD/iteration-N-*.md`

### 2. 执行阶段（dev-1/2/3）

```markdown
## 执行记录
- **Task:** #XX
- **Commit:** <hash>
- **变更文件:**
  - `path/to/file.ts` — 变更说明
- **实现:** [实现方式]
- **偏差:** [与计划的偏差及原因]
```

**证据：** 测试输出保存到 `evidence/` 目录

### 3. 验证阶段（verifier）

```markdown
## 验证记录
- **Task:** #XX
- **Commit:** <hash>（验证时的最新 commit）
- **验证项:**
  - [ ] 验收标准1: PASS/FAIL
  - [ ] 验收标准2: PASS/FAIL
- **结论:** PASS / NEEDS_WORK / FAIL
- **证据:** [验证依据]
```

**规则：**
- 必须对照计划中的验收标准逐项验证
- 必须实际运行测试，不能只看代码
- FAIL 必须说明具体原因

### 4. 审查阶段（architect）

```markdown
## 审查记录
- **Task:** #XX
- **审查项:**
  - [ ] 层边界合规
  - [ ] 接口设计合理
  - [ ] 错误处理完整
- **结论:** PASS / FEEDBACK / REJECT
- **意见:** [具体意见]
```

### 5. 验收阶段（team-lead）

```markdown
## 验收记录
- **Task:** #XX
- **检查:**
  - [ ] 计划完整
  - [ ] 执行有 commit
  - [ ] 验证通过
  - [ ] 审查通过
- **结论:** GO / NO-GO
```

---

## 工作日志规范（daily-log/）

### 目录结构
- 按成员：`{member}/`（如 `dev-1/`）
- 按日期：`YYYY-MM-DD/`（如 `2026-06-07/`）
- 每个成员的 `work-log.md` 记录该成员当日工作
- `evidence/` 目录保存验证依据

### 成员目录列表

| 成员 | 目录 | 记录内容 | 证据类型 |
|------|------|----------|----------|
| team-lead | `team-lead/` | 规划、协调、决策 | 决策依据 |
| dev-1 | `dev-1/` | 编码、测试、提交 | 测试输出 |
| dev-2 | `dev-2/` | 编码、测试、提交 | 测试输出 |
| dev-3 | `dev-3/` | 编码、测试、提交 | 测试输出 |
| code-reviewer | `code-reviewer/` | 代码审查 | 审查依据 |
| testing-1 | `testing-1/` | 测试验证 | 测试报告 |
| testing-2 | `testing-2/` | 测试验证 | 测试报告 |
| testing-3 | `testing-3/` | 测试验证 | 测试报告 |
| architect | `architect/` | 架构审查 | 审查依据 |
| verifier | `verifier/` | 签章验证 | 验证依据 |
| cxo | `cxo/` | 用户体验 | 用户体验报告 |
| product-manager | `product-manager/` | 产品规划 | 需求文档 |

### work-log.md 结构

```markdown
# [成员名] 工作日志 YYYY-MM-DD

## 任务列表

### [任务描述]
- **Task:** #XX
- **Commit:** <hash>
- **变更文件:**
  - `path/to/file.ts` — 变更说明
- **测试结果:** x/y 通过
- **验证:** 通过/待验证/❌ 失败
```

### 记录规则

| 规则 | 说明 |
|------|------|
| **按身份记录** | 每个成员在自己的目录下记录工作 |
| **必须有 commit hash** | 无 commit 的工作（如纯审查）注明"无（纯审查）" |
| **变更文件具体到文件级** | 不要写"修改了 leader 包"，要写具体文件路径 |
| **测试结果写明数量** | 不要写"测试通过"，要写"6/6 通过" |
| **验证状态明确** | 通过/待验证/❌ 失败，三选一 |
| **保存证据** | 测试输出、验证截图保存到 evidence/ 目录 |

---

## 计划规范（plans/）

### 文件命名
- 目录：`YYYY-MM-DD`
- 文件：`iteration-N-<简短描述>.md`
- 序号从 0 开始，按时间顺序递增

### iteration-N-*.md 结构

```markdown
# Iteration N - <标题> — YYYY-MM-DD

## Status
- **Overall:** in_progress | completed | blocked
- **Progress:** X/Y tasks completed
- **Last Updated:** YYYY-MM-DD HH:MM

## 目标
- 目标1
- 目标2

## Checklist

- [ ] Task 1: description
- [ ] Task 2: description

## 任务分解

| ID | 任务 | 负责人 | 依赖 | 验收标准 | 状态 |
|----|------|--------|------|----------|------|
| #XX | 任务描述 | dev-1 | 无 | 测试通过 | ⏳ |

## 验证方式
1. 验证步骤1
2. 验证步骤2

## 预期产出
- 产出1
- 产出2
```

### 计划规则

| 规则 | 说明 |
|------|------|
| **先计划后执行** | 任务必须先记录在 plans/ 再分配给团队成员 |
| **序号连续** | iteration-0, iteration-1, iteration-2... 不跳号 |
| **包含验证方式** | 每个计划必须说明如何验证完成 |
| **包含验收标准** | 每个任务必须有可验证的验收条件 |
| **包含预期产出** | 明确列出每个任务的交付物 |
| **Checklist 追踪** | 使用 `- [x] Task N: description — commit: <hash>` 格式 |

---

## 归档规范（archive/）

### 归档规则
- 已完成的迭代计划归档到 `archive/YYYY-MM-DD/`
- 文件命名：`YYYY-MM-DD_iteration-N-<描述>_<uuid>.md`
- UUID 为 8 位短 UUID，用于追踪标识
- 超过 7 天的日志不再主动维护

### 归档内容
- 迭代计划（iteration-N-*.md）
- 基准测试场景（benchmark-scenarios.md）
- 其他已完成的一次性文档

---

## 文档维护

### team-lead 职责
- 每次会话开始检查未完成的日志
- 每次会话结束更新当日记录
- 确保所有任务都有文档记录
- 最终验收每个任务
- 归档已完成的迭代计划

### 团队成员职责
- 完成任务后立即报告 commit hash 和变更文件
- 在自己的目录下记录工作日志
- 保存证据到 evidence/ 目录
