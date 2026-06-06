# 基准测试场景

**日期：** 2026-06-07
**目的：** 定义项目在实际工作中的表现基准，指导持续优化

---

## 场景分类

### A. 基础设施场景（必须 100% 通过）

| ID | 场景 | 验证方式 | 当前状态 |
|----|------|----------|----------|
| A1 | 全量编译 | `pnpm build` 无错误 | ✅ |
| A2 | 全量测试 | `pnpm test` 439/439 | ✅ |
| A3 | 层边界 | dependency-cruiser 零违规 | ✅ |
| A4 | 品牌 ID 类型安全 | contracts 包测试 | ✅ |

### B. CLI 命令场景（headless 模式）

| ID | 场景 | 验证方式 | 当前状态 |
|----|------|----------|----------|
| B1 | 启动 headless 模式 | `run --headless --worker 6` 启动成功 | ✅ E2E 测试 |
| B2 | 发送任务 | `send "test task"` 写入 commands.jsonl | ✅ CommandWatcher 已集成 (Task #38) |
| B3 | 查看状态 | `status` 读取 state.json | ✅ E2E 测试 |
| B4 | 查看 workers | `workers` 显示表格 | ✅ E2E 测试 |
| B5 | 查看 tasks | `tasks` 显示任务列表 | ✅ E2E 测试 |
| B6 | 查看 events | `events --tail 10` 显示事件 | ✅ E2E 测试 |
| B7 | 查看 messages | `messages <worker>` 显示消息 | ✅ E2E 测试 |
| B8 | 等待完成 | `wait --task <id> --timeout 60` | ✅ E2E 测试 |

### C. 核心功能场景（端到端）

| ID | 场景 | 验证方式 | 当前状态 |
|----|------|----------|----------|
| C1 | Worker 创建 | worktree 初始化成功 | ✅ 单元测试 |
| C2 | 任务分解 | 需求 → ChainDef | ✅ 覆盖充分 (Task #22) |
| C3 | 任务执行 | Worker 处理任务 | ✅ 集成测试 (Task #19) |
| C4 | 自我评估 | EvalDecision 生成 | ✅ 完整覆盖 |
| C5 | 链式流转 | Plan→Execute→Verify→Review→Accept | ✅ 8 个测试 (Task #17) |
| C6 | 合并验证 | MergeValidator 检查 | ✅ 完整覆盖 |
| C7 | 错误恢复 | TaskRecovery 扫描孤儿任务 | ✅ 7 个测试 (Task #27) |

### D. Magic Mode 场景

| ID | 场景 | 验证方式 | 当前状态 |
|----|------|----------|----------|
| D1 | Explorer 启动 | `--magic` 模式下第 6 个 worker 为 explorer | ✅ 覆盖充分 (Task #31) |
| D2 | 自主探索 | Explorer 分析代码库 | ✅ 集成测试 (Task #31) |
| D3 | 子链生成 | spawn_chain 决策 | ✅ 2 个测试 (Task #40) |
| D4 | 深度限制 | `--magic-max-chains` 生效 | ✅ 1 个测试 (Task #40) |

---

## 优先级

1. **P0（完成）:** E2E 测试覆盖 B1-B8 ✅
2. **P1（完成）:** 验证 C1-C7 核心功能 ✅
3. **P2（进行中）:** 验证 D1-D4 Magic Mode

## 下一步

- 补充 D3-D4 测试覆盖
- 更新 README 文档反映新 CLI 命令
- 考虑添加 `chains` 命令（product-manager 建议）
- 考虑添加 `--json` 输出选项（便于脚本化）
