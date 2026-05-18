# Core Chain 4 — close_chain → 单次合并 accept 分支 → 链关闭

> **链路定位**：accepter 发出 `close_chain` 决策后，Leader 通过 `runCloseChainMerge` 对 accept-link 分支做**单次合并**，把整条 plan→build→verify→review→accept 的线性历史一次性带入主分支。本文重写自 rc0 同名文件——rc0 的"MergeValidator 调 claude-cli 逐 link 合并"模型已弃用，此处描述当前实际实现。

## 1. 单次合并模型（rc1 核心翻转）

旧模型（rc0 文档）：每个 link 在自己的分支上独立提交（base 都是 `M0`），close_chain 时逐个 commit 调用 MergeValidator，期望它们各自合并。问题：链上不同 link 触及同一文件几乎必然冲突；且 rc0 评估报告发现 `isCommitMerged` 误报让所有合并被静默 skip。

新模型（rc1）：每个 Worker 在 task_dispatch 收到 `upstream_commits` 后做 pre-task rebase（详见 `02-task-claim-and-execute.md §3`），使各 link 分支形成线性串接：

```
M0 ────────────────────────────────────────────────────▶  main
   ╲                                                   ╱
    ╲  plan(P) ── rebase ─▶ build(B) ── rebase ─▶ ... ╱ 
                                                accept(X)
```

accept-link 分支的 HEAD 上承载了 `M0 ← P ← B ← V ← R ← X` 的完整线性 history。close_chain 时**只需合并 accept 分支一次**即可把整条 chain 进入 main。

## 2. `runCloseChainMerge` 流程

`chain-router.ts:825-860`：

```ts
private async runCloseChainMerge(chainId: ChainId): Promise<MergeFailure[]> {
  const failures: MergeFailure[] = [];
  if (!this.opts.merge_validator) return failures;
  
  if (this.opts.chain_audit) {
    const manifest = await this.opts.chain_audit.readManifest(chainId);
    const acceptRecord = manifest?.link_commits?.accept;
    
    if (acceptRecord?.worktree && acceptRecord.branch) {
      try {
        await this.opts.merge_validator.validate({
          sha: acceptRecord.worktree,
          branch: acceptRecord.branch,
          message: `chain ${chainId} accept`,
          task_title: `[${chainId}] accept`,
          task_link: "accept",
        });
        return failures;          // 成功
      } catch (err) {
        failures.push({
          link: "accept",
          sha: acceptRecord.worktree,
          branch: acceptRecord.branch,
          message: `chain ${chainId} accept`,
          error: this.formatMergeError(err),
          category: this.categorizeMergeError(err),
        });
        return failures;
      }
    }
    // 无 accept-link commit 记录 → 落入 legacy 路径
  }
  return this.runMergeValidation(chainId);
}
```

判定路径：
1. `manifest.link_commits.accept.{worktree, branch}` 均非空 → 走**新模型**单次合并
2. 否则（旧 Worker 不发 `commits` envelope，或 accept 是纯文档无 worktree commit）→ 走 `runMergeValidation` legacy 路径（详见 §5）

## 3. MergeValidator 行为

`packages/leader/src/merge-validator.ts:49-128`：

```ts
async validate(commit: CommitInfo): Promise<MergeDecision> {
  // 1. 决定 merge 目标分支
  const mainBranch =
    this.opts.merge_target_branch ??
    this.execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  
  // 2. 可选 fetch（remote 配置非 null 时）
  if (this.opts.remote) {
    try {
      this.execGit(["fetch", this.opts.remote, mainBranch]);
    } catch (err) {
      throw classifyGitError(err, "fetch failed");
    }
  }
  
  // 3. ancestry 判定 — 已合并则 skip
  if (this.isCommitMerged(commit.sha, mainBranch)) {
    return { decision: "skip", reason: "Already merged" };
  }
  
  // 4. claude-cli 决策（merge / skip / review_first）
  const decision = await this.askDecision(commit, mainBranch);
  
  // 5. 执行合并
  if (decision.decision === "merge") {
    const currentBranch = this.execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    try {
      this.execGit(["checkout", mainBranch]);
      const mergeMsg = `Merge ${commit.branch}: ${commit.message}`;
      this.execGit(["merge", commit.branch, "--no-ff", "-m", mergeMsg]);
      bus.emit({ type: "debug_info", message: `merged: ${commit.branch} -> ${mainBranch}` });
    } catch (err) {
      this.execGit(["merge", "--abort"]);
      const conflicts = this.detectConflicts();
      this.execGit(["checkout", currentBranch]);
      if (conflicts.length > 0) {
        throw new MergeConflictError(`merge ${commit.branch} conflicted`, conflicts);
      }
      throw classifyGitError(err, `merge ${commit.branch} failed`);
    }
    this.execGit(["checkout", currentBranch]);
  }
  
  return decision;
}
```

关键设计点：

| 设计点 | 实现 | 解决的问题 |
|--------|------|-----------|
| 一律 `execFileSync(["git", ...args])` 数组形式 | `execGit`（`merge-validator.ts:190-196`）| 杜绝 commit message 中特殊字符触发 shell 注入（rc0 评估报告 Bug-2） |
| `isCommitMerged` 用 `merge-base --is-ancestor` | `merge-validator.ts:164-179` | 取代误报版本（rc0 Bug-1：旧版用 `branch --contains` 让所有 Worker 分支误返回 true） |
| `merge_target_branch` 可显式覆写 | `MergeValidatorOptions.merge_target_branch` (`merge-validator.ts:41`) | 修复 rc0 Issue-4（mainBranch 永远等于 HEAD） |
| `remote` 可选 fetch | `MergeValidatorOptions.remote` (`merge-validator.ts:46`) | 修复 rc0 Issue-5（无 fetch/pull） |
| 冲突 → abort + 切回原分支 | catch 块顺序：`merge --abort` → `detectConflicts` → `checkout currentBranch` → throw | main 永远不在 merge-in-progress 半态 |

### 3.1 askDecision（claude-cli 仅用于决策）

`merge-validator.ts:134-154`：

```ts
const prompt = this.opts.template_engine.render(this.opts.template_name, {
  branch, sha, message, task_title, task_link, main_branch: mainBranch,
});
await this.opts.runner.run({ prompt, log_path: logPath });
const parsed = MergeDecisionSchema.safeParse(JSON.parse(extractJson(output)));
if (!parsed.success) throw new ValidationError("merge decision JSON invalid", parsed.error);
return parsed.data;
```

`MergeDecisionSchema` 三个分支：`merge` / `skip` / `review_first`。claude-cli **不执行**任何 git 命令——它只读 commit 元数据后输出 JSON 决策，所有状态变更由 MergeValidator 自身用 `execFileSync` 执行。

## 4. 错误分类与路由

`merge-validator.ts:204-225` 的 `classifyGitError` 把 git 错误归到 4 个错误类：

| 错误类 | stderr 关键字 | 含义 |
|--------|--------------|------|
| `MergeConflictError` | 通过 unmerged paths 检测，不走 classifyGitError | 真冲突 |
| `WorktreeLockedError` | `cannot lock ref`, `index.lock`, `unable to create.*\.lock` | git 锁占用 |
| `GitPermissionError` | `permission denied`, `read-only file system` | 文件系统权限 |
| `GitNetworkError` | `could not resolve host`, `connection (refused|timed out)`, `cannot access`, `network is unreachable` | fetch 网络故障 |
| 其他 | （fallback）| 包成 plain Error，保留 stderr |

`chain-router.ts:884-890` 的 `categorizeMergeError` 把异常映射到 `MergeFailureCategory`：`conflict` / `worktree_locked` / `permission` / `network` / `other`。

合并失败时 `runCloseChainMerge` 把 category 填入 `MergeFailure[]`，由 `pushMergeConflictRetries` 决定路由（详见 §6）。

## 5. Legacy `runMergeValidation` 路径

`chain-router.ts:899-934`：

```ts
private async runMergeValidation(chainId: ChainId): Promise<MergeFailure[]> {
  const failures: MergeFailure[] = [];
  if (!this.opts.merge_validator) return failures;
  const commits = this.chainCommits.get(chainId);    // 内存记账（§3.1 of 03-chain-progression.md）
  if (!commits || commits.length === 0) return failures;
  for (const commit of commits) {
    try {
      await this.opts.merge_validator.validate(commit);
    } catch (err) {
      failures.push({
        link, sha, branch, message, error, category,
      });
    }
  }
  return failures;
}
```

启用条件：manifest 不存在 `link_commits.accept`（例如某 Worker 跑的还是旧版本，不发 `commits` envelope）。逐个 commit 调 MergeValidator，**继续过单失败**让其他 commit 仍有机会被评估。

这条路径**只为版本错配的过渡期**保留——v0.6 内所有 Worker 默认都发 `commits` envelope，正常运行不会走到这里。

## 6. merge_failed → pushMergeConflictRetries

`chain-router.ts:745-783` 处理失败：

```ts
const failures = await this.runCloseChainMerge(msg.chain_id);
if (failures.length > 0) {
  for (const f of failures) {
    await chain_audit.record(msg.chain_id, {
      event: "merge_failure",
      link: f.link,
      payload: { sha, branch, message, error: f.error },
    });
  }
  await chain_audit.closeChain(msg.chain_id, "merge_failed", { failures });
  bus.emit({ type: "chain_merge_failed", chain_id, failures });
  await this.pushMergeConflictRetries(msg, failures, requirementPath);
  emitChainClosed(msg.chain_id);
  forgetChain(msg.chain_id);
}
```

`pushMergeConflictRetries`（`chain-router.ts:944-1010+`）按 failure category 路由：

```ts
for (const f of failures) {
  if (
    f.category === "worktree_locked" ||
    f.category === "permission" ||
    f.category === "network"
  ) {
    logger.warn(`merge ${f.category} for ${f.link} — no auto retry`, {...});
    continue;          // 不重试，仅 audit
  }
  const targetId = manifest.link_workers?.[f.link];
  if (!targetId) {
    logger.warn("merge retry skipped: no worker recorded for link");
    continue;
  }
  const newTask = await task_queue.push({
    title: `[${chainId}] ${f.link} merge-conflict-fix`,
    description:
      `Merge conflict on branch ${branch} at ${sha.slice(0,8)}: ${message}.\n` +
      `Error: ${error}.\n` +
      `Pull main, resolve conflicts in your worktree, re-commit, and re-run this link.`,
    criteria: "",
    priority: 0,
    link: f.link,
    chain_id,
    retry_count: 0,
    created_by: leaderId,
    created_by_name: leaderName,
    assigned_to: targetId,
    assigned_to_name: targetName,
  });
  await chain_audit.setLinkTask(chainId, f.link, newTask.id);
  await chain_audit.record(chainId, { event: "feedback_sent", ... });
}
```

路由策略：

| failure category | 重试 | 原因 |
|------------------|------|------|
| `conflict` | ✅ push retry 给 link_workers[link] | 真冲突需要该 worker 在它的 worktree 内 pull main + 解冲突 |
| `other` | ✅ push retry | legacy 路径或未分类错误，保守走原 recovery 行为 |
| `worktree_locked` | ❌ 仅 audit | 锁占用是运行时偶发，重派同样会撞锁，需要运维 |
| `permission` | ❌ 仅 audit | 文件系统权限错配需要人工修复 |
| `network` | ❌ 仅 audit | fetch 网络故障需要外部恢复 |

## 7. 重试任务的特殊行为

merge-conflict-fix retry task 与普通 feedback retry task 在派发逻辑上无区别——都通过标准 task_dispatch + `upstream_commits` 通道发往 Worker。但任务 description 文本明确指引 worker：

> Pull main, resolve conflicts in your worktree, re-commit, and re-run this link.

Worker 在 pre-task rebase 阶段重新尝试 rebase 到当前 upstream（包括上次成功合并的更上游 link），冲突会在 rebase 阶段就暴露并走 `sendForcedFeedbackReport`，进入标准 feedback 闭环。

注意：merge-conflict-fix retry task **不会**预先调 `clearLinkCommitsFrom`——chain 已 close（status=merge_failed），并被 `forgetChain` 从内存里清掉，新一轮如果用户再 push 同一需求（不同 chain_id）走的是新链路。

## 8. ChainStatus 终态枚举

| 状态 | 含义 | 触发 |
|------|------|------|
| `running` | 链开放中 | `openChain` 初始化 |
| `completed` | 全部合并成功 | `close_chain` + `runCloseChainMerge` 返回空 failures |
| `aborted` | 评估器 reject 或反馈超上限 | `reject` 决策 / `retry_ceiling_exceeded` |
| `merge_failed` | close_chain 命中合并冲突 / 其他 git 错误 | 上文 §6 |
| `failed` | 业务失败（保留位） | 暂未使用 |

## 9. 链路产出

| 产出 | 位置 | 触发 |
|------|------|------|
| main 分支 merge commit | leader 启动分支或 `merge_target_branch` | MergeValidator `decision == merge` 路径成功 |
| `chain_audit.closeChain(chainId, "completed")` | manifest.json | 单次合并 0 failures |
| `chain_audit.closeChain(chainId, "merge_failed", {failures})` | manifest.json | 任一 failure |
| audit 事件 `merge_failure` × N | events.ndjson | 每个失败 link 一条 |
| `chain_merge_failed` event | LeaderEventBus | TUI EVENT LOG 出现红色 `MERGE_FAILED chain <id>` |
| merge-conflict-fix retry task × M | `/tasks/pending/task-{seq}` | 仅 conflict / other category 触发 |

## 10. 错误处理

| 场景 | 处理 |
|------|------|
| `MergeConflictError` | failures.push(category=conflict) → push retry task |
| `WorktreeLockedError` | failures.push(category=worktree_locked) → 仅 audit，无重试 |
| `GitPermissionError` | failures.push(category=permission) → 仅 audit |
| `GitNetworkError` | failures.push(category=network) → 仅 audit |
| 其他 git 错误 | failures.push(category=other) → push retry（保守） |
| `merge_target_branch` 不存在 | git 抛错 → classifyGitError → 走 other → 重试时仍会失败，最终需运维 |
| accept-link 无 worktree commit | runCloseChainMerge 落 legacy `runMergeValidation`；legacy 内存 commits 也空 → closeChain("completed")（链虽 close 但 main 无变化） |
| Worker 不发 `commits` envelope（旧版本） | recordLinkCommit 跳过；走 legacy `runMergeValidation` 路径 |
| MergeValidator 未注入到 ChainRouter | runCloseChainMerge 直接返回空 failures → closeChain("completed")（合并被完全跳过，开发/测试场景使用） |
