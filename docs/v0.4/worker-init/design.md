# Worker 初始化方案 — 基于 Prompt 的 Directory Memory 设计

## 概述

基于 `examples-workspace/` 的文档模式，设计纯 prompt 驱动的 Worker 初始化方案。通过三层 CLAUDE.md 建立 directory memory，通过精简的 agent 模板 + skill 引用来指引 Worker 按标准流程执行任务，所有产出物写入 `.claude-orchestrator/docs/` 目录。

## 核心设计决策

1. **不动代码逻辑** — 仅优化模板文件，不添加运行时规则
2. **身份卡片由 TemplateEngine 内置** — 模板不重复身份信息，避免冗余
3. **Skill 驱动流程** — 模板简要指引 + 引导 Worker 读取对应 skill 文件，避免 prompt 过长导致 LLM 注意力分散
4. **`.claude-orchestrator/docs/` 为唯一产出目录** — 所有 Worker 文档产出集中管理
5. **责任链闭环** — 每个环节产出明确产物，下一环节从上游目录读取验证

## 三层 Directory Memory

```
worktree/
├── CLAUDE.md                          ← 第 1 层：团队级
│     团队角色表、产出目录规范、skill 索引、Git 规则
│
├── .claude-orchestrator/
│   └── docs/{name}/
│       ├── CLAUDE.md                  ← 第 2 层：个人级（角色规范）
│       └── YYYY-MM-DD/
│           └── CLAUDE.md              ← 第 3 层：每日级（会话记忆）
```

- 第 1、2 层在 worktree 创建时从 `src/templates/` 复制
- 第 3 层由 Worker 在任务执行时自行创建和维护

## 文件清单

| 文件 | 操作 |
|------|------|
| `templates/claude-memory/team-claude.md` | 新增 — 工作区级 |
| `templates/claude-memory/personal-claude-{planner,builder,verifier,reviewer,accepter}.md` | 新增 — 5 个角色规范 |
| `templates/agents/worker-decompose.md` | 重写 — 精简 + skill 引用 |
| `templates/agents/worker-plan.md` | 重写 — task-planning skill |
| `templates/agents/worker-build.md` | 重写 — task-execution skill |
| `templates/agents/worker-verify.md` | 重写 — task-verification skill |
| `templates/agents/worker-review.md` | 重写 — task-review skill |
| `templates/agents/worker-accept.md` | 重写 — task-acceptance skill |
| `templates/agents/worker-evaluate.md` | 重写 — 自评估 + 目录完整性检查 |
| `src/worker/worktree-initializer.ts` | 修改 — 复制 CLAUDE.md 模板到 worktree |
| `src/orchestrator/run.ts` | 修改 — 复制 team-claude.md 到项目根目录 |
| `tests/unit/worker-prompt-rendering.test.ts` | 新增 — 验证所有模板变量替换 |
| `docs/v0.4/worker-init/design.md` | 本文件 |

## 模板设计模式

每个 worker-*.md 遵循统一结构：

1. **角色声明**（1 行）— 说明当前链环节
2. **Step 0: Directory Memory**（3-4 行）— 指引读取 CLAUDE.md
3. **Task**（变量块）— 任务上下文
4. **Process**（2-5 行）— 引用对应 skill 文件 + 关键输出路径
5. **Outputs**（2-3 行）— 双写路径
6. **Completion Report**（格式块）— 完成报告模板

身份卡片（Business Card）由 `TemplateEngine.render()` 自动前置，模板不重复。

## Skill 与 Worker 对应关系

| Worker | 主要 Skill | 基础 Skill |
|--------|-----------|-----------|
| Planner | `task-planning` | `task-traceability` |
| Builder | `task-execution` | `task-traceability` |
| Verifier | `task-verification` | `task-traceability` |
| Reviewer | `task-review` | `task-traceability` |
| Accepter | `task-acceptance` | — |

## 验证

- 8 个 prompt 渲染测试全部通过，所有 `{{var}}` 完整替换
- TypeScript 编译通过
- 102 个已有测试全部通过
