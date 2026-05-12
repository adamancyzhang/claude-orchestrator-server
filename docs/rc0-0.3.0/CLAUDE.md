# rc0-0.3.0 迭代摘要

## 版本目标

v0.3.0 采用 **Leader-Worker CLI-native** 架构，通过 ZooKeeper 直连实现分布式任务编排，基于 P→B→V→R→A 责任链模型。

## 设计文档

| 文档 | 内容 |
|------|------|
| `README.md` | 总体概述、架构、数据模型、文件结构 |
| `architecture.md` | 组件交互、Leader/Worker 内部架构、状态机 |
| `role-design.md` | P→B→V→R→A 角色体系、认领权重规则 |
| `leader-design.md` | Leader 工作流程、任务生成、调度决策、TUI |
| `worker-design.md` | Worker 执行流程、5 个 link 模板、跨环节协助 |
| `commands.md` | CLI 命令参考、配置系统、状态流转 |
| `zookeeper-schema.md` | ZK 节点树、Watch 策略、节点生命周期 |

## 实现完成度

- **15/15 CLI 命令** 已实现
- **Leader 模块** 8 个文件已实现，2 个待补充
- **Worker 模块** 已实现
- **9 个 Agent 模板** 已就位
- **3/4 核心模块** 已实现（缺 context-store）

## 待补充项（下个迭代重点）

1. **`modules/context-store.ts`** — 共享键值存储（需 ZK / CLI / modules 三层连通）
2. **`leader/task-generator.ts`** — Claude 驱动任务拆解管线（使用 leader-decompose.md）
3. **`leader/decision-engine.ts`** — Claude 驱动调度决策管线（使用 leader-decide.md）
4. **Context CLI 命令** — `set-context`, `get-context`, `delete-context`, `list-context-keys`

## 实现与设计的差异

1. 新增 `leader/orchestrator.ts`（从 monitor 拆分的 task watch 模块）
2. 新增通用模板 `leader.md` 和 `worker.md`（per-link 模板的回退）
3. 配置键 `command` → `commands.claude-cli`（结构性调整）
4. Schema 中 `TaskStatus` 包含 `in_progress`，`MessageType` 未包含 `help`
5. Task Schema 缺少 `depends_on` / `blocked_by` 字段

## 详细审查报告

见 `review-report.md`。
