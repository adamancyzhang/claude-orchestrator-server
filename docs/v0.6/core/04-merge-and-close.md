# Core Chain 4 — 合并验证 → 分支合并 → 链关闭

> **链路定位**：Worker 完成报告携带 commit 信息时，Leader MergeValidator 决策 merge/skip/review_first，执行 git merge，最终关闭责任链。

## 1. 链路总览

```
Worker 完成报告（含 commit）
    │
    ▼
ChainRouter.handleCompletionReport()
    │
    ├─ commit 存在 → MergeValidator.validate(commitInfo)
    │     ├─ git merge-base --is-ancestor → skip
    │     ├─ claude-cli + worker-merge-decision.md → MergeDecision
    │     └─ decision="merge" → git checkout main → git merge --no-ff
    │         ├─ 成功 → keep
    │         └─ 冲突 → git merge --abort → review_first
    │
    └─ 继续 EvalDecision 处理（链路 3）
```

## 2. Step 1 — MergeValidator.validate

```typescript
class MergeValidator {
  async validate(commitInfo: {
    sha: string;
    message: string;
    branch: string;
    taskTitle: string;
    taskLink: string;
  }): Promise<MergeDecision> {
    const mainBranch = await this.detectMainBranch();  // main or master

    // 检查是否已合并
    if (await this.isAncestor(commitInfo.sha, mainBranch)) {
      return { decision: "skip", reason: "Already merged" };
    }

    // 调用 claude-cli 决策
    const decision = await this.askMergeDecision(commitInfo, mainBranch);

    // 执行合并
    if (decision.decision === "merge") {
      return this.executeMerge(commitInfo, mainBranch);
    }

    return decision;
  }
}
```

## 3. Step 2 — 检查是否已合并

```typescript
private async isAncestor(sha: string, mainBranch: string): Promise<boolean> {
  try {
    await execGit(`merge-base --is-ancestor ${sha} ${mainBranch}`);
    return true;
  } catch {
    return false;  // 未合并
  }
}
```

## 4. Step 3 — claude-cli 合并决策

使用 `worker-merge-decision.md` 模板，让 LLM 分析：

```typescript
private async askMergeDecision(
  commitInfo: CommitInfo,
  mainBranch: string,
): Promise<MergeDecision> {
  const prompt = templateEngine.render("worker-merge-decision.md", {
    commit_sha: commitInfo.sha,
    commit_message: commitInfo.message,
    branch: commitInfo.branch,
    task_title: commitInfo.taskTitle,
    task_link: commitInfo.taskLink,
    main_branch: mainBranch,
  });

  const logPath = this.runner.logPath(`merge-${Date.now().toString(36)}`);
  await this.runner.run(prompt, logPath);

  const output = await fs.readFile(logPath, "utf-8");
  const json = extractJson(output);

  if (json) return MergeDecisionSchema.parse(json);

  // claude-cli 失败 → 保守策略
  return { decision: "review_first", reason: "Merge decision claude-cli failed" };
}
```

MergeDecision 输出格式：

```json
{
  "decision": "merge",
  "reason": "Change is isolated to auth module, all tests pass, safe to merge",
  "conflict_files": [],
  "reviewed_branches": []
}
```

## 5. Step 4 — 执行 git merge

```typescript
private async executeMerge(
  commitInfo: CommitInfo,
  mainBranch: string,
): Promise<MergeDecision> {
  try {
    // 切换到 main
    await execGit(`checkout ${mainBranch}`);

    // --no-ff 保留合并提交
    await execGit(`merge ${commitInfo.branch} --no-ff -m "Merge: ${commitInfo.message}"`);

    return {
      decision: "merge",
      reason: `Merged ${commitInfo.branch} into ${mainBranch}`,
    };
  } catch (err) {
    // 冲突 → abort
    await execGit("merge --abort");
    await execGit(`checkout -`); // 回到之前的分支

    return {
      decision: "review_first",
      reason: "Merge conflict detected",
      conflict_files: await this.getConflictFiles(),
    };
  }
}
```

## 6. 合并策略

| 策略 | 说明 |
|------|------|
| 始终 `--no-ff` | 保留合并提交，便于回溯 |
| 始终先 checkout 到 main | 不修改 Worker 分支 |
| 冲突自动 abort | 不破坏 main |
| claude-cli 失败 → review_first | 保守策略 |
| 已合并 → skip | 幂等，不重复合并 |

## 7. 与 ChainRouter 集成

```typescript
// chain-router.ts handleCompletionReport()
const evalDecision = extractJson(msg.content);

if (evalDecision.commit?.sha) {
  const mergeDecision = await this.mergeValidator.validate({
    sha: evalDecision.commit.sha,
    message: evalDecision.commit.message,
    branch: evalDecision.commit.branch,
    taskTitle: msg.task_title ?? "",
    taskLink: msg.link ?? "",
  });

  // 记录决策日志到 EVENT LOG
  eventBus.emit({
    type: "debug_info",
    message: `Merge: ${mergeDecision.decision} — ${mergeDecision.reason}`,
  });
}

// 合并验证与 EvalDecision 解耦
// 即使决策为 skip/review_first，链条仍按 EvalDecision 继续推进
```

## 8. Worker 分支命名

```
claude-orchestrator/{Name}-workspace

示例:
  claude-orchestrator/Tom-workspace
  claude-orchestrator/Jerry-workspace
```

每个 Worker 在自己的 worktree 分支上 commit，Leader 负责将这些分支合并回 main。

## 9. 链路产出

| 产出 | 说明 |
|------|------|
| MergeDecision | `merge` / `skip` / `review_first` |
| git merge commit | main 上的 `--no-ff` 合并提交 |
| EVENT LOG 记录 | TUI 显示合并决策 |

## 10. 错误处理

| 场景 | 处理 |
|------|------|
| 已合并 | 返回 `skip`，不重复合并 |
| 合并冲突 | `git merge --abort` + 返回 `review_first` |
| claude-cli 决策失败 | 默认 `review_first`（保守） |
| git checkout 失败 | 返回 `review_first` + 错误原因 |
| 无 commit（纯文档任务） | MergeValidator 不调用，链正常推进 |
