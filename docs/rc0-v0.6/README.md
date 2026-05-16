# Claude Orchestrator v0.6 RC0 — 正式发布文档

## 1. 文档定位

本目录是 Claude Orchestrator v0.6 的**正式发布文档（Release Candidate 0）**，作为接下来的验收工作和 v0.7 迭代的基线。所有内容描述的是**当前已实现且通过测试的功能**，不含变更记录或开发过程产物。

与 `docs/v0.6/` 的区别：
- `docs/v0.6/` 是**设计基线**：产品需求/详细设计/核心链路/工作流/测试用例的初版定义，含 `workflow/REVIEW.md` 的内部审计。
- `docs/rc0-v0.6/` 是**验收交付**：基线之上叠加 7 项实现修复后的**完整产品文档**，新增功能矩阵 / 验收 checklist / 已知边界 / 完整运行示例四类专属内容，删除内部审计文档。

## 2. 目录结构

```
docs/rc0-v0.6/
├── README.md                          # 本文件 — 索引 + 阅读路径 + 与 v0.6 关系
├── feature-matrix.md                  # 功能 × 代码位置 × 测试 × 验收 # 五列总表
├── acceptance-checklist.md            # 按功能/链路逐项勾选的端到端验收清单
├── known-boundaries.md                # v0.6 不做、推迟 v0.7 的能力清单
├── prd/
│   └── product-requirements.md        # 产品需求：做什么、为什么做
├── dd/
│   ├── architecture.md                # 架构总览：组件交互、事件总线、状态机
│   ├── contracts.md                   # 类型系统、Zod schema、跨层接口、错误层级、事件
│   ├── protocol.md                    # ZooKeeper Wire-Format
│   ├── zk-schema.md                   # ZK 节点树、数据格式、Watch 策略
│   ├── package-layout.md              # 多包工程分层、依赖矩阵
│   ├── error-and-recovery.md          # 错误模型、恢复状态机、retry 边界
│   ├── config-and-cli.md              # 配置分层、CLI 命令、启动流程
│   ├── execution-runtime.md           # Runner / Template / Hooks 执行层
│   └── workspace-memory.md            # 工作区内容记忆
├── core/
│   ├── core-chain-overview.md         # 五条核心链路总览
│   ├── 01-requirement-to-tasks.md     # 需求 → 拆解 → 任务入队
│   ├── 02-task-claim-and-execute.md   # 认领 → 渲染 → 执行 → 自评估
│   ├── 03-chain-progression.md        # EvalDecision 路由、retry 与 feedback 边界
│   ├── 04-merge-and-close.md          # 合并校验、merge_failed 处理、链关闭
│   └── 05-recovery.md                 # Worker 失联 → 孤儿检测 → 重试/归档
├── workflow/
│   ├── README.md                      # 端到端贯穿样例索引
│   ├── 00-identity-cards.md           # 5 Worker 身份卡
│   ├── 01-tui-input-and-decompose.md  # TUI 输入 + Decompose + ChainDef
│   ├── 02-plan-link.md                # Plan 链节全状态
│   ├── 03-build-link.md               # Build 链节 + commit 失败回退
│   ├── 04-verify-link.md              # Verify 链节
│   ├── 05-review-link.md              # Review 链节
│   ├── 06-accept-and-close.md         # Accept + close_chain + merge_failed
│   └── appendix-state-reference.md    # ZK 路径 / cache 文件 / Schema / hook 速查
└── test-cases/
    ├── test-plan.md                   # 渐进式测试策略
    ├── tc-01-decompose.md
    ├── tc-02-task-lifecycle.md        # 含 commit-failure
    ├── tc-03-chain-progression.md     # 含 retry-ceiling / unresolved-target / evaluator-reject
    ├── tc-04-merge.md                 # 含 merge_failed / builder retry
    ├── tc-05-recovery.md
    └── tc-06-evaluator-fallback.md    # 评估器三连失败一律 reject
```

## 3. 文档层次说明

| 层次 | 定位 | 回答的问题 | 受众 |
|------|------|-----------|------|
| **入口三件套** | RC 索引/总览/验收 | 这次 RC 包含什么、怎么验、不保证什么 | 验收人、PM、QA |
| **PRD** | 产品需求 | 做什么、为什么做 | PM、新成员、架构师 |
| **DD** | 详细设计 | 怎么做、在哪里做 | 开发者、Reviewer |
| **Core** | 核心链路 | 数据如何流转、关键决策点 | 开发者（实现核心流程） |
| **Workflow** | 贯穿样例 | 一次具体运行下每一步的状态切片 | 开发者、新成员、故障排查 |
| **Test Cases** | 测试用例 | 如何验证正确性 | 测试工程师、开发者 |

## 4. 阅读路径

**验收人员**

1. `feature-matrix.md` —— 一览所有功能与对应的验收项编号
2. `acceptance-checklist.md` —— 按勾选项执行端到端验证
3. `known-boundaries.md` —— 明确哪些场景**不**应当被纳入验收
4. 失败时按矩阵指向的 `core/` 或 `workflow/` 文档定位

**新人入门**

1. `prd/product-requirements.md` —— 理解产品定位与核心概念
2. `core/core-chain-overview.md` —— 理解五条核心链路
3. `workflow/README.md` —— 通过分页 API 样例理解一次完整运行
4. 按需阅读 `dd/architecture.md` / `dd/contracts.md`

**实现者**

1. `dd/contracts.md` + `dd/protocol.md` —— 类型与协议规范（权威）
2. `dd/package-layout.md` —— 代码该放哪个包
3. `dd/zk-schema.md` —— ZK 节点操作参考
4. `core/` 下对应链路文档 —— 实现具体流程时参考
5. `dd/error-and-recovery.md` —— 错误边界与 retry 上限

**测试者**

1. `test-cases/test-plan.md` —— 测试策略与方法论
2. `core/core-chain-overview.md` —— 理解被测链路
3. `test-cases/tc-*.md` —— 具体测试用例（tc-01 ~ tc-06）

## 5. 问题排查速查

| 问题 | 查阅 |
|------|------|
| 启动失败 | `dd/config-and-cli.md` §3 / §5 |
| TUI 键盘 / 渲染 | `dd/architecture.md` §2.5 |
| Worker 任务失败 | `core/02-task-claim-and-execute.md` + `workflow/02-plan-link.md` §5.7 |
| 反馈被丢弃 | `core/03-chain-progression.md` §unresolved-target + `dd/error-and-recovery.md` §retry |
| 反馈循环不停 | `dd/error-and-recovery.md` §retry-ceiling（默认 9，`CO_CHAIN_MAX_RETRIES` 覆写） |
| chain_id 报冲突 | `dd/error-and-recovery.md` §chain-id-reuse |
| 评估器反复输出 reject | `dd/error-and-recovery.md` §self-evaluation fallback |
| 合并冲突 / `merge_failed` | `core/04-merge-and-close.md` §merge_failed + `workflow/06-accept-and-close.md` §9.10 |
| commit 失败但任务未完成 | `core/02-task-claim-and-execute.md` §commit-failure |
| ZK 节点状态 | `dd/zk-schema.md` |
| 类型 / 接口 | `dd/contracts.md`（权威） |
| 代码归属 | `dd/package-layout.md` |

## 6. RC0 与 docs/v0.6 的实质性差异

本 RC 在 `docs/v0.6/` 基础上做的实质性更新（每项均已在代码层落地，见 `feature-matrix.md` 第二区"P0/P1 修复"）：

| 模块 | 更新 |
|------|------|
| `dd/contracts.md` | 新增 `ChainStatus.merge_failed`、`ChainManifest.{total_retry_count, max_total_retries}`、`ChainConflictError`、`CommitFailedError`、`chain_merge_failed` 事件；evaluator fallback 改为 reject-only |
| `dd/error-and-recovery.md` | 新增 §retry-ceiling、§merge_failed-handling、§chain-id-reuse、§commit-failure-feedback 四节 |
| `dd/config-and-cli.md` | 校正 CLI 实际命令为 `run` + `config`（v0.6 误声"13 命令"已修正）；`--worker` 默认 6、最小 6；新增 `CO_CHAIN_MAX_RETRIES` 环境变量 |
| `core/02-task-claim-and-execute.md` | 新增 commit 失败 → 强制 feedback 子流程 |
| `core/03-chain-progression.md` | 新增 retry-ceiling / unresolved-target / evaluator-reject 三个边界路径 |
| `core/04-merge-and-close.md` | 重写 close_chain 分支：失败合并 → `merge_failed` 状态 + builder 重试 |
| `workflow/03-build-link.md` | commit 失败回退路径细化 |
| `workflow/06-accept-and-close.md` | merge_failed 分支细化、retry-ceiling 边界 |
| `workflow/appendix-state-reference.md` | manifest schema 增列两字段、状态枚举增 merge_failed |
| `test-cases/tc-02 / tc-03 / tc-04` | 增加对应缺陷用例 |
| `test-cases/tc-06`（新增） | evaluator 三连失败一律 reject |
| `workflow/REVIEW.md` | 删除（内部审计文档，非产品文档；其设计边界条目并入 `known-boundaries.md`） |

`docs/v0.6/` 保留不动，作为历史基线。
