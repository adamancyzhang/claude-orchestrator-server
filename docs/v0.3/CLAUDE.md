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
- **Leader 模块** 10 个文件已实现
- **Worker 模块** 已实现
- **7 个 Agent 模板** 已就位（2 leader + 5 worker per-link）
- **3/3 核心模块** 已实现（registry / task-queue / message-router）
- **TaskGenerator + DecisionEngine** Claude 驱动管线已集成

## 已移除的设计内容

- **context-store** — 共享键值存储不在架构设计中体现，已从所有设计文档移除
- **leader.md / worker.md 通用模板** — 无回退模板概念，仅保留 per-link 模板

## 待补充项（下个迭代）

1. **TaskGenerator / DecisionEngine 端到端测试** — 验证完整的需求→任务链→Worker→决策闭环
2. **Leader 启动孤儿扫描** — 已集成到 `leader/recovery.ts` 的 `scanOrphans()`，待 E2E 测试覆盖

## 实现与设计的差异

1. 新增 `leader/orchestrator.ts`（从 monitor 拆分的 task watch 模块）
2. 配置键 `command` → `commands.claude-cli`（结构性调整）
3. ~~Schema 中 `TaskStatus` 包含 `in_progress`~~ 已移除（2026-05-12）
4. ~~Task Schema 缺少 `depends_on` / `blocked_by`~~ 已添加（2026-05-12）
5. ~~`MessageType` 未包含 `help`~~ 已添加（2026-05-12）
6. **TUI 支持键盘输入**（2026-05-12） — TUI 从纯只读展示升级为支持键盘输入，用户可在输入框中输入文本，按 Enter 将消息以 ZK 消息形式发送到 Leader 自身队列，经 LeaderWatcher 分流至 TaskGenerator 拆解为任务链
7. **LeaderWatcher 三分支消息分流**（2026-05-12） — 消息处理从单一的 Claude 执行改为三分支：DecisionEngine（Worker 完成报告，带 link）、TaskGenerator（通用消息/用户输入，拆解为任务链）、直接 Claude 执行（回退）。LeaderWatcher 构造函数新增 `taskGenerator` 参数
8. **日志前缀规范化**（2026-05-12） — 使用 `[Exec]` 前缀标识 Shell 命令执行（`src/utils/exec.ts`），使用 `[Watcher]` 前缀标识消息接收与处理（`src/worker/watcher.ts`、`src/leader/watcher.ts`）

## 详细审查报告

见 `review-report.md`。
