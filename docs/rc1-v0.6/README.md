# Claude Orchestrator v0.6 RC1 — 核心链路融合 Git Worktree 设计

## 1. 文档定位

本目录是 Claude Orchestrator v0.6 的**第二份候选发布文档（Release Candidate 1）**，聚焦把 git worktree 工作流融入核心责任链的描述。

| 文档版本 | 角色 |
|---------|------|
| `docs/v0.6/` | 设计基线（最初定义） |
| `docs/rc0-v0.6/` | 已验收发布文档：含完整 PRD / DD / Core / Workflow / Test Cases / Acceptance；含 `git-worktree-evaluation.md` 评估报告 |
| `docs/rc1-v0.6/`（本目录） | **rc0 之上的核心链路增量发布**：只重写"核心链路 + worktree 基础"，其余文档**与 rc0 联读**——`prd/`, `dd/`, `workflow/`, `test-cases/`, `feature-matrix.md`, `acceptance-checklist.md`, `known-boundaries.md` 仍以 rc0 为权威 |

为什么只重写一部分：rc0 评估报告（`docs/rc0-v0.6/git-worktree-evaluation.md`）中提出的工作流建议——pre-task rebase + Leader 双轨提交（worktree + docs）+ 单次合并 accept 分支——已在代码层落地，但 rc0 的核心链路文档仍描述旧模型。rc1 的边界严格限于"把已落地的 worktree 工作流融入核心链路文档"，不动 PRD / DD / 测试矩阵。

## 2. 目录结构

```
docs/rc1-v0.6/
├── README.md                            # 本文件
├── worktree-foundation.md               # 双仓库模型 + 启动初始化 + 分支命名 + git 命令安全姿势
└── core/
    ├── core-chain-overview.md           # 五链全景 + worktree 节点叠加 + 跨链路 commit 数据流
    ├── 01-requirement-to-tasks.md       # 链路 1（含 chain manifest 初始化与空 upstream_commits）
    ├── 02-task-claim-and-execute.md     # 链路 2（含 pre-task rebase + 双轨提交）
    ├── 03-chain-progression.md          # 链路 3（含 recordLinkCommit + collectUpstreamCommits + clearLinkCommitsFrom）
    ├── 04-merge-and-close.md            # 链路 4（单次合并 accept 分支 + merge_failed 重试）
    └── 05-recovery.md                   # 链路 5（含 worktree 复用清理 + rc1 新增错误类清单）
```

## 3. 与 rc0-v0.6 的实质差异

| 模块 | rc0 描述 | rc1 改写 |
|------|---------|---------|
| **核心链路 2** | 8 步：Claim → 模板 → claude-cli → 自动 commit → 自评估 → 完成报告 | 12 步：插入 **pre-task rebase**（Step 4）与 **docs commit**（Step 8.2）；完成报告携带 **`commits` envelope**（worktree + docs + branch） |
| **核心链路 3** | EvalDecision 路由 + activate_next 找下游 worker + feedback 退到上游 worker | 新增 **`recordLinkCommit` 写 chain manifest**、**`collectUpstreamCommits` 注入下游 task_dispatch**、**feedback 时 `clearLinkCommitsFrom` 清理被反馈 link 及其下游 commit 记录** |
| **核心链路 4** | MergeValidator 调 claude-cli 逐 link 合并；冲突 abort | 单次合并 accept-link 分支（pre-task rebase 已构造线性历史）；`MergeValidator` 全部 git 命令改为 `execFileSync` 数组形式（封堵 shell 注入）；`isCommitMerged` 改用 `merge-base --is-ancestor`（修复 rc0 评估报告 Bug-1）；新增 `merge_target_branch` 与 `remote` 配置；失败按 `MergeConflictError` / `WorktreeLockedError` / `GitPermissionError` / `GitNetworkError` / `other` 五类分流，仅 conflict + other 触发重试 |
| **核心链路 5** | Worker 失联 → 孤儿检测 + retry/archive | 主体不变；新增 **worktree 复用注记**（`reset --hard <leaderHEAD> + clean -fdq`，复用时**有损清理**未提交工作）+ **rc1 新增错误类清单**（4 个新错误类暂以本文为补丁文档，rc2 拟并入 `dd/error-and-recovery.md`） |
| **worktree 基础** | 散落在 `dd/architecture.md` / `git-worktree-evaluation.md` 等多处 | 一处写清：双仓库（项目仓 A + CO root 仓 B）、分支命名、启动初始化路径、DocsCommitter 并发安全设计、git 命令安全姿势、可配置项 |

## 4. 阅读路径

**新人入门**

1. `worktree-foundation.md` —— 先建立"双仓库 + 双轨提交"的拓扑认知
2. `core/core-chain-overview.md` —— 看清五链如何串接，特别是跨链路 commit 数据流
3. 按 1 → 2 → 3 → 4 → 5 顺序读 `core/0X-*.md`

**已读过 rc0 的实现者**

1. 跳过 `worktree-foundation.md §1-3`（与 rc0 概念一致），直接看 `§4-5`（reset-on-reuse + DocsCommitter）
2. `core/02-task-claim-and-execute.md §3`（pre-task rebase）
3. `core/03-chain-progression.md §3, §4.2, §5.2`（recordLinkCommit + collectUpstreamCommits + clearLinkCommitsFrom）
4. `core/04-merge-and-close.md` —— 全文重写，建议通读
5. `core/05-recovery.md §2, §4`（复用清理 + 新错误类）

**验收人员**

1. `docs/rc0-v0.6/feature-matrix.md` + `acceptance-checklist.md` 仍是权威（rc1 未改动）
2. 与 worktree 相关的功能在执行验收时对照本目录的 `core/*.md` 描述判定行为是否符合预期

**故障排查**

- 链路相关问题请优先看本目录对应 `core/0X-*.md` 的"错误处理"节
- 类型契约 / 错误类层级 / ZK 节点结构 / 配置项细节继续看 `docs/rc0-v0.6/dd/*`

## 5. 问题排查速查（rc1 worktree 维度追加）

| 问题 | 查阅 |
|------|------|
| Pre-task rebase 冲突 | `core/02-task-claim-and-execute.md §3.3` |
| Worktree commit 失败 | `core/02-task-claim-and-execute.md §8`（commit-failure 分支，rc0 R-01 行为） |
| Docs commit 失败 / 看不到 docs commit | `core/02-task-claim-and-execute.md §6.2`；docs commit 是 best-effort，失败仅 log warn |
| 下游 link rebase 到陈旧 commit | `core/03-chain-progression.md §5.3`（feedback 时 `clearLinkCommitsFrom` 行为） |
| close_chain 成功但 main 无变化 | `core/04-merge-and-close.md §10` 错误处理表最后一行（无 accept-link commit 落 legacy 路径） |
| `merge_failed` 状态 / merge-conflict-fix retry | `core/04-merge-and-close.md §6` |
| `WorktreeLockedError` / `GitPermissionError` / `GitNetworkError` 不重试 | `core/04-merge-and-close.md §6`；`core/05-recovery.md §4` |
| Leader 重启抹掉了 worktree 内的工作 | `core/05-recovery.md §2`（reset-on-reuse 有损清理是设计行为） |
| 想关闭复用清理 | `worktree-foundation.md §7`（`reset_on_reuse=false`，仅测试场景） |
| 想合并到非启动分支 | `worktree-foundation.md §7`（`git.merge_target_branch` 配置） |
| 想关闭 / 启用 fetch | `worktree-foundation.md §7`（`git.remote` 配置） |

非 worktree 维度的问题速查参见 `docs/rc0-v0.6/README.md §5`。

## 6. 关于 rc0 的 `git-worktree-evaluation.md`

`docs/rc0-v0.6/git-worktree-evaluation.md` 是 rc0 阶段的问题评估报告，识别了 2 个严重 Bug 与 5 个设计缺口，并在 §10 提出推荐工作流。**该报告里所有问题与所提建议在 rc1 实现层均已落地**——本目录与代码即是落地后的描述。该评估报告作为历史记录留在 rc0 目录不动，rc1 不复制其内容；如对设计动机感兴趣可回看作背景，对当前行为以本目录为准。

## 7. 已知边界（rc1 视角）

| 边界 | 描述 |
|------|------|
| `dd/error-and-recovery.md` 缺失 4 项错误类 | rc0 文档的错误类层级表尚未包含 `RebaseConflictError` / `WorktreeLockedError` / `GitPermissionError` / `GitNetworkError`；rc1 暂以 `core/05-recovery.md §4` 作为补丁文档；rc2 拟并入 `dd/` |
| Leader 断点续传 | v0.6 不实现 Leader 重启后续接 chain 推进；Leader 重启后未关闭的 chain 需用户手动处理（rc0 已述边界，rc1 行为不变） |
| Worktree 复用清理是**有损的** | 上次未提交的工作会被一次性抹掉；不暴露生产开关；详见 `core/05-recovery.md §2` |
| 无 `git push` | 所有合并仅在本地；用户需自行决定是否 push 到 remote（rc0 已述） |
| `requirement.md` 不入 docs commit | Leader 直接 `fs.writeFile` 到 `<co_root>/chains/<chain_id>/requirement.md`，不走 docs commit 通道；不会被版本化 |
| `accept-link` 无 worktree commit 时走 legacy 路径 | `runCloseChainMerge` 落 `runMergeValidation`；内存 commits 也为空时 chain 标 `completed` 但 main 无变化；详见 `core/04-merge-and-close.md §10` |

## 8. 反馈与下一步

rc1 的范围严格限于核心链路与 worktree 基础。若在使用中发现以下情形，建议提到 rc2 处理：
- `dd/error-and-recovery.md` 整体随新错误类的同步更新
- `workflow/` 端到端样例需要按 worktree 节点叠加重写
- `feature-matrix.md` 增加 worktree 维度的功能/测试映射

rc1 验收路径完全沿用 rc0 的 `acceptance-checklist.md`——即除"核心链路描述准确性"维度外，所有验收项保持不变。
