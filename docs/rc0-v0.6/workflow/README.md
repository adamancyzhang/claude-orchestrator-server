# Workflow — Leader × Worker × claude-cli 端到端贯穿样例

> **本目录定位**：基于 `packages/` 源码 + `templates/agents/` 模板，用**一个具体需求样例**（"为 REST API /api/users 增加分页支持"）贯穿 Leader、5 个 Worker、claude-cli 的完整运行。每一步固化"生成了什么文件 / ZK 节点是什么状态 / 消息体长什么样 / 任务是如何被调度和认领的 / 调用了什么模板 / 对应到哪段代码"。
>
> **使用方式**：作为 RC0 验收的可视化参考（与 `acceptance-checklist.md` 配套）；故障排查时按步骤定位偏离点；二次开发模板/链路前，先读本目录看现状，再到 `core/` 看设计意图、`dd/` 看类型协议。

## 贯穿样例

- **需求**：`为 REST API /api/users 增加分页支持，支持 page/page_size 参数，默认 page=1/page_size=20`
- **chain_id**：`chain-pagination-001`
- **运行假设**：以 `node dist/index.js run --worker 5` 启动，5 个 Worker 分别担任 5 个角色，名称按 20 人名池抽取为 `Tom / Jerry / Lucy / Mia / Leo`。
- **Leader 实例**：`name=Leader`, `instance_id=leader-01`。
- **持久化根**：`~/.claude-orchestrator/projects/leader-01/` —— 下含 `chains/<chain_id>/`、`tasks/<task_id>/`、`messages/<message_id>/`、`docs/<worker>/<date>/` 四个子目录。路径函数集中在 `packages/contracts/src/paths/cachePaths.ts`。

完整 Worker 实例化见 `00-identity-cards.md`。

## 整体步骤一览（10 步跨 8 个文件）

| Step | 角色 / 子系统 | 行为 | 文档 |
|------|--------------|------|------|
| 0 | 系统启动 | Leader + 5 Worker 完成 worktree、ZK 注册、watch 建立 | `00-identity-cards.md` |
| 1 | 用户 → TUI | 键入需求文本，按 Enter | `01-tui-input-and-decompose.md` §1 |
| 2 | Leader / Watcher | ZK 写入 `messages/{leader}/msg-*`、Watcher 捕获 | `01` §2 |
| 3 | ChainRouter | 路由判定：自由文本 → `handleRequirement` | `01` §3 |
| 4 | Leader 自处理 decompose | 渲染 `worker-decompose.md` → claude-cli → ChainDef JSON | `01` §4 |
| 5 | ChainRouter | 解析 ChainDef → push 5 个任务 → 派发首任务（plan）给 Planner | `01` §5 |
| 6 | Planner (Tom) | Plan 任务全流程：模板渲染 → claude-cli → commit → 自评估 → 完成报告 | `02-plan-link.md` |
| 7 | Builder (Jerry) | Build 任务全流程，活化由 Plan 的 `activate_next` 触发 | `03-build-link.md` |
| 8 | Verifier (Lucy) | Verify 任务全流程 | `04-verify-link.md` |
| 9 | Reviewer (Mia) | Review 任务全流程 | `05-review-link.md` |
| 10 | Accepter (Leo) | Accept 任务 + EvalDecision `close_chain` + 链关闭 + 合并校验 | `06-accept-and-close.md` |

## 文档清单

| 文件 | 内容 |
|------|------|
| `README.md` | 本文件 |
| `00-identity-cards.md` | 5 个 Worker 身份卡（基础信息、注入方式、能力边界、典型产出、role-link 权重） |
| `01-tui-input-and-decompose.md` | Step 1–5：TUI 输入 → ChainRouter → decompose → ChainDef → 5 任务入队 |
| `02-plan-link.md` | Step 6 详细子流程（5.1–5.9）：Plan 任务的认领、模板、执行、commit、评估、回报、激活下一环 |
| `03-build-link.md` | Step 7：Build 链环节差异化内容 |
| `04-verify-link.md` | Step 8：Verify 链环节差异化内容 |
| `05-review-link.md` | Step 9：Review 链环节差异化内容 |
| `06-accept-and-close.md` | Step 10：Accept 链环节 + close_chain + MergeValidator |
| `appendix-state-reference.md` | ZK 路径 / cache 文件路径 / Schema / link-template-role 对照 / hook 事件 速查 |

## 与其他文档层的关系

| 层 | 回答 | 与本目录的关系 |
|----|------|--------------|
| `prd/` | 做什么、为什么做 | 本目录提供"是什么"的具体化 |
| `dd/contracts.md` `dd/protocol.md` `dd/zk-schema.md` | 类型 / wire-format / ZK Schema（权威） | 本目录给出实例化 JSON，应能被 Schema 校验通过 |
| `dd/architecture.md` `dd/execution-runtime.md` | 组件如何交互、执行层细节 | 本目录给出具体一次运行下各组件协作时的状态切片 |
| `core/01~05` | 五条核心链路的抽象描述 | 本目录是 `core/` 的"具体化注释版" |
| `test-cases/` | 验证策略 | 本目录的步骤可作为人工对照表 |

