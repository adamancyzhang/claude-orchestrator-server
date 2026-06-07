# Iteration 6 - Quality Gate Execution — 2026-06-07

## Status
- **Overall:** completed
- **Progress:** 5/5 tasks completed
- **Last Updated:** 2026-06-07 11:48

## 目标
实现质量门执行逻辑，让 Worker 能根据 quality_gate.type 执行验证。

## Checklist

- [x] Task 1: 更新 ChainDef 支持 quality_gate — commit: 158cda4
- [x] Task 2: 更新 decompose 模板生成 quality_gate — commit: 597ebd0
- [x] Task 3: 实现质量门执行器 — commit: edc5507
- [x] Task 4: 集成质量门到 Worker 流程 — commit: 013373b
- [x] Task 5: 更新完成报告格式 — commit: 9ae5161

## 核心任务

### Task 1: 更新 ChainDef 支持 quality_gate
- **文件:** `packages/contracts/src/schemas/chain.ts`
- **变更:**
  - ChainTask 添加 `quality_gate` 字段
  - 定义 QualityGate 类型（self_eval, test, review, accept）
  - 更新验证逻辑
- **验证:** 类型检查通过

### Task 2: 更新 decompose 模板生成 quality_gate
- **文件:** `templates/workflow/decompose.md`
- **变更:**
  - 引导 LLM 为每个任务生成质量门
  - 根据任务类型选择合适的质量门类型
  - 更新输出格式示例
- **验证:** 模板能正确生成带质量门的 ChainDef

### Task 3: 实现质量门执行器
- **文件:** `packages/worker/src/quality-gate.ts` (新)
- **变更:**
  - 实现 QualityGateExecutor 类
  - 支持 self_eval 类型：调用 LLM 自评估
  - 支持 test 类型：运行命令验证
  - 支持 review 类型：等待审查者
  - 支持 accept 类型：等待 Leader 验收
- **验证:** 单元测试通过

### Task 4: 集成质量门到 Worker 流程
- **文件:** `packages/worker/src/watcher.ts`
- **变更:**
  - Worker 执行完成后调用质量门
  - 根据质量门结果决定是否通过
  - 失败时发送 needs_revision 报告
- **验证:** 集成测试通过

### Task 5: 更新完成报告格式
- **文件:** `packages/worker/src/report-messages.ts`
- **变更:**
  - 完成报告包含 quality_gate_result
  - 记录质量门执行证据
- **验证:** 报告格式正确

## 依赖关系
```
Task 1 (ChainDef) → Task 2 (模板)
                  → Task 3 (执行器) → Task 4 (集成)
                                    → Task 5 (报告)
```

## 成功标准
- 质量门能正确执行验证
- 测试类型质量门能运行命令
- 自评估类型能调用 LLM
- 失败时能正确报告
- 现有测试不回归
