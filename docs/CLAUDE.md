# Docs 目录规范

本目录是项目文档的唯一来源，所有工作记录和计划必须保存在此。

---

## 目录结构

```
docs/
├── CLAUDE.md              ← 本文件（文档规范）
├── tui.md                 ← TUI 布局参考
├── daily-log/             ← 每日工作日志
│   └── YYYY-MM-DD/
│       ├── team-lead/
│       │   └── work-log.md
│       ├── dev-1/
│       │   └── work-log.md
│       ├── dev-2/
│       │   └── work-log.md
│       ├── dev-3/
│       │   └── work-log.md
│       ├── architect/
│       │   └── work-log.md
│       ├── verifier/
│       │   └── work-log.md
│       ├── qa-engineer/
│       │   └── work-log.md
│       ├── team-coach/
│       │   └── work-log.md
│       ├── tdd-guardian/
│       │   └── work-log.md
│       └── product-manager/
│           └── work-log.md
└── plans/                 ← 迭代计划
    └── YYYY-MM-DD/
        └── iteration-N-*.md  ← 迭代计划（按序号排列）
```

---

## 工作日志规范（daily-log/）

### 目录结构
- 按日期：`YYYY-MM-DD/`（如 `2026-06-07/`）
- 按成员：每个团队成员一个子目录
- 每个成员的 `work-log.md` 记录该成员当日工作

### 成员目录列表

| 成员 | 目录 | 记录内容 |
|------|------|----------|
| team-lead | `team-lead/` | 规划、协调、决策 |
| dev-1 | `dev-1/` | 编码、测试、提交 |
| dev-2 | `dev-2/` | 编码、测试、提交 |
| dev-3 | `dev-3/` | 编码、测试、提交 |
| architect | `architect/` | 架构审查 |
| verifier | `verifier/` | 签章验证 |
| qa-engineer | `qa-engineer/` | 质量验证 |
| team-coach | `team-coach/` | 协作检查 |
| tdd-guardian | `tdd-guardian/` | 全量测试 |
| product-manager | `product-manager/` | 产品规划 |

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

---

## 计划规范（plans/）

### 文件命名
- 目录：`YYYY-MM-DD`
- 文件：`iteration-N-<简短描述>.md`
- 序号从 0 开始，按时间顺序递增

### iteration-N-*.md 结构

```markdown
# Iteration N: <标题>

**日期：** YYYY-MM-DD
**状态：** 进行中/已完成

---

## 目标
- 目标1
- 目标2

## 任务分解

| ID | 任务 | 负责人 | 依赖 | 状态 |
|----|------|--------|------|------|
| #XX | 任务描述 | dev-1 | 无 | ⏳ |

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
| **包含预期产出** | 明确列出每个任务的交付物 |

---

## 文档维护

### team-lead 职责
- 每次会话开始检查未完成的日志
- 每次会话结束更新当日记录
- 确保所有任务都有文档记录

### 团队成员职责
- 完成任务后立即报告 commit hash 和变更文件
- 在自己的目录下记录工作日志

### 归档规则
- 超过 7 天的日志不再主动维护
- 重要决策保留在 memory 文件中跨会话持久化
