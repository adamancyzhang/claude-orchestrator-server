# Iteration 5 - Dynamic System Prompts (Phase 1) — 2026-06-07

## Status
- **Overall:** completed
- **Progress:** 6/6 tasks completed
- **Last Updated:** 2026-06-07 11:19

## 目标
实现动态系统提示词架构：Leader 生成系统提示词，Worker 通用执行。

## Checklist

- [x] Task 1: 修改 ChainDef 格式 — commit: da475e3
- [x] Task 2: 修改 Leader decompose 模板 — commit: f6fd734
- [x] Task 3: 修改 ChainRouter 处理逻辑 — commit: da475e3
- [x] Task 4: 修改 Worker 执行逻辑 — commit: f0231e3
- [x] Task 5: 修改 Worker 系统提示词构建 — commit: d9ff386
- [x] Task 6: 更新 Task 消息格式 — commit: da475e3

## 核心变更

### Task 1: 修改 ChainDef 格式
- **文件:** `packages/contracts/src/chain.ts`
- **变更:**
  - `ChainDef.links` 改为 `ChainDef.tasks`
  - 每个 task 包含 `task_id`, `title`, `system_prompt`, `depends_on`
  - 移除固定 `link` 类型（plan/execute/verify/review/accept）
- **验证:** 类型检查通过

### Task 2: 修改 Leader decompose 模板
- **文件:** `templates/workflow/decompose.md`
- **变更:**
  - 引导 LLM 生成系统提示词而非固定角色
  - 输出格式改为新的 ChainDef JSON
  - 系统提示词包含：背景、工作方法、约束、输出
- **验证:** 模板能正确生成新格式 ChainDef

### Task 3: 修改 ChainRouter 处理逻辑
- **文件:** `packages/leader/src/chain-router.ts`
- **变更:**
  - `handleTaskDefinitions()` 适配新 ChainDef 格式
  - `handleCompletionReport()` 适配新任务格式
  - 任务分配不再基于 link 类型，而是通用 Worker
- **验证:** 链式任务能正常流转

### Task 4: 修改 Worker 执行逻辑
- **文件:** `packages/worker/src/watcher.ts`, `packages/worker/src/prompt-render.ts`
- **变更:**
  - Worker 移除固定角色模板加载
  - 使用 Leader 提供的 `system_prompt` 作为系统提示词
  - 保留上游产物传递机制
- **验证:** Worker 能正确执行任务

### Task 5: 修改 Worker 系统提示词构建
- **文件:** `packages/runtime/src/identity.ts`
- **变更:**
  - `buildWorkerSystemPrompt()` 改为接收动态 system_prompt
  - 移除固定角色 responsibilities 加载
  - 保留基础身份信息（worker name, paths）
- **验证:** 系统提示词正确传递

### Task 6: 更新 Task 消息格式
- **文件:** `packages/leader/src/message-router.ts`, `packages/contracts/src/messages.ts`
- **变更:**
  - `task_dispatch` 消息包含 `system_prompt` 字段
  - 移除 `link` 字段
- **验证:** 消息格式正确

## 依赖关系
```
Task 1 (ChainDef) → Task 2 (模板) → Task 3 (ChainRouter)
                   → Task 6 (消息) → Task 4 (Worker)
                                   → Task 5 (Identity)
```

## 成功标准
- 新格式 ChainDef 能正确解析
- Leader 能生成系统提示词
- Worker 能使用动态系统提示词执行任务
- 链式任务能正常流转
- 现有测试不回归
