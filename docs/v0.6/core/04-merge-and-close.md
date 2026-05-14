# Core Chain 4 — 合并验证 → 分支合并 → 链关闭

> **链路定位**：Worker 完成报告携带 commit 信息时，Leader 通过 claude-cli 进行合并决策与执行（merge/skip/review_first），最终关闭责任链。
>
> **关键约束**：Leader 不直接执行 git 命令。所有 git 操作（ancestry 检查、checkout、merge、abort）均通过 claude-cli + 模板完成。

## 1. 链路总览

```
Worker 完成报告（含 commit）
    │
    ▼
ChainRouter.handleCompletionReport()
    │
    ├─ commit 存在 → MergeValidator.validate(commitInfo)
    │     ├─ TemplateEngine.render("worker-merge-decision.md")
    │     ├─ ClaudeRunner.run(prompt, logPath)
    │     │     (claude-cli 内部执行: git merge-base --is-ancestor / git checkout / git merge --no-ff / git merge --abort)
    │     └─ 解析 claude-cli 输出 → MergeDecision { merge | skip | review_first }
    │
    └─ 继续 EvalDecision 处理（链路 3）
```

## 2. Step 1 — MergeValidator.validate

`MergeValidator` 本身不执行任何 git 命令，只负责模板渲染和调用 claude-cli：

```typescript
class MergeValidator {
  constructor(
    private templateEngine: TemplateEngine,
    private runner: ClaudeRunner,
  ) {}

  async validate(commitInfo: {
    sha: string;
    message: string;
    branch: string;
    taskTitle: string;
    taskLink: string;
  }): Promise<MergeDecision> {
    // 1. 渲染合并决策模板，包含 commit 信息
    const prompt = this.templateEngine.render("worker-merge-decision.md", {
      commit_sha: commitInfo.sha,
      commit_message: commitInfo.message,
      branch: commitInfo.branch,
      task_title: commitInfo.taskTitle,
      task_link: commitInfo.taskLink,
    });

    // 2. 通过 claude-cli 执行：ancestry 检查 → 决策 →（若 merge）执行合并
    const logPath = this.runner.logPath(`merge-${Date.now().toString(36)}`);
    await this.runner.run(prompt, logPath);

    // 3. 解析 claude-cli 输出的 MergeDecision JSON
    const output = await fs.readFile(logPath, "utf-8");
    const json = extractJson(output);

    if (json) return MergeDecisionSchema.parse(json);

    // claude-cli 失败 → 保守策略
    return { decision: "review_first", reason: "Merge decision claude-cli failed" };
  }
}
```

## 3. Step 2 — claude-cli 合并决策与执行

模板 `worker-merge-decision.md` 指导 claude-cli 完成以下三步：

### 3.1 检查是否已合并

claude-cli 执行 `git merge-base --is-ancestor <sha> <mainBranch>`：
- 退出码 0 → 已合并 → 输出 `{ "decision": "skip", "reason": "Already merged" }`
- 退出码非 0 → 未合并 → 继续下一步

### 3.2 分析变更并决策

claude-cli 分析 commit 内容（diff、变更文件、影响范围），判断是否安全合并：

| 决策 | 条件 |
|------|------|
| `merge` | 变更隔离良好，无冲突风险 |
| `skip` | 已在 main 中或无需合并 |
| `review_first` | 有冲突可能或需人工审查 |

### 3.3 执行合并（decision=merge 时）

claude-cli 执行：

```bash
git checkout <mainBranch>
git merge <branch> --no-ff -m "Merge: <commitMessage>"
```

- **成功** → 输出 `{ "decision": "merge", "reason": "Merged <branch> into <mainBranch>" }`
- **冲突** → 执行 `git merge --abort` + `git checkout -`（回到之前分支）→ 输出 `{ "decision": "review_first", "reason": "Merge conflict", "conflict_files": [...] }`

## 4. MergeDecision 输出格式

```json
{
  "decision": "merge",
  "reason": "Change is isolated to auth module, all tests pass, safe to merge",
  "conflict_files": [],
  "reviewed_branches": []
}
```

## 5. 合并策略

| 策略 | 说明 |
|------|------|
| 所有 git 操作由 claude-cli 执行 | Leader 不直接调用 execGit |
| 始终 `--no-ff` | 保留合并提交，便于回溯 |
| 始终先 checkout 到 main | 不修改 Worker 分支 |
| 冲突自动 abort | 不破坏 main |
| claude-cli 失败 → review_first | 保守策略 |
| 已合并 → skip | 幂等，不重复合并 |

## 6. 与 ChainRouter 集成

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

## 7. Worker 分支命名

```
claude-orchestrator/{Name}-workspace

示例:
  claude-orchestrator/Tom-workspace
  claude-orchestrator/Jerry-workspace
```

每个 Worker 在自己的 worktree 分支上 commit，Leader 通过 claude-cli 将这些分支合并回 main。

## 8. 链路产出

| 产出 | 说明 |
|------|------|
| MergeDecision | `merge` / `skip` / `review_first` |
| git merge commit | main 上的 `--no-ff` 合并提交（由 claude-cli 执行） |
| EVENT LOG 记录 | TUI 显示合并决策 |

## 9. 错误处理

| 场景 | 处理 |
|------|------|
| 已合并 | claude-cli 返回 `skip`，不重复合并 |
| 合并冲突 | claude-cli 执行 `git merge --abort` + 返回 `review_first` |
| claude-cli 决策失败 | MergeValidator 返回 `review_first`（保守） |
| claude-cli 执行失败（退出非零） | MergeValidator 返回 `review_first` + 错误原因 |
| 无 commit（纯文档任务） | MergeValidator 不调用，链正常推进 |
