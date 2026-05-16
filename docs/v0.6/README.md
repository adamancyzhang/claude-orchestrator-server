# Claude Orchestrator v0.6 — 设计文档

## 版本目标

Claude Orchestrator v0.6 在 v0.5 的 CLI 原生、ZooKeeper 直连的多 Agent 编排系统基础上，将设计文档按关注点分离为四个层次：产品需求（PRD）、详细设计（DD）、核心链路设计（Core）、测试用例（Test Cases）。

## 文档结构

```
docs/v0.6/
├── README.md                           # 本文件 — 文档索引与阅读路径
├── prd/
│   └── product-requirements.md         # 产品需求文档：是什么、为什么
├── dd/
│   ├── architecture.md                 # 架构总览：组件交互、事件总线、状态机
│   ├── zk-schema.md                    # ZooKeeper 节点树、数据模型、Watch 策略
│   ├── contracts.md                    # 类型系统、Zod Schema、跨层接口
│   ├── protocol.md                     # ZK Wire-Format 协议规范
│   ├── package-layout.md               # 多包工程分层、依赖矩阵
│   ├── error-and-recovery.md           # 错误模型与恢复状态机
│   ├── config-and-cli.md               # 配置分层与 CLI 命令参考
│   ├── execution-runtime.md            # Runner / Template / Hooks 执行层
│   └── workspace-memory.md             # 工作区内容记忆（与源码树同构）
├── core/
│   ├── core-chain-overview.md          # 核心链路总览
│   ├── 01-requirement-to-tasks.md      # 链路 1：用户输入 → 需求拆解 → 任务入队
│   ├── 02-task-claim-and-execute.md    # 链路 2：任务认领 → 模板渲染 → 执行 → 自评估
│   ├── 03-chain-progression.md         # 链路 3：完成报告 → 机械路由 → 激活下一环节
│   ├── 04-merge-and-close.md           # 链路 4：合并验证 → 分支合并 → 链关闭
│   └── 05-recovery.md                  # 链路 5：Worker 失联 → 孤儿检测 → 重试/归档
└── test-cases/
    ├── test-plan.md                    # 测试策略：渐进式方法、环境、数据准备
    ├── tc-01-decompose.md              # 测试：需求拆解链路
    ├── tc-02-task-lifecycle.md         # 测试：任务生命周期链路
    ├── tc-03-chain-progression.md      # 测试：责任链推进链路
    ├── tc-04-merge.md                  # 测试：合并验证链路
    └── tc-05-recovery.md               # 测试：孤儿恢复链路
```

## 文档层次说明

| 层次 | 定位 | 回答的问题 | 受众 |
|------|------|-----------|------|
| **PRD** | 产品需求 | 做什么、为什么做 | PM、新成员、架构师 |
| **DD** | 详细设计 | 怎么做、在哪里做 | 开发者、 Reviewer |
| **Core** | 核心链路 | 数据如何流转、关键决策点 | 开发者（实现核心流程） |
| **Test Cases** | 测试用例 | 如何验证正确性 | 测试工程师、开发者 |

## 阅读路径

**新人入门**

1. `prd/product-requirements.md` — 理解产品定位与核心概念
2. `core/core-chain-overview.md` — 理解五条核心链路
3. `dd/architecture.md` — 理解组件交互
4. 按需阅读 `core/` 下的具体链路设计

**实现者**

1. `dd/contracts.md` + `dd/protocol.md` — 类型与协议规范（权威来源）
2. `dd/package-layout.md` — 代码该放哪个包
3. `dd/zk-schema.md` — ZK 节点操作参考
4. `core/` 下对应链路文档 — 实现具体流程时参考

**测试者**

1. `test-cases/test-plan.md` — 测试策略与方法论
2. `core/core-chain-overview.md` — 理解被测链路
3. `test-cases/tc-*.md` — 具体测试用例

**问题排查**

| 问题 | 查阅 |
|------|------|
| TUI / 键盘交互 | `dd/architecture.md` §Leader TUI |
| Worker 任务失败 | `core/02-task-claim-and-execute.md` |
| 合并冲突 | `core/04-merge-and-close.md` |
| 启动异常 | `dd/config-and-cli.md` |
| ZK 节点状态 | `dd/zk-schema.md` |
| 错误恢复 | `dd/error-and-recovery.md`（权威）、`core/05-recovery.md` |
| 类型 / 接口 | `dd/contracts.md`（权威） |
| 代码归属 | `dd/package-layout.md` |

## 与 v0.5 的对应关系

| v0.5 文档 | v0.6 归属 |
|-----------|----------|
| README.md | 拆分到 `prd/` + `dd/architecture.md` |
| CLAUDE.md | `README.md`（本文档） |
| architecture.md | `dd/architecture.md` + `dd/error-and-recovery.md` |
| orchestration.md | `dd/config-and-cli.md`（启动流程） |
| leader-design.md | `dd/architecture.md` + `core/03-chain-progression.md` + `core/04-merge-and-close.md` |
| worker-design.md | `dd/architecture.md` + `core/02-task-claim-and-execute.md` |
| worktree-and-identity.md | `dd/execution-runtime.md`（身份注入）+ `dd/config-and-cli.md` |
| role-design.md | `prd/product-requirements.md` |
| commands.md | `dd/config-and-cli.md` |
| zookeeper-schema.md | `dd/zk-schema.md` |
| execution-runtime.md | `dd/execution-runtime.md` |
| contracts.md | `dd/contracts.md` |
| protocol.md | `dd/protocol.md` |
| error-and-recovery.md | `dd/error-and-recovery.md` + `core/05-recovery.md` |
| package-layout.md | `dd/package-layout.md` |
