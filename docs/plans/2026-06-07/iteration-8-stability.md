# Iteration 8 - Stability & Technical Debt — 2026-06-07

## Status
- **Overall:** in_progress
- **Progress:** 6/8 tasks completed
- **Last Updated:** 2026-06-07 19:00

## 目标
1. 修复 TypeScript 编译错误，建立稳定基线
2. 完成 Iteration 7 遗留的 4 个验证任务
3. 补充 CommandWatcher 单元测试
4. 添加 CLI 改进（--dry-run, --cleanup）

## Checklist

- [x] Task 1: 修复 TypeScript 编译错误（5 个错误，leader 包）— commit: 9fbe4507
- [ ] Task 2: 验证 Leader 动态 ChainDef 生成（Iteration 7 Task 3）— RE-VERIFICATION after Task 9 fix
- [ ] Task 3: 验证 Worker 自动领取任务（Iteration 7 Task 4）— RE-VERIFICATION after Task 9 fix
- [ ] Task 4: 验证质量门自动触发（Iteration 7 Task 5）— RE-VERIFICATION after Task 9 fix
- [ ] Task 5: 验证追溯链记录（Iteration 7 Task 6）— RE-VERIFICATION after Task 9 fix
- [x] Task 6: 补充 CommandWatcher 单元测试 — commit: da7ff0d
- [x] Task 7: 添加 --dry-run 选项 — commit: 25d4326b
- [x] Task 8: 添加 --cleanup 选项 — commit: b8c2b50

## 依赖关系

```
Task 1 (TS fixes) ──┬──→ Task 2 (verify ChainDef)
                    ├──→ Task 3 (verify Worker claim)
                    ├──→ Task 4 (verify quality gate)
                    ├──→ Task 5 (verify traceability)
                    └──→ Task 6 (CommandWatcher tests)

Task 7 (--dry-run) ── 独立
Task 8 (--cleanup) ── 独立
```

## 详细设计

### Task 1: 修复 TypeScript 编译错误
- **优先级:** P0（阻塞其他任务）
- **分配:** dev-1
- **文件:**
  - `packages/leader/src/chain-router.ts` (lines 570, 605, 697)
  - `packages/leader/src/state.ts` (line 284)
  - `packages/leader/src/tui/panels/event-log.tsx` (line 10)
- **错误详情:**
  1. TS2339: Property 'tasks' does not exist — ChainDef 类型不匹配（task_list vs tasks）
  2. TS2345: Argument type not assignable — ChainDef union type 问题
  3. TS2339: Property 'quality_gate' does not exist — task 类型缺少 quality_gate
  4. TS2345: Argument of type not assignable to 'never' — event type 问题
  5. TS2366: Function lacks ending return statement — event-log.tsx
- **验收标准:** `cd packages/leader && npx tsc --noEmit` 无错误

### Task 2: 验证 Leader 动态 ChainDef 生成
- **优先级:** P0
- **分配:** testing-1
- **验证内容:**
  1. Leader 能根据用户输入动态生成 ChainDef
  2. ChainDef 包含正确的 task_list
  3. system_prompt 质量符合预期
- **依赖:** Task 1
- **验收标准:** 真机实测 PASS，记录验证过程

### Task 3: 验证 Worker 自动领取任务
- **优先级:** P0
- **分配:** testing-1
- **验证内容:**
  1. Worker 启动后自动监听任务
  2. 提交任务后 Worker 自动领取
  3. 执行结果正确返回
  4. Bug #9 (CommandWatcher crash) 已修复确认
- **依赖:** Task 1
- **验收标准:** 真机实测 PASS，记录验证过程

### Task 4: 验证质量门自动触发
- **优先级:** P1
- **分配:** testing-1
- **验证内容:**
  1. 配置 quality_gate 后执行任务
  2. 质量门自动触发
  3. 结果正确记录到 state.json
- **依赖:** Task 1
- **验收标准:** 真机实测 PASS

### Task 5: 验证追溯链记录
- **优先级:** P1
- **分配:** testing-1
- **验证内容:**
  1. 执行多个任务
  2. 检查 state.json 记录
  3. 验证每个任务的执行者、时间、结果
- **依赖:** Task 1
- **验收标准:** 真机实测 PASS

### Task 6: 补充 CommandWatcher 单元测试
- **优先级:** P1
- **分配:** dev-2
- **测试场景:**
  1. 文件不存在时不崩溃
  2. 文件延迟创建后正常读取
  3. JSON 格式错误行被跳过
  4. 追加写入正确触发处理
- **依赖:** Task 1
- **验收标准:** 测试覆盖率 ≥ 80%，所有测试通过

### Task 7: 添加 --dry-run 选项
- **优先级:** P2
- **分配:** dev-1
- **实现:**
  1. 解析 `--dry-run` 命令行参数
  2. 输出计划操作但不执行
  3. 显示：Worker 数量、Skills 安装、文件覆盖等
- **验收标准:** `--dry-run` 不产生副作用，输出清晰

### Task 8: 添加 --cleanup 选项
- **优先级:** P2
- **分配:** dev-2
- **实现:**
  1. 解析 `--cleanup` 命令行参数
  2. 清理 `~/.claude-orchestrator/projects/<id>/`
  3. 清理 worktrees
- **验收标准:** `--cleanup` 正确清理临时文件

## 成功标准
1. TypeScript 编译零错误
2. Iteration 7 所有验证任务 PASS
3. CommandWatcher 测试覆盖率 ≥ 80%
4. --dry-run 和 --cleanup 功能可用
