# Core Chain Overview — v0.6 核心链路总览

> **文档定位**：Claude Orchestrator 的五条核心链路的全景图与关系说明。每条链路的详细设计见独立文档。

## 1. 五条核心链路

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         核心链路全景                                       │
│                                                                         │
│   链路 1: 需求 → 任务                                                    │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ TUI 输入  │───▶│ Decompose│───▶│ ChainDef │───▶│ Push 5   │          │
│   │ 用户需求  │    │ 拆解需求  │    │ JSON     │    │ Tasks    │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
│                                                                         │
│   链路 2: 任务认领 → 执行                                                │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ Claim    │───▶│ Render   │───▶│ Claude   │───▶│ Self-    │          │
│   │ Task     │    │ Template │    │ Execute  │    │ Evaluate │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
│                                                                         │
│   链路 3: 责任链推进                                                     │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ Eval     │───▶│ Chain    │───▶│ Activate │───▶│ Next     │          │
│   │ Decision │    │ Router   │    │ Next Link│    │ Worker   │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
│                                                                         │
│   链路 4: 合并 → 关闭                                                    │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ Commit   │───▶│ Merge    │───▶│ claude-  │───▶│ Chain    │          │
│   │ Check    │    │ Validator│    │ cli merge│    │ Close    │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
│                                                                         │
│   链路 5: 恢复                                                           │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ Worker   │───▶│ Orphan   │───▶│ Retry    │───▶│ Archive  │          │
│   │ Lost     │    │ Detect   │    │ or Archive│   │ Failed   │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. 链路关系

```
链路 1 (需求→任务)
    │
    ▼
链路 2 (认领→执行) ◄──────────────────────────┐
    │                                          │
    ▼                                          │
链路 3 (责任链推进) ── activate_next ──────────┘
    │
    ├── feedback ──→ 回到链路 2（同一 link 重做）
    │
    ├── reject ──→ 链失败终止
    │
    └── close_chain ──→ 链路 4 (合并→关闭)
    
链路 5 (恢复) —— 任何时候 Worker 失联时触发，与链路 1-4 并行
```

## 3. 链路速查

| 链路 | 文档 | 入口 | 出口 | 关键角色 |
|------|------|------|------|---------|
| 1. 需求→任务 | `01-requirement-to-tasks.md` | TUI 键盘输入 | 5 个任务入 pending | ChainRouter, Planner |
| 2. 认领→执行 | `02-task-claim-and-execute.md` | ZK 消息到达 | EvalDecision JSON | Worker, TemplateEngine, ClaudeRunner, SelfEvaluator |
| 3. 链推进 | `03-chain-progression.md` | 完成报告到达 Leader | 下一 link 激活 或 链终结 | ChainRouter, LeaderWatcher |
| 4. 合并→关闭 | `04-merge-and-close.md` | Worker commit ready | claude-cli merge 完成 + 链关闭 | MergeValidator, ClaudeRunner, ChainRouter |
| 5. 恢复 | `05-recovery.md` | Worker EPHEMERAL 消失 | 任务重入 pending 或归档 | Recovery, TaskOrchestrator |

## 4. 端到端数据流

```
1. 用户输入 "实现用户认证模块" → TUI → /messages/{leader_id}/msg-NNNNN
2. LeaderWatcher 捕获 → ChainRouter.route()
3. Decompose → ChainDef JSON { plan, build, verify, review, accept }
4. Push 5 tasks → /tasks/pending/task-{seq} ×5
5. Tom(planner) ZK Watch 触发 → claim task-001
6. Tom 执行 worker-plan.md → 输出蓝图 → 自评估 → completion_report
7. Leader 收到 activate_next(build) → 发送 task-002 给 Jerry
8. Jerry 执行 worker-build.md → 实现代码 → commit → 自评估 → activate_next(verify)
9. ... 依次至 Accept
10. Jack 执行 worker-accept.md → close_chain
11. MergeValidator 通过 claude-cli 合并各 Worker 分支 → main
```

## 5. 关键决策点

| 决策点 | 位置 | 可选路径 | 决策依据 |
|--------|------|---------|---------|
| Decompose 方式 | 链路 1 | Leader 自处理 / 转发 Planner | 模板是否已加载 |
| 任务认领 | 链路 2 | 角色匹配优先 / 任意 Worker | ROLE_WEIGHTS + priority + FIFO |
| 链推进方向 | 链路 3 | activate_next / feedback / reject / close_chain | EvalDecision.decision |
| 合并策略 | 链路 4 | merge / skip / review_first | MergeValidator 裁决 |
| 孤儿处理 | 链路 5 | retry / archive failed | retry_count < 3 |

## 6. 阅读建议

- **实现责任链推进** → 先读链路 2 + 链路 3
- **实现启动流程** → 读 `dd/config-and-cli.md` + 链路 1
- **实现错误恢复** → 读链路 5 + `dd/error-and-recovery.md`
- **理解全局** → 按链路 1 → 2 → 3 → 4 → 5 顺序阅读
