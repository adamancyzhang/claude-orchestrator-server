# 07 — MergeValidator 与链关闭

> **DD 定位**：close_chain / spawn_chain 时把链的 accept-link 分支合并到 main 的完整流程；MergeDecision 三态；merge_failed 路径与 Executor retry；MergeValidator 调用 claude-cli 失败的保守 fallback；git 错误五分类（ 模型）。
>
> **PRD 锚**：FR-15 / FR-16 / FR-17 / FR-33（merge 复用部分）/ FR-36（git 错误五分类）。
>
> **Schema**：`02-contracts-and-protocol.md` §10 (MergeDecision) + §6 (ChainManifest.merge_failures) + §6.0 (LinkCommitRecord)。

---

## 1. 设计原则

1. **单次合并 accept-link 分支（，rc1 worktree 工作流）**：close_chain 时 MergeValidator **只**合并 accept-link 的 Worker 分支到 main，而不再"逐 link 遍历"。可行性来自 Worker pre-task rebase（`06-tasks-and-workers.md` §3.5）—— 链的 plan ← build ← verify ← review ← accept 分支被线性串联，accept 分支是整条链的 tip。
2. **Leader 与代码协同执行 git**：`isCommitMerged` 用 `git merge-base --is-ancestor` 在 Leader 侧直接判断，避免重复合并；真正的 `git merge` 仍委托 MergeValidator 在 main 工作树执行。MergeDecision 由 claude-cli 通过 `worker-merge-decision.md` 给出（决策），但 ancestry 检测不依赖 claude（FR-15）。
3. **保守 fallback**：claude-cli 失败 / 输出无法解析 / 超时 → `decision='review_first'`（不动 main）。
4. **git 错误五分类**：merge 期 git 失败按错误类分流——**conflict**与 **other**触发 retry，**worktree_locked / permission / network** 不重试（详见 §6.6）。
5. **失败显式化**：merge 失败 → 链 `merge_failed` 终态；conflict 类对 accept-link Worker 派 retry（FR-17）；锁/权限/网络类不派 retry，audit 后等待操作员介入。
6. **复用 close 与 spawn**：`close_chain` 与 `spawn_chain` 共用 `runCloseChainMerge`；后者额外把 child_chain_id 写到父 manifest（详见 `10-magic-loop.md` §4）。
7. **git 命令调用纪律**：所有 `git` 调用使用 `execFileSync('git', args[])` 数组形式，**严禁** shell 字符串拼接 —— 防止 worktree 路径 / SHA / 分支名中的特殊字符引发命令注入。代码归属：`packages/leader/src/merge-validator.ts:190`（`execGit`）。

---

## 2. MergeDecision 三态语义

| decision | 触发 | 行为 |
|---|---|---|
| `merge` | claude-cli 判断该 link 的 Worker 分支可干净合并到 main | 执行 `git checkout main && git merge --no-ff <branch> -m "..."`；记录 `merged_commit` SHA |
| `skip` | 分支已合并到 main / 无新 commit / 已是 ancestor | 不动 main；视作"该 link 已就位" |
| `review_first` | 冲突 / claude-cli 解析失败 / ancestry 不明确 | 不动 main；该 link 进入 failures 列表 |

> `review_first` 在 v0.7 中等价于"merge failed for this link"，触发 §4 的 retry 流程。

---

## 3. runMergeValidation 总览

### 3.1 入口

| 调用方 | 触发 | 入口签名 |
|---|---|---|
| ChainRouter（close_chain 决策） | accept link 输出 `close_chain` | `runMergeValidation(chainId, mode='close')` |
| ChainRouter（spawn_chain 决策，�� | explore link 输出 `spawn_chain` | `runMergeValidation(chainId, mode='spawn')` |

### 3.2 总流程（ 单次合并 accept-link）

```mermaid
sequenceDiagram
  autonumber
  participant CR as ChainRouter
  participant CA as ChainAudit
  participant MV as MergeValidator
  participant CL as claude-cli (worker-merge-decision.md)
  participant GIT as git (project root, main worktree)
  participant BUS as LeaderEventBus

  CR->>CA: readManifest(chainId)
  CA-->>CR: { link_commits.accept: { worktree, branch, docs } }
  alt accept link_commits 缺失（legacy / 旧 Worker）
    CR->>CR: fallback 走 §6.7 legacy 逐 link 迭代
  else 正常路径
    CR->>MV: validate({sha: accept.worktree, branch: accept.branch, link:'accept', ...})
    MV->>GIT: mainBranch = (opts.merge_target_branch ?? git rev-parse --abbrev-ref HEAD)
    opt config.git.remote != null
      MV->>GIT: git fetch <remote> <mainBranch>
      Note over MV,GIT: 失败 → classifyGitError → 抛 GitNetworkError/Permission/Locked
    end
    MV->>MV: isCommitMerged(accept.worktree, mainBranch)?
    alt 已是 main 的 ancestor
      MV-->>CR: { decision: 'skip', reason: 'Already merged' }
    else 不是 ancestor
      MV->>CL: claude -p renderPrompt(worker-merge-decision.md, {branch, sha, main_branch, ...})
      CL-->>MV: stdout (MergeDecision JSON)
      MV->>MV: 解析；失败 → throw ValidationError → ChainRouter 视为 review_first
      alt decision == 'merge'
        MV->>GIT: git checkout <mainBranch>
        MV->>GIT: git merge --no-ff <accept.branch> -m "Merge ..."
        alt git exit == 0
          MV->>BUS: emit 'debug_info' (merged)
          MV-->>CR: { decision: 'merge', ... }
        else exit != 0
          MV->>GIT: git merge --abort + git checkout <prev_branch>
          MV->>MV: classifyGitError → MergeConflictError | WorktreeLockedError | GitPermissionError | GitNetworkError | Error
          MV-->>CR: throw <分类的错误>
        end
      else decision in {skip, review_first}
        MV-->>CR: decision
      end
    end
  end
  CR->>CA: appendAudit('merge_validation_completed', { decision, sha, branch, error_class? })
```

代码归属：`packages/leader/src/merge-validator.ts:52`（`validate`）+ `packages/leader/src/chain-router.ts:825`（`runCloseChainMerge`）。

### 3.3 为什么只合并 accept-link

| 设计点 | rc0 模型（已废弃） | 模型 |
|---|---|---|
| 合并粒度 | 逐 link 遍历，每 link 一个 merge commit | 单次合并 accept 分支 |
| 链内 commit 关系 | 各 link 分支独立 fork from main | plan ← build ← verify ← review ← accept 线性串联（pre-task rebase 实现） |
| main 上的 commit 数 | 1~N 个 `--no-ff` merge | 1 个 `--no-ff` merge（含整条链的代码） |
| 冲突暴露面 | 每 link 都可能冲突 | 仅 accept 分支与 main 之间一次冲突 |
| close_chain 复杂度 | O(N) 决策 + O(N) git 操作 | O(1) 决策 + O(1) git 操作 |
| retry 目标 | 失败 link 的 Worker | accept-link Worker（汇聚所有上游） |

> 不变量：
> - accept-link 的 worktree 分支 == 链所有代码产出的线性 tip（因 §3.5 pre-task rebase）。
> - 若 plan / build / verify / review 任一 link 不动代码（`worktree=null`），其分支仍存在但 commit 与上游同 SHA —— accept 仍能拿到完整链历史。
> - merge 决策只问 claude-cli **一次**（不是 5 次），明显节约 token / 延迟。

---

## 4. 成功路径与失败路径

### 4.1 成功路径（FR-16）

```text
if failures.empty():
  ChainAudit.closeChain(chainId, 'completed', { child_chain_id?: ChainId })
  // ↑ 注：closeChain extra 参数是 **单数** child_chain_id（本次 spawn 的子链 ID）；
  //   ChainAudit 内部 push 到 manifest.child_chain_ids[] 数组（02 §6 ChainManifest 字段是 child_chain_ids）。
  //   关闭一次最多新增一个子链；close（非 spawn）时省略该字段。
  emit LeaderEventBus 'chain_closed' { chain_id, status: 'completed' }
  // mode='spawn' 时由 ChainRouter 继续触发 spawn 后续（详见 10 §4），不在 MergeValidator 内
```

> 不变量：
> - 模型下 main 分支恰好多 **1 个** `--no-ff` merge commit（accept 单分支合并）；rc0 legacy fallback 路径仍为 1~N。
> - `skip` decision 不产生 commit（accept 已是 main 的 ancestor）。

### 4.2 失败路径（FR-17）

```text
if failures.not_empty():
  ChainAudit.closeChain(chainId, 'merge_failed', { failures })
  emit LeaderEventBus 'chain_merge_failed' { chain_id, failures }

  // 派 retry task —— 仅 conflict 类（ 五分类）
  for failure in failures:
    if failure.category != 'conflict':
      // worktree_locked / permission / network / other → 不重试；audit 后等待操作员
      ChainAudit.appendAudit('merge_failure', { category, error, sha, branch })
      continue

    workerId = manifest.link_workers['accept']   // 始终是 accept-link Worker
    if workerId == null:
      continue                                  // 不该发生；记 debug_info
    retryTask = {
      task_id:    newTaskId(),
      chain_id:   chainId,
      link:       'accept',                     // 始终是 accept-link
      title:      `[merge retry] resolve conflict on branch ${failure.branch}`,
      description: renderMergeRetryDescription(failure),
      priority:   'HIGH',
      assigned_to: workerId,
      status:     'pending',
      retry_count: 0,
    }
    TaskQueue.push(retryTask)
    ChainAudit.appendAudit('task_dispatch', { task_id, link:'accept', assigned_to: workerId, reason: 'merge_retry' })

  // mode='spawn' 时不派生子 chain（PRD §6.5 spawn_chain 在 merge_failed 时退化）
  // 详见 10 §4.3
```

> 关键不变量：
> - chain 的 `manifest.status = 'merge_failed'`（**不**是 `completed`）。
> - retry task 的 `assigned_to` 强指派回 **accept-link Worker**（rc1 模型下他汇聚整条链的代码，是合并目标的唯一所有者）。**不**再像 rc0 那样按 failure.link 派给 plan/build/verify/review 的 Worker。
> - retry task 走标准流程：accept Worker 在自己 worktree 里 fetch + rebase / merge main 解冲突 → 重 commit → 自评估 → ChainRouter 重新触发 `runCloseChainMerge`。
> - 仅 conflict 类失败触发 retry；锁/权限/网络类**不**派 retry task —— 这些是基础设施问题，反复 retry 无意义，由 audit 提示操作员排查。

### 4.3 重新 merge 触发条件

```text
ChainRouter.handleCompletionReport(report):
  ...
  if task.assigned_to != null AND task.title.startsWith('[merge retry]'):
    // 这是 §4.2 派出的 retry task；不走常规 activate_next/feedback
    if report.decision != 'activate_next':
      // Executor 自评估不通过（冲突没解决干净 / 主动 reject）→ 链保持 merge_failed
      ChainAudit.appendAudit('debug_info', { message: 'merge retry rejected', task_id })
      return
    // 重新跑 MergeValidator
    runMergeValidation(task.chain_id, mode='close')  // 复 merge；成功 → 链 status 转 completed
```

> 这一段是 ChainRouter 的特例分支；详见 `05-chain-router-and-decisions.md` §4.5。

---

## 5. renderMergeRetryDescription 模板

retry task description 必须包含足够信息让 Executor 自助解冲突：

```text
A merge from your branch <branch_name> to main failed during chain closure.

**Conflict context**:
{{merge_error_excerpt}}

**Your branch**: {{branch_name}}
**Your worktree**: {{worktree_path}}
**Main HEAD at attempt**: {{main_head_sha}}

**What to do**:
1. cd {{worktree_path}}
2. git fetch origin main
3. git merge origin/main   # or git rebase origin/main
4. Resolve conflicts; verify your link's invariants still hold (see {{result_md_path}})
5. git add . && git commit
6. Self-evaluate as usual; if confident, output activate_next.

After your retry, MergeValidator will re-run automatically.
```

> 渲染由 ChainRouter 完成（不需要 claude-cli），变量从 manifest + failures 拿。

---

## 6. MergeValidator claude-cli 调用细节

### 6.1 worker-merge-decision.md 调用

| 字段 | 内容 |
|---|---|
| 系统 prompt | "You are MergeValidator..." 三段身份卡变体（详见 `03-identity-and-roles.md` §4.3） |
| 用户 prompt | 渲染 `worker-merge-decision.md`，含：当前 link、待合并 branch、main HEAD SHA、`git log <branch> ^main` 摘要、对应 result.md 路径 |
| 命令 | `claude --append-system-prompt '<identity>' -p '<prompt>'`（与 Worker 一致） |
| 日志 | `merges/chain-<chain_id>/merge-<link>-<ts>.log`（详见 `09-audit-and-cache.md` §5.3） |

### 6.2 输出解析

期望 stdout 含一个 MergeDecision JSON code block：

````
```json
{ "decision": "merge", "reason": "fast-forward possible; no conflict markers", "merged_commit": null }
```
````

> `merged_commit` 由 MergeValidator 在执行 merge 后填入（claude-cli 输出此字段时只是占位）。

### 6.3 失败回退

| 故障 | 行为 |
|---|---|
| claude-cli 超时（默认 5 分钟硬上限） | ValidationError → ChainRouter 视作 `review_first` |
| stdout 无法解析为 MergeDecision | 同上 |
| `decision == merge` 但 git merge 命令失败（conflict 类）| `git merge --abort` + `git checkout <prev>`，抛 `MergeConflictError(branch, conflict_files)` → retry |
| `decision == merge` 但 git merge 命令失败（lock / permission / network）| `git merge --abort` + `git checkout <prev>`，抛对应 Git*Error → 不 retry，audit |

### 6.4 ancestry 检查放在哪 **[ 修订]**

模型下，ancestry 检查由 MergeValidator 在 TS 层直接做：`git merge-base --is-ancestor <sha> <main_branch>`，退出码 0 = 是 ancestor → `decision='skip'`；退出码 1 = 不是 ancestor → 继续问 claude；其它退出码 → `classifyGitError` 抛对应 Git*Error。

**为什么从 claude 改回 TS**：v0.6 让 claude 做 ancestry 是为了利用上下文感知，但在 shared `.git` 多 Worker 的场景下，`git branch --contains <sha>` 永远返回 true（因为 worker-A 的提交在 worker-B 的分支引用里也能"reach"），导致 v0.6 实现**静默跳过所有 merge**。rc1 直接用 `merge-base --is-ancestor` 修正这个 bug。代码归属：`packages/leader/src/merge-validator.ts:164`（`isCommitMerged`）。

### 6.5 isCommitMerged 实现

```ts
private isCommitMerged(sha: string, mainBranch: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, mainBranch], {
      cwd: this.opts.project_root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;                                  // 退出码 0
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return false;               // 明确"不是 ancestor"
    throw classifyGitError(err, 'merge-base failed');  // sha / branch 缺失 / repo 损坏
  }
}
```

> 关键：退出码 1 与"其它非零"必须分开处理。把"其它非零"当成 `false` 会导致同一类问题（如分支名拼错、SHA 不存在）被误判为"未合并"而触发 merge，进一步污染 main。

### 6.6 git 错误五分类

`classifyGitError(err, fallback)` 按 stderr 模式匹配映射到 5 个错误类：

| 错误类 | stderr 关键词 | retry？ | 路由 |
|---|---|---|---|
| `MergeConflictError` | `<<<<<<< ` 标记 / `CONFLICT (content):` / unmerged paths 非空 | ✅ | 派 retry 给 accept-link Worker（§4.2） |
| `WorktreeLockedError` | `cannot lock ref` / `index.lock` / `unable to create.*\.lock` | ❌ | audit `merge_failure` { category:'worktree_locked' }；提示操作员 |
| `GitPermissionError` | `permission denied` / `read-only file system` | ❌ | audit + 操作员排查 |
| `GitNetworkError` | `could not resolve host` / `connection refused / timed out` / `network is unreachable` / `cannot access` | ❌ | audit；建议设 `git.remote=null` 或排查网络 |
| 其它 `Error` | 未匹配上面任何模式 | ✅（视作 conflict 类） | 派 retry —— 保守路径，避免把未知失败漏掉 |

代码归属：`packages/leader/src/merge-validator.ts:204`（`classifyGitError`）+ `packages/leader/src/chain-router.ts:884`（`categorizeMergeError`）。

PRD 锚：FR-36（ git 错误五分类）。

### 6.7 Legacy fallback（manifest 无 link_commits）

当 `manifest.link_commits.accept` 缺失或 `worktree=null`（旧 Worker / accept 全为 docs-only），ChainRouter 退回 v0.6 的逐 link 迭代（`runMergeValidation`，代码 `chain-router.ts:899`）。该路径**仅作兼容**：

```text
runMergeValidation(chainId) -> failures[]:
  failures = []
  for link in ['plan', 'build', 'verify', 'review', 'accept']:
    record = manifest.link_commits?[link]
    if record == null || record.worktree == null:
      continue                                  // 跳过无 commit 的 link
    try:
      MergeValidator.validate({sha: record.worktree, branch: record.branch, ...})
    catch err:
      failures.push({link, sha: record.worktree, branch, error, category})
      continue                                   // 收齐所有 link 的失败再返回
  return failures
```

> 不变量：legacy 路径仍走 §6.6 错误五分类，retry 派给"失败 link 的原 Worker"而非 accept Worker（因为各 link 分支独立，未线性串联）。新部署应总走 §3.2 单分支路径。

---

## 7. close_chain 与 spawn_chain 时序对比

```mermaid
sequenceDiagram
  autonumber
  participant CR as ChainRouter
  participant MV as MergeValidator
  participant CA as ChainAudit
  participant EB as LeaderEventBus
  participant ZK as ZK /messages/{leader_id}

  Note over CR,EB: close_chain（默认终态）
  CR->>MV: runMergeValidation(chain-001, mode='close')
  MV-->>CR: { successCount: 5, failures: [] }
  CR->>CA: closeChain(chain-001, 'completed')
  CA->>EB: emit 'chain_closed' { status: 'completed' }
  Note over CR,EB: 流程结束

  Note over CR,EB: spawn_chain（仅 explore link，）
  CR->>CR: 检查 chain_depth < magic_max_chains（FR-34）
  alt 已达上限
    CR->>CA: appendAudit('magic_depth_exhausted')
    CR->>CR: 降级为 close_chain（同上路径）
  else 未达上限
    CR->>MV: runMergeValidation(chain-001, mode='spawn')
    MV-->>CR: { failures: [] }
    CR->>CR: childId = newChainId()
    CR->>CA: closeChain(chain-001, 'completed', { child_chain_id: childId })
    CA->>EB: emit 'chain_closed' { status: 'completed' }
    CR->>CA: appendAudit('chain_spawned', { child: childId })
    CR->>ZK: write user_input message { content: explorer.next_requirement, spawned_from: chain-001 }
    CR->>EB: emit 'chain_spawned' { parent: chain-001, child: childId }
    Note over CR,EB: 新一轮 handleRequirement 由 LeaderWatcher 触发；新 manifest 在 openChain 时记 parent_chain_id
  end
```

> spawn 路径下若 `failures.not_empty()`：与 close 完全一致 — 链转 `merge_failed`、派 Executor retry、**不**派生子链（PRD §6.5）。Explorer 的 `next_requirement` 被丢弃（audit 记 `debug_info`，操作员需重新发起需求）。

---

## 8. 与其它 DD 文件交叉

| 主题 | 主文件 |
|---|---|
| MergeDecision schema | `02-contracts-and-protocol.md` §10 |
| ChainAudit.closeChain 字段 | `09-audit-and-cache.md` §1.5 |
| TaskQueue.push retry task | `06-tasks-and-workers.md` §2 |
| ChainRouter merge retry 特例分支 | `05-chain-router-and-decisions.md` §4.5 |
| spawn_chain 端到端 | `10-magic-loop.md` §4 |
| TUI 红字渲染 | `04-tui-and-input.md` §4 |
| merges/ 日志布局 | `09-audit-and-cache.md` §5.3 |
