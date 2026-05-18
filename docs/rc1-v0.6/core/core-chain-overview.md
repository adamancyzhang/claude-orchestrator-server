# Core Chain Overview — v0.6 核心链路总览（融合 git worktree）

> **文档定位**：rc1-v0.6 在 rc0 核心链路全景之上叠加 git worktree 关键节点。本文同时给出"跨链路 commit 数据流"，让读者一眼看清：双轨提交（项目仓 + CO root）如何在五条链路之间传递、如何驱动 pre-task rebase、最终如何用单次合并收口。

## 1. 五条核心链路

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         核心链路全景                                       │
│                                                                         │
│   链路 1: 需求 → 任务                                                    │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ TUI 输入  │───▶│ Decompose│───▶│ ChainDef │───▶│ Push 5 + │          │
│   │ 用户需求  │    │ 拆解需求  │    │ JSON     │    │ openChain│          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
│                                                                         │
│   链路 2: 任务认领 → 执行（含 git worktree 节点）                          │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ Claim +  │───▶│ Pre-task │───▶│ Render + │───▶│ Worktree │          │
│   │ Dispatch │    │ Rebase   │    │ Claude   │    │ + Docs   │          │
│   │          │    │ (upstream│    │ Execute  │    │ Commits  │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
│                                                                         │
│   链路 3: 责任链推进（含 commits 沿链路传递）                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ Eval     │───▶│ Record   │───▶│ Collect  │───▶│ Activate │          │
│   │ Decision │    │ Link     │    │ Upstream │    │ Next +   │          │
│   │ + commits│    │ Commits  │    │ Commits  │    │ Dispatch │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
│                                                                         │
│   链路 4: close_chain → 单次合并 → 关闭                                  │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ close_   │───▶│ Merge    │───▶│ Single   │───▶│ Chain    │          │
│   │ chain    │    │ Validator│    │ Merge    │    │ Closed   │          │
│   │ on accept│    │ (execFile│    │ accept-  │    │ /Failed  │          │
│   │          │    │ Sync)    │    │ branch   │    │          │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
│                                                                         │
│   链路 5: 恢复（含 worktree 复用清理）                                    │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ Worker   │───▶│ Orphan   │───▶│ Retry    │───▶│ Reuse    │          │
│   │ Lost     │    │ Detect   │    │ or       │    │ Worktree │          │
│   │          │    │          │    │ Archive  │    │ +reset   │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. 链路关系

```
链路 1 (需求→任务) ─── openChain + 派 plan 任务（upstream_commits = {}）
    │
    ▼
链路 2 (认领→执行) ◄──────────────────────────┐
    ├─ pre-task rebase (immediate predecessor) │
    ├─ Claude execute                          │
    └─ worktree commit + docs commit           │
    │                                          │
    ▼                                          │
链路 3 (责任链推进)                              │
    ├─ recordLinkCommit ── manifest.link_commits│
    ├─ activate_next ── collectUpstreamCommits ─┘
    ├─ feedback ── clearLinkCommitsFrom（清理被反馈 link 及其下游 commit）
    ├─ reject ── 链失败终止
    └─ close_chain ──→ 链路 4

链路 4 (close_chain → 合并)
    └─ runCloseChainMerge：merge_validator.validate(accept-link 单分支)
        ├─ 成功 → closeChain("completed")
        └─ 失败 → closeChain("merge_failed") + pushMergeConflictRetries

链路 5 (恢复) —— 任何时候 Worker 失联时触发，与链路 1-4 并行
    └─ 重启走 initializeWorktrees → reset --hard <leaderHEAD> + clean -fdq
```

## 3. 链路速查

| 链路 | 文档 | 入口 | 出口 | git 关键节点 |
|------|------|------|------|-------------|
| 1. 需求→任务 | `01-requirement-to-tasks.md` | TUI 键盘输入 | 4-5 个任务入 pending + chain manifest `openChain` | 首派 plan 任务携 `upstream_commits = {}` |
| 2. 认领→执行 | `02-task-claim-and-execute.md` | ZK 消息到达 | EvalDecision JSON（含 `commits` 字段） | pre-task rebase + 项目仓 commit + CO root docs commit |
| 3. 链推进 | `03-chain-progression.md` | 完成报告到达 Leader | 下一 link 激活 或 链终结 | `recordLinkCommit` 入 manifest；`collectUpstreamCommits` 注入下游 dispatch；feedback 调 `clearLinkCommitsFrom` |
| 4. close_chain → 合并 | `04-merge-and-close.md` | accepter close_chain | 单次合并 accept 分支 → main + 关闭链 | `runCloseChainMerge` 读 manifest.link_commits.accept → `merge_validator.validate` 一次完成 |
| 5. 恢复 | `05-recovery.md` | Worker EPHEMERAL 消失 | 任务重入 pending 或归档 | `initializeWorktrees` 复用时 reset --hard + clean -fdq |

## 4. 跨链路 commit 数据流（rc1 新增视角）

> 关键洞察：**每个 link 完成时记录一对 commit（worktree + docs），下个 link 启动时把上游 link 的 worktree commit 当作 rebase 目标**。这样 plan→build→verify→review→accept 五条独立分支虽然各自在自己的 worktree 上做事，但 pre-task rebase 把它们"串"成了一条线性历史。close_chain 只需合并最末端的 accept 分支即可把整条历史带入 main。

```
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│  PLAN      │  │  BUILD     │  │  VERIFY    │  │  REVIEW    │  │  ACCEPT    │
│ Worker A   │  │ Worker B   │  │ Worker C   │  │ Worker D   │  │ Worker E   │
└─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
      │                │                │                │                │
      │  branch:       │                │                │                │
      │  A-workspace   │                │                │                │
      │   from M0      │                │                │                │
      │  worktree      │                │                │                │
      │  commit: P     │                │                │                │
      │  docs commit:Pd│                │                │                │
      ├─completion ───▶│                │                │                │
      │  commits=      │                │                │                │
      │  {P, Pd, A-br} │                │                │                │
      │                │                │                │                │
      │       Leader.recordLinkCommit(plan,{P,Pd,A-br})  │                │
      │       Leader.collectUpstreamCommits → {plan:P}   │                │
      │       Leader.dispatch(build,upstream_commits={plan:P})            │
      │                │                │                │                │
      │                │  pre-task      │                │                │
      │                │  rebase onto P │                │                │
      │                │  B-workspace:  │                │                │
      │                │  M0→P→B        │                │                │
      │                │  worktree:B    │                │                │
      │                │  docs:Bd       │                │                │
      │                ├─completion ───▶│                │                │
      │                │                │                │                │
      │           Leader.recordLinkCommit(build,{B,Bd,B-br})              │
      │           Leader.collectUpstreamCommits → {plan:P, build:B}       │
      │           Leader.dispatch(verify,upstream_commits={plan:P,build:B})
      │                │                │                │                │
      │                │                │  pre-task      │                │
      │                │                │  rebase onto B │                │
      │                │                │  (immediate    │                │
      │                │                │   predecessor) │                │
      │                │                │  C-workspace:  │                │
      │                │                │  M0→P→B→V      │                │
      │                │                │  ... 以此类推 ...                │
      │                │                │                │                │
      │                │                │                │                │  E-workspace:
      │                │                │                │                │  M0→P→B→V→R→X
      │                │                │                │                │  worktree:X
      │                │                │                │                │  docs:Xd
      │                │                │                │                ├─completion ▶ Leader
      │                │                │                │                │  decision=close_chain
      │                │                │                │                │  commits={X,Xd,E-br}
      │                │                │                │                │
      ▼                ▼                ▼                ▼                ▼
        (Leader 在 close_chain 时只合并 E-br，即 X 这一支，
         其线性历史 M0→P→B→V→R→X 整条进入 mainBranch。)
```

注意：

- **pre-task rebase 的目标永远是 immediate predecessor**（直接上游 link 的 worktree commit），不是逐个回放整条历史。因为每个 worker 都做了同样的 rebase，它本身的 HEAD 已包含所有更上游的 commit。`pickImmediatePredecessor`（`watcher.ts:61-81`）会跳过没有 worktree commit 的 link（例如 plan 给出的是纯文档时 P=null，build 时 immediate predecessor 退化为 null）。
- **docs commit（Pd/Bd/Vd/Rd/Xd）**与 worktree commit 解耦，落在 CO root 仓的独立时间线上，不参与 close_chain 合并。它的作用是把每个 Worker 写的协作文档持久化为可审计的版本快照。
- **feedback 时清理下游 commits**：若 build 给 plan 反馈，Leader 调 `chain_audit.clearLinkCommitsFrom(chainId, "plan")`（`chain-audit.ts:268-289`、`chain-router.ts:1148-1167`）删除 plan/build/verify/review/accept 所有已记录 commit，确保新一轮 plan 完工后下游链路 rebase 到的是新 plan 而非陈旧版本。

## 5. 端到端数据流（携 commit 字段）

```
1. 用户输入 "实现用户认证模块" → TUI → /messages/{leader_id}/msg-NNNNN
2. ChainRouter.route → handleRequirement → 调 claude-cli + worker-decompose.md
3. 输出 ChainDef → handleTaskDefinitions
4. chain_audit.openChain(chain-001) + 4-5 个任务 push 入 pending
5. 派 plan 任务给空闲 planner Tom，task_dispatch.upstream_commits = {}
6. Tom 收到消息 → 无 immediate predecessor（plan link）→ 跳过 rebase
       → 执行 claude-cli + worker-planner-task.md
       → 项目仓 worktree commit P / CO root docs commit Pd
       → self-evaluate → EvalDecision{activate_next, commits:{worktree:P, docs:Pd, branch:Tom-br}}
7. Leader handleCompletionReport
       → recordLinkCommit("plan", {worktree:P, docs:Pd, branch:Tom-br})
       → activate_next 分支：collectUpstreamCommits → {plan:P}
       → 派 build 任务给空闲 builder Jerry，task_dispatch.upstream_commits={plan:P}
8. Jerry 收到 → immediate predecessor = P → preTaskRebase(P)
       → 执行 worker-builder-task.md → 项目仓 commit B / docs commit Bd
       → EvalDecision{activate_next, commits:{worktree:B, docs:Bd, branch:Jerry-br}}
9. ... verify, review 同理（pre-task rebase 目标分别是 B, V）
10. Accepter Jack 完工 → EvalDecision{close_chain, commits:{worktree:X, docs:Xd, branch:Jack-br}}
11. Leader handleCompletionReport (close_chain)
       → recordLinkCommit("accept", {worktree:X, docs:Xd, branch:Jack-br})
       → runCloseChainMerge(chain-001)
       → 读 manifest.link_commits.accept.{worktree:X, branch:Jack-br}
       → merge_validator.validate({sha:X, branch:Jack-br, ...}) 一次合并
       → 成功 → closeChain("completed")
       → 失败 → closeChain("merge_failed") + pushMergeConflictRetries 给每个失败 link
```

## 6. 关键决策点

| 决策点 | 位置 | 可选路径 | 决策依据 |
|--------|------|---------|---------|
| Decompose 方式 | 链路 1 | Leader 自处理 / 转发 Planner | 模板是否已加载 |
| 任务认领 | 链路 2 | 角色匹配优先 / 任意 Worker | `ROLE_WEIGHTS` + priority + FIFO |
| Pre-task rebase 目标 | 链路 2 | immediate predecessor / 无（plan/decompose 跳过） | `pickImmediatePredecessor` (`watcher.ts:61-81`) |
| 链推进方向 | 链路 3 | activate_next / feedback / reject / close_chain | `EvalDecision.decision` |
| 反馈清理范围 | 链路 3 | 清理 prevLink 及其后所有 link_commits | `clearLinkCommitsFrom`（`chain-router.ts:1148-1167`） |
| 合并策略 | 链路 4 | accept 单次合并 / legacy 逐 link | manifest.link_commits.accept 是否存在 |
| 合并失败分类 | 链路 4 | conflict & other → 重试；lock/permission/network → 不重试 | `categorizeMergeError`（`chain-router.ts:884-890`） |
| 孤儿处理 | 链路 5 | retry / archive failed | `retry_count < 3` |
| Worktree 复用 | 链路 5 | reset --hard + clean -fdq / 完全复用 | `reset_on_reuse`（默认 true） |

## 7. 阅读建议

- **理解 git 拓扑** → 先读 `worktree-foundation.md`
- **理解责任链推进** → 链路 2 + 链路 3（携 commit 字段视角）
- **理解收尾合并** → 链路 4（单次合并模型）
- **理解错误恢复** → 链路 5 + `worktree-foundation.md §4` 的复用清理
- **理解全局** → 按链路 1 → 2 → 3 → 4 → 5 顺序阅读
