# Worktree Foundation — 双仓库模型与启动初始化

> **文档定位**：rc1-v0.6 在 rc0 基础上将 git worktree 工作流融入核心链路。本文一处写清"链路下面的 git 拓扑"——双仓库 / 分支命名 / 启动初始化 / 双轨提交并发安全 / git 命令安全姿势 / 可配置项。`core/*` 各链路文档默认读者已掌握本文内容。

## 1. 双仓库模型

CO 实例运行时同时操作两个独立的 git 仓库：

| 仓库 | 路径 | `.git` 共享性 | 分支模型 | 工作目录 | 谁写入 |
|------|------|--------------|---------|---------|--------|
| **A. 项目仓** | `<project_root>` 及其下 `.claude-orchestrator/worktree/<Name>/` | 所有 worktree 共享同一个 `.git` 目录（git worktree 标准模式） | 每 Worker 独立分支 `claude-orchestrator/<Name>-workspace`；Leader 在启动分支（merge target） | 每 Worker 独立 worktree | Worker 在自己的 worktree 内做代码变更并提交 |
| **B. CO root 实例仓** | `<projects_root>/<leader_id>/`（默认 `~/.claude-orchestrator/projects/<leader_id>/`） | 单一 `.git`，所有 Worker + Leader 共享同一工作目录 | 仅默认分支 | 共享一个工作目录与 `.git/index` | 每 Worker 只写 `docs/<worker_name>/...` 子目录，自己 commit |

代码锚点：

- 项目仓 worktree 创建：`packages/orchestrator/src/worktree-initializer.ts:48-50, 153-266`
- CO root 创建：`packages/orchestrator/src/co-root-initializer.ts`
- 子进程切换工作目录：`packages/orchestrator/src/child-boot.ts`（`process.chdir(worktree_path)`）

两个仓库**互不依赖**：项目仓存交付物（代码变更），CO root 仓存协作产物（每 Worker 写的 `docs/<Name>/...` 文档与会话日志）。Leader 不会跨仓库做联合提交，也不会把任一仓库 push 到 remote（v0.6 设计选择）。

## 2. 分支命名

| 角色 | 分支 |
|------|------|
| Leader | 启动时 `git rev-parse --abbrev-ref HEAD` 捕获的分支（通常是 `main` 或开发分支） |
| Worker `<Name>` | `claude-orchestrator/<Name>-workspace` |

分支命名函数：`getWorktreeBranch(name)` (`worktree-initializer.ts:48-50`)。`<Name>` 取自 `BUILTIN_NAMES` 表（Tom/Jerry/Lucy/…），用尽后走 `generateFallbackNames` 兜底（`worktree-initializer.ts:26-31, 92-110`）。

合并目标分支默认为"启动时 HEAD"，可通过 `git.merge_target_branch` 配置显式覆写（`packages/contracts/src/config.ts` `git` 节）——典型场景是用户在 `feature/x` 分支跑 orchestrator 但希望合并到 `main`。

## 3. 启动初始化路径

`packages/orchestrator/src/run.ts:90-200` 的 Phase 1-2 串行：

```
ensureCleanWorkspace(projectRoot)              # run.ts:97, 318
  └─ git status --porcelain 必须为空，否则中止
commitInitFiles(projectRoot, logger, opts)     # run.ts:111, 338
  └─ 写 .claude-orchestrator/config.json 等 init 文件
  └─ 默认 git add + commit；auto_commit_init_files=false 可关闭
initializeWorktrees({...})                     # run.ts:117, worktree-initializer.ts:153
  ├─ scanExistingNames → generateWorkerNames
  ├─ 每个 Worker:
  │    ├─ 已存在 worktree → reset --hard <leaderHEAD> + clean -fdq（reset_on_reuse=true，§5）
  │    └─ 不存在 → mkdir + `git worktree add <relative> -b <branch>` + seedWorktreeAssets
  └─ saveProjectWorktreeConfig（持久化 Worker 名/分支/instance_id）
ensureCoRoot({projects_root, leader_id})       # run.ts:157, co-root-initializer.ts
  └─ 单一仓 git init；可选 auto_commit_init_files；后续被 Worker DocsCommitter 写入
```

`seedWorktreeAssets`（`worktree-initializer.ts:268-323`）把以下三类文件拷入新 worktree：

| 文件 | 目标位置 | 用途 |
|------|---------|------|
| `templates/agents/*.md` | `<wt>/.claude-orchestrator/agents/` | Worker 与 Leader 共用的 prompt 模板 |
| `skills/<skill>/SKILL.md` | `<wt>/.claude/skills/<skill>/` | claude-cli skill 资源 |
| `templates/claude-memory/team-claude.md` | `<wt>/CLAUDE.md` | 团队共享身份与责任链协议 |
| `templates/claude-memory/personal-claude-<role>.md` | `<wt>/.claude-orchestrator/docs/<Name>/CLAUDE.md` | 角色专属人格 / 偏好（替换 `{{name}}` `{{role}}` 占位符） |

## 4. Worktree 复用与脏态清理

`initializeWorktrees` 在检测到 worktree 已存在时（`worktree-initializer.ts:177-201`）：

1. 若 `reset_on_reuse=true`（默认）且能拿到 `leaderHEAD`，对该 worktree 执行：
   - `git reset --hard <leaderHEAD>`
   - `git clean -fdq`
2. 任一步失败：仅 `logger.warn`，**继续启动**，不阻塞 Worker 上线。
3. `reset_on_reuse=false`（测试场景）：完全跳过清理，沿用上次退出时的 HEAD 状态。

**重要行为约定**：复用清理是**有损**的——任何上次未提交的工作（dirty index / untracked files in worktree）都会被一次性抹掉。这是修复 rc0 评估报告 Issue-6 的代价，运行人员必须知晓。`core/05-recovery.md §2` 重申了这一点。

## 5. CO root 仓的并发安全：DocsCommitter

CO root 是**所有 Worker 共享的同一工作目录与同一 `.git/index`**。直接让多个 Worker 各自 `git add -A && git commit` 会因 index 共享而"串味"。`WorkerDocsCommitter`（`packages/worker/src/docs-committer.ts:46-130`）用两层保护规避：

1. **scope 收缩**：`git status --porcelain -- docs/<worker_name>`、`git add -- <paths>` 只触及该 Worker 自己的子目录。
2. **`--only` 提交**：`git commit --only -F <msg-file> -- <paths>` 强制只把列出的路径打包进 commit，忽略 index 中其余条目；`.git/index.lock` 是 git 自身的跨进程互斥保证。

```ts
// docs-committer.ts:91-106
execFileSync("git", ["add", "--", ...paths], { cwd: co_root });
execFileSync("git", ["commit", "--only", "-F", msgFile, "--", ...paths], {
  cwd: co_root,
});
```

DocsCommitter 失败是 **best-effort**：log + 返回 null，不会传播到 worktree commit 或完成报告。因此即便 CO root 暂时不可写（磁盘满 / 权限错），Worker 仍能完成 link 任务（项目仓 commit 与 EvalDecision 不受影响）。

## 6. Git 命令安全姿势

rc1 起本仓库所有 git 调用一律使用 `execFileSync(["git", ...args])` 的**数组形式**，不再字符串拼接：

| 文件 | 函数 |
|------|------|
| `packages/orchestrator/src/worktree-initializer.ts:60-69, 192-193` | `execGitArgs` |
| `packages/worker/src/commit-checker.ts` | `git status / add / commit` |
| `packages/worker/src/docs-committer.ts:60-129` | `git status / add / commit / rev-parse` |
| `packages/worker/src/watcher.ts:732-818` | `git merge-base / fetch / rebase` |
| `packages/leader/src/merge-validator.ts:166-196` | `git merge-base / rev-parse / checkout / merge / abort / diff` |

claude-cli **仅**用于生成 commit message（`worker-commit-message.md`）与生成 merge 决策（`worker-merge-decision.md`），不再让 LLM 直接执行任何 git 状态变更命令。这一约束封堵了 rc0 评估报告 Bug-2（merge `-m` 字符串注入）以及让 LLM "自由发挥"改 `git add -A` 之类风险。

## 7. 可配置项

| 配置 | 默认 | 作用 |
|------|------|------|
| `git.merge_target_branch` | `null` → 启动时 HEAD | MergeValidator 合并目标分支显式覆写 |
| `git.remote` | `"origin"`（可设 `null` 关闭） | MergeValidator 合并前 `git fetch <remote> <main_branch>`；Worker pre-task rebase 前可选 `git fetch <remote> <targetSha>` |
| `git.auto_commit_init_files` | `true` | 启动时是否对 `.claude-orchestrator/` init 文件自动 commit 到 Leader 启动分支 |
| `git.auto_commit_init_files_branch` | `null` | 可指定 init 文件提交到独立分支而非启动分支 |
| `--reset_on_reuse`（`initializeWorktrees` 选项） | `true` | 复用 worktree 时是否 `reset --hard + clean -fdq`；仅测试场景关闭 |
| `CO_CHAIN_MAX_RETRIES` 环境变量 | `9` | 单条 chain 反馈累计上限（含 merge_failed 重试） |

## 8. 关键命名与缩写

| 名词 | 含义 |
|------|------|
| **项目仓 / Repo A** | `<project_root>` 及其 worktree 子目录，存代码变更 |
| **CO root 仓 / Repo B** | `<projects_root>/<leader_id>/`，存 docs 与会话日志 |
| **immediate predecessor** | 当前 link 的直接上游 link 的 worktree commit hash（pre-task rebase 目标）（`watcher.ts:61-81`） |
| **upstream chain history** | manifest 中累计记录的所有上游 link commit 哈希集合（`Message.upstream_commits` 字段载体）（`watcher.ts:21, chain-router.ts:182-200`） |
| **worktree commit** | 项目仓内由 `CommitChecker` 触发的代码变更提交 |
| **docs commit** | CO root 仓内由 `WorkerDocsCommitter` 触发的文档提交 |
| **link_commits.<link>.{worktree,docs,branch}** | chain manifest 中记录的每个 link 双轨提交三元组（`chain-audit.ts:22-45, 218-236`） |

## 9. 关于 rc0 git-worktree-evaluation.md

`docs/rc0-v0.6/git-worktree-evaluation.md` 是 rc0 阶段的**问题评估报告**——识别了 worktree 工作链路的 2 个严重 Bug（`isCommitMerged` 误报、`merge -m` 注入）与 5 个设计缺口，并在 §10 提出推荐工作流（per-link rebase + Leader DocsCommitter + 单次合并 accept 分支）。

**所提问题与所提建议在 rc1 实现层已全部落地**——本文与 `core/*` 即落地后的设计描述。该评估报告作为历史记录留在 rc0 目录，rc1 不复制其内容。
