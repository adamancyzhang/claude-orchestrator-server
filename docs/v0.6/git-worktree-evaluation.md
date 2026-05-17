# Git Worktree 工作链路评估报告

## Context

本报告评估 `claude-orchestrator-server` 当前 v0.3.x 架构中 git worktree 工作链路是否能够**正确**完成产物提交、分支隔离、链尾合并等关键操作。重点关注从 Worker 在隔离 worktree 中提交，到 Leader 在 `close_chain` 时按 P→B→V→R→A 顺序将各 link 分支合并回主分支的全过程。

**本次产出仅为评估报告，不对代码做任何修改**（已与用户确认）。

---

## 1. 当前架构回顾

### 1.1 链路分支与目录

| 组件 | Worktree 路径 | 分支 | 工作目录 |
|---|---|---|---|
| Leader | `<project_root>` | 启动时的当前分支 | 主仓 |
| Worker `<Name>` | `<project_root>/.claude-orchestrator/worktree/<Name>/` | `claude-orchestrator/<Name>-workspace` | 独立 worktree |

- 所有 worktree 共享同一个 `.git` 目录（git worktree 的标准模式）。
- 关键文件：`packages/orchestrator/src/worktree-initializer.ts:48-50, 134-216`
- 子进程在 `packages/orchestrator/src/child-boot.ts:46` 处 `process.chdir(worktree_path)`。

### 1.2 链上产物传递方式（重要发现）

**Worker 之间的产物并非通过 git 同步**，而是通过 **Leader 缓存的文件** 传递：

- Builder 不会 `git merge` 或 `git rebase` Planner 的分支，而是读取 `tasks/<plan-task-id>/result.md`（Leader 文件缓存）作为 `upstream_plan_artifact`。
- 证据：`packages/worker/src/watcher.ts:481-528` 的 `collectChainArtifacts()`、`templates/agents/worker-builder-task.md:10-12`。
- 结论：5 个 link 各自在自己的分支独立提交，**5 个分支都基于同一个 base（启动时的 HEAD）**，互相不可见。

### 1.3 提交时机

- `packages/worker/src/watcher.ts:353-378`：仅 chain-link 任务触发 `CommitChecker.check()`，decompose / 临时消息不触发。
- `packages/worker/src/commit-checker.ts:44-96`：`git status` → `git add -A` → `git commit -m <msg>`（使用 `execFileSync`，**无 shell 注入**）。
- 提交信息由 LLM 通过 `worker-commit-message.md` 模板生成，失败时回退 `chore: auto-commit from <name>`。

### 1.4 合并时机

- 仅在 accepter 发送 `close_chain` 时由 `MergeValidator` 顺序合并所有 link 分支。
- 入口：`packages/leader/src/chain-router.ts:645-695` → `runMergeValidation()` → `merge_validator.validate(commit)` 逐个 commit 调用。
- 合并策略：`git checkout <main>` → `git merge <link-branch> --no-ff -m "..."`，冲突则 `git merge --abort` 并产生重试任务。

---

## 2. 工作正常的部分

| 项 | 评估 | 证据 |
|---|---|---|
| Worker 隔离 | ✅ 每个 Worker 独立 worktree + 独立分支 | `worktree-initializer.ts:175-177` |
| 提交局部化 | ✅ 所有 `git add/commit` 用 `cwd: worktree_path` | `commit-checker.ts:45-65` |
| 提交命令安全 | ✅ 使用 `execFileSync(['git','commit','-m',msg])`，参数数组形式 | `commit-checker.ts:62` |
| 失败可见性 | ✅ `CommitFailedError` 改为可见错误，触发 feedback 重试，不再静默 | `commit-checker.ts:78`、`watcher.ts:364-378` |
| 合并冲突处理 | ✅ `git merge --abort` 回滚 + 自动 push 重试任务到对应 Worker | `merge-validator.ts:62`、`chain-router.ts:780-840` |
| 启动洁净检查 | ✅ `ensureCleanWorkspace` 阻止脏工作区启动 | `run.ts:311` |
| 回到原分支 | ✅ 合并后 leader 切回启动时分支 | `merge-validator.ts:77` |
| 提交身份不污染 | ✅ 提交信息无 Claude 署名/co-author | `commit-checker.ts:99-132` |

---

## 3. 严重 Bug（影响正确性）

### 🔴 Bug-1：`isCommitMerged()` 误报"已合并"（合并被永久跳过）

**文件**：`packages/leader/src/merge-validator.ts:105-107`

```typescript
private isCommitMerged(sha: string): boolean {
  return this.execGit(`branch --contains ${sha}`).length > 0;
}
```

**问题**：所有 worktree 共享同一 `.git`，因此 `git branch --contains <sha>` 一定会列出 Worker **自己的** 分支（如 `claude-orchestrator/Tom-workspace`），输出永远非空 → 该函数**永远返回 `true`**。

**后果**：`validate()` 进入第 39 行后立即返回 `{decision: "skip", reason: "Already merged"}`，**真正的合并代码（48-77 行）永远不会执行**。

调用方：`chain-router.ts:752` 不会捕获到任何异常或失败（因为是 skip），最终 chain 状态被关为 `"completed"`，但 main 分支上**实际没有任何 link 的提交**。

**正确写法应是**（仅说明，不实施）：
- `git merge-base --is-ancestor <sha> <mainBranch>`（用退出码判断），或
- `git branch --contains <sha> --list <mainBranch>`（仅列匹配 main 的分支）

**无单测覆盖**：`grep -rn "isCommitMerged\|branch --contains" tests/` 无结果。

---

### 🔴 Bug-2：合并提交信息存在 shell 注入风险

**文件**：`packages/leader/src/merge-validator.ts:52-54`

```typescript
this.execGit(
  `merge ${commit.branch} --no-ff -m "Merge ${commit.branch}: ${commit.message}"`,
);
```

`execGit` 内部为 `execSync` + 字符串拼接（118-124 行），`commit.message` 来源于 **LLM 生成的提交信息**，可能含 `"`、`` ` ``、`$`、`;` 等字符：

- 含 `"` → 命令解析错误，merge 失败
- 含 `` ` `` 或 `$(...)` → 任意命令执行（恶意 prompt 注入场景）
- 含 `;` 或 `&&` → 拼接额外命令

提交端（`commit-checker.ts:62`）已经使用了 `execFileSync` 数组形式规避了同类问题，**唯独 merge 这一处未对齐**。

---

## 4. 设计层正确性缺口

### 🟠 Issue-3：顺序合并使用过期 base，冲突概率高

5 个 link 分支均基于 chain 开始时的 main HEAD（设为 `M0`），无任何 link 间同步：

```
M0 ── A1 (planner)
  ├── B1 (builder)        ← 看不到 A1
  ├── V1 (verifier)       ← 看不到 A1/B1
  ├── R1 (reviewer)       ← 看不到 A1/B1/V1
  └── X1 (accepter)       ← 看不到任何上游
```

合并顺序 P→B→V→R→A：
1. Merge A1 → main 变为 `M0+merge(A1)`
2. Merge B1 → B1 的 base 仍是 `M0`，若与 A1 触及相同行：**冲突**

**实际频率**：取决于 Planner/Builder 是否写入同一文件。当前架构里 Planner 与 Builder 都可能写到 `.claude-orchestrator/docs/...` 或代码文件中，**冲突是高概率事件**而非小概率。

**现有缓解**：冲突会触发 `pushMergeConflictRetries`（`chain-router.ts:780-840`），告知对应 Worker `pull main, resolve conflicts, re-commit`。但：
- 重试模板没有真正在 Worker worktree 中执行 `git pull origin <main>` 或 rebase 的自动化逻辑；
- Worker 是否能"自己 pull + 解冲突 + 重交"取决于 LLM 行为，**非确定性**。

---

### 🟠 Issue-4：`mainBranch` 来自 leader HEAD，并非真正的 main

**文件**：`packages/leader/src/merge-validator.ts:38`

```typescript
const mainBranch = this.execGit("rev-parse --abbrev-ref HEAD");
```

含义是"leader 当前的分支"，不是 `main` 或 `master`。如果用户在 feature 分支启动 orchestrator，**所有合并目标都是该 feature 分支**，与命名暗示不符。

附加问题：在 `validate()` 的执行中（`checkout <mainBranch>` → `merge` → `checkout <currentBranch>`），第 38 行抓的 `mainBranch` 与第 49 行抓的 `currentBranch` 永远相等（因为 leader 在 validate 入口时仍在原分支），所以两次切换合在一起其实是 no-op 切换。功能上能跑，但语义混乱、易误读。

---

### 🟠 Issue-5：从无 `git fetch`/`git pull`，主分支可能滞后于 remote

整个代码库**没有任何 `git fetch` 或 `git pull` 调用**（grep `fetch\|pull` 在 packages/ 内 0 结果）：

- Worker 启动时不 fetch
- Leader 合并前不 fetch
- 重试合并冲突任务的说明里写了 "Pull main"，但代码并不执行

**风险**：如果同一仓库有人在 remote 推进了 main，本地合并基于过期的 main，最终 `git push` 时要么被 reject，要么导致历史分叉。

---

### 🟠 Issue-6：Worktree 重用未做状态同步

**文件**：`packages/orchestrator/src/worktree-initializer.ts:151-164`

```typescript
if (existing && fs.existsSync(wtPath)) {
  configs.push({ ... });
  opts.logger.info(`reusing worktree ${name} (${role})`);
  continue;
}
```

重启 orchestrator 时，若同名 Worker 的 worktree 还在，直接复用：
- **不 checkout 任何分支**（沿用上次退出时的 HEAD 状态）
- **不 reset 未提交修改**（上次 crash 留下的 dirty 文件还在）
- **不验证分支是否与当前 leader HEAD 兼容**

后果：复用的 worktree 可能处于"上次任务的中间态"，新一轮任务在脏环境上跑，产物不可预测。
（注：用户指示不讨论 worktree 清理，此处仅列正确性影响，不涉及 shutdown 清理逻辑。）

---

### 🟠 Issue-7：`commitInitFiles` 在启动时自动提交到 leader 当前分支

**文件**：`packages/orchestrator/src/run.ts:326-340`

启动流程：`ensureCleanWorkspace`（必须干净）→ 写入 init 文件 → `commitInitFiles`（自动 `git add -A` + `git commit`）。

- 该提交落在 **leader 启动时所在分支**（通常是 main 或开发分支）
- 用户从未显式同意此提交
- 若该分支是受保护分支或被 CI 监控，此自动提交可能触发流水线

---

### 🟡 Issue-8：跨 link 没有 git 层的依赖关系

如第 1.2 节所述，5 个 link 的分支彼此独立、没有 parent-child 关系：

- 优点：高度并行解耦
- 缺点：
  - `git log --graph` 看不到 plan→build→verify 的依赖链
  - 一旦合并后回滚，需要按反序 revert 多个 merge commit
  - 二次 reuse worktree 时分支状态完全独立，谁也不知道彼此

这是**架构选择**而非 bug。但如果未来希望 chain 在 git 历史里"可读"，需要重新设计（例如让 builder 从 planner 的分支 fork、或最终用 octopus merge）。

---

## 5. 健壮性 / 次要项

| # | 位置 | 描述 | 风险 |
|---|---|---|---|
| 9 | `commit-checker.ts:58` | `git add -A` 完全依赖 `.gitignore` 兜底；若 LLM 在 worktree 落下 `.env`、`token.json` 等未 ignore 文件会一并提交 | 中（信息泄露） |
| 10 | `merge-validator.ts:53` | `--no-ff` 始终生成 merge commit，5 link × N chain 后历史快速膨胀 | 低（可读性） |
| 11 | `merge-validator.ts` | 合并失败不区分"冲突 / 工作树锁 / 权限"，统一 `MergeConflictError`，下游重试模板只覆盖冲突场景 | 中（错误分类） |
| 12 | 全局 | 无 `git push`，所有合并仅在本地 | 设计如此，但需用户清楚成果不会自动到远端 |
| 13 | `merge-validator.ts:106` | （和 Bug-1 同位）即使修复 isCommitMerged，仍需考虑 race：两个 chain 同时 close 可能同时改 leader 工作目录的 HEAD | 低（当前 close_chain 串行） |

---

## 6. 风险等级总结

| 等级 | 数量 | 是否会导致"提交/合并不正确" |
|---|---|---|
| 🔴 Critical | 2（Bug-1, Bug-2） | **是**：Bug-1 直接让所有 merge 被静默 skip，main 上永远没有 worker 产物；Bug-2 在 LLM 信息含特殊字符时直接挂或被利用 |
| 🟠 Correctness gap | 5（#3-#7） | **可能**：在多 link 触及同一文件、远端 main 推进、worktree 复用等真实场景下会出错 |
| 🟡 Architecture | 1（#8） | 否，但限制可观测性 |
| 🟡 Robustness | 5（#9-#13） | 否，但增加误用空间 |

**总体结论**：

> **当前 git worktree 工作链路在"理想路径"下能跑通单 chain 的提交，但合并阶段存在一个会让产物永远无法落入 main 的关键 bug（Bug-1）。** 即便修复 Bug-1，链上不同 link 基于同一过期 base 的设计，使得任何两个 link 触及相同文件时都会冲突，必须依赖 LLM 在重试中正确"pull + 解冲突"，可靠性不高。

---

## 7. 建议的后续动作（仅列方向，不实施）

按优先级：

1. **修 `isCommitMerged`**：改用 `git merge-base --is-ancestor` 或 `--list <mainBranch>` 过滤。
2. **修 merge commit message 注入**：把 `execSync("git merge ... -m \"...\"")` 改为 `execFileSync("git", ["merge", branch, "--no-ff", "-m", finalMsg])`。
3. **澄清 `mainBranch` 语义**：要么在配置中显式声明 merge target，要么至少把变量改名为 `currentBranch` 避免误导。
4. **决定 link 间是否同步**：要么在每个 link 启动前把 main 的最新状态（含上一 link 的合并）拉到 worker worktree，要么把跨 link 的文件冲突视为"模板设计问题"显式禁止。
5. **加入 fetch/pull 策略**：用户来决定是否在 close_chain 前 `git fetch origin`、合并后是否 `git push`。
6. **Worktree 复用前重置**：复用前至少 `git status --porcelain` 校验，或 `git reset --hard <leader_HEAD>`（具体策略需用户决策）。
7. **`commitInitFiles` 行为可配置**：默认改为不自动提交，或写到独立分支。

---

## 8. 关键文件清单（供后续修改参考）

| 文件 | 行号 | 关注点 |
|---|---|---|
| `packages/leader/src/merge-validator.ts` | 38, 52-54, 105-107 | Bug-1、Bug-2、mainBranch 命名 |
| `packages/leader/src/chain-router.ts` | 645-695, 740-770, 780-840 | 合并触发与重试 |
| `packages/orchestrator/src/worktree-initializer.ts` | 134-216 | Worktree 创建与重用 |
| `packages/orchestrator/src/run.ts` | 295-308, 311, 326-340 | 启动洁净/init 自动提交 |
| `packages/worker/src/commit-checker.ts` | 44-96 | 提交流程（实现质量较好） |
| `packages/worker/src/watcher.ts` | 340-435, 481-528 | 提交触发 / 跨 link 产物读取 |

---

## 9. 验证方式（如未来执行修复时使用）

报告本身无需运行验证。若未来要验证修复，建议步骤：

1. **复现 Bug-1**：构造一个 chain，让 accepter 调 close_chain，观察 leader 日志里所有 merge 是否都打印 `Already merged` 而 main HEAD 不动。
2. **复现 Bug-2**：让 LLM 生成包含 `"` 的 commit message（或在 fallback 路径里硬编码一个含 `$(date)` 的消息），观察 `git merge` 是否报错或执行注入命令。
3. **跨 link 冲突回归**：让 planner 与 builder 都写同一个 markdown 文件，触发 close_chain，确认 conflict 是否进入重试路径并最终能否被解决。
4. **单测覆盖**：在 `tests/unit/leader/merge-validator.test.ts`（如不存在则新建）加入：已合并提交→skip；未合并提交→走 askDecision；含特殊字符的 message→不破坏命令。

---

## 10. 用户提议工作流评估（持续集成 / Per-link CI）

### 10.1 用户提议（原话整理）

1. **Worker 工作结束**：用 git status 检查变更，覆盖范围为 **CO root 项目实例目录**（`~/.claude-orchestrator/projects/<leader_id>/`）和 **当前 worktree**；有变更则用 claude-cli 提交。
2. **Leader 收到 Worker 消息**：用 claude-cli 对该 Worker 的分支执行 rebase/merge（分支名要显式）。
3. **Worker 收到 Leader 消息**：用 claude-cli 先 rebase/merge 主分支（分支名要显式），再继续下一步工作。

### 10.2 当前架构里涉及的两个独立仓库

| 仓库 | 路径 | 分支模型 | 工作目录 | 并发隔离 |
|---|---|---|---|---|
| **A. 项目仓** | `<project_root>`（含 `.git`，所有 worktree 共享） | 每 Worker `claude-orchestrator/<Name>-workspace`；leader 在启动分支 | 每 Worker 独立 worktree | ✅ 天然隔离 |
| **B. CO root 实例仓** | `~/.claude-orchestrator/projects/<leader_id>/` | 只有 `main`（co-root-initializer.ts:46 `git init -q`，无任何 branch 操作） | 所有 Worker + Leader **共享同一个工作目录与同一 `.git/index`** | ❌ 无任何 mutex/lock |

证据：
- `packages/orchestrator/src/co-root-initializer.ts:28-65`：`git init`、写 `.gitignore`、`commitInitFiles` 一次。全文无 `git branch`、`git checkout`、`git switch`。
- `packages/worker/src/commit-checker.ts:44-65`：cwd 严格为 `worktree_path`，**根本不会触碰 CO root**。
- `packages/worker/src/watcher.ts:203-209`：Worker 把 `local_doc_path` 算成 `<co_root>/docs/<Name>/<date>/<prefix>-<key>.md` 传给模板让 Claude 写入；写完之后**没有任何代码 commit 这个文件**。

**这意味着**：当前 CO root 里 docs 是被持续写入但永远不入 git 的"游离文件"。一旦您按提议加上"Worker 自己 commit"，立刻进入并发雷区——Worker A 的 `git add docs/<NameA>/` 与 Worker B 的 `git add docs/<NameB>/` 共用同一个 `.git/index`，谁先 commit，对方刚 add 进 index 的文件就被一并带走（路径不冲突，但 **index 共享**），形成"串味"提交。

### 10.3 对用户三步流程的逐条评估

| 步骤 | 仓库 A（项目仓） | 仓库 B（CO root） |
|---|---|---|
| **Step 1**：Worker 提交自身变更 | ✅ 已由 `commit-checker.ts` 实现，**保留 execFileSync 路线，不改走 claude-cli** | ⚠️ **必须串行化**才能用，多 Worker 共享 index 会串味 |
| **Step 2**：Leader merge/rebase Worker 分支 | ✅ 这正是解决 Issue-3（过期 base）的方向：把 close_chain 批量合并改为 **per-link 持续集成** | ❌ CO root **无 per-worker 分支可合**，该步骤无对应实体 |
| **Step 3**：下一个 Worker rebase main 后再开工 | ✅ 合理，但**必须用确定性 git 命令**，不能走 claude-cli | ❌ CO root 是共享工作目录，无独立 checkout 概念 |

### 10.4 关于"用 claude-cli 跑 git 命令" — 强烈建议拆开

把 git 操作分成两层，**只让 LLM 管文案，不让它跑状态变更**：

| 用 claude-cli ✅ | 用 `execFileSync(["git", ...])` ✅ |
|---|---|
| 生成 commit message（已有 `worker-commit-message.md`） | `git add <pathspec>` / `git commit -F <file>` |
| 对冲突的自然语言解释 | `git checkout` / `git merge` / `git rebase` |
| 决策"是 merge 还是 rebase"（如有真歧义） | `git fetch` / `git status --porcelain` |

理由：
1. `commit-checker.ts` 与 `merge-validator.ts` 已统一走 execFileSync，回退到 claude-cli 是开历史的倒车
2. LLM 单次调用 5–30s × per-link × N chain → 端到端延迟显著膨胀
3. LLM 会"自由发挥"——把 `git add docs/X/` 改成 `git add -A`、`git commit --amend` 等动作完全可能发生
4. Mock / 单测 LLM 输出比 mock git stdout 难一个数量级
5. git 报错经 LLM 转述会失真，调试链路被拉长

### 10.5 仓库 B（CO root）"commit 混乱"的三种解法（建议 B2）

#### B1 — 每个 Worker 也在 CO root 拥有独立 worktree
- 路径：`<co_root>/.worktrees/<Name>/` on branch `worker/<Name>`
- Worker 在自己的 CO worktree 内 commit docs
- Leader 在 close_chain（或 per-link）顺序 merge 各 `worker/<Name>` → CO main
- **优点**：与仓库 A 完全同构的隔离模型
- **缺点**：worktree 数量翻倍；初始化时间显著增加；CO root 物理空间膨胀；与"CO root 是轻量元数据仓"的定位相悖

#### B2 — Workers 只写文件，Leader 串行 commit（推荐）
- Worker 在 `<co_root>/docs/<Name>/` 写文件，**不 commit**
- Worker 在 EvalDecision JSON 之外多发一个 `docs_changed: { paths: [...] }` 字段（沿用现有 ZK message 通道，**零新通道**）
- Leader 进程内新增 `DocsCommitter`（**单线程串行**消费），调用 `execFileSync git add <paths>` + `git commit -F <msg-file>`
- commit message 由 claude-cli 调用 `worker-commit-message.md` 生成（保留 LLM 价值），失败回退 `docs(<Name>): auto-commit <date>`
- **优点**：实现轻量；串行天然消除 index 竞态；与现有"Leader 是路由器，Worker 是计算节点"的架构一致；无需新 worktree
- **缺点**：Worker 需要等 ACK 才能算"docs 真的入 git"；DocsCommitter 单点串行可能成为吞吐瓶颈（实际可忽略，因为 docs commit 比 chain 任务本身快得多）

#### B3 — 完全延迟到 close_chain 由 Leader 一次性 commit
- Worker 完全不管 docs commit
- Leader 在 close_chain 末尾 `git add docs/ memory/ && git commit -m "chain <id>: ..."`
- **优点**：零新机制
- **缺点**：commit 粒度粗；事后无法追溯"哪个 Worker 加了哪份 docs"；若 chain 中途失败，所有 docs 都不入库

### 10.6 推荐流程图（最终形态）

```
[Worker 完成 chain-link 任务]
   ├─ commit-checker.ts: execFileSync git add/commit ★仓库A worktree内（保留现状）
   ├─ 若 <co_root>/docs/<Name>/ 有写入 → EvalDecision 附带 docs_changed.paths
   └─ 发送完成消息 + EvalDecision JSON 给 Leader

[Leader 收到 Worker 完成消息]
   ├─ chain-router.ts: per-link merge（替代或并行于 close_chain 批量合并）
   │    execFileSync git checkout <mainBranch>
   │    execFileSync git merge <link-branch> --no-ff -m <safe-msg>
   │    冲突 → pushMergeConflictRetries；成功 → 记 chain-audit
   ├─ 若 docs_changed → DocsCommitter (单线程) 串行 commit CO root
   └─ 路由下一 link 任务

[下一个 Worker 准备新任务（或重试任务）]
   └─ watcher.ts: 在 claim 任务之后、render 模板之前：
        execFileSync git fetch (仅当配置了 remote)
        execFileSync git rebase <mainBranch>  ★仓库A worktree内
        失败 → 报 leader，worker 状态置 "needs_attention"
```

### 10.7 实施前置（这些不修，新流程跑不动）

| 前置 | 原因 |
|---|---|
| **Bug-1（`isCommitMerged` 误报）** | per-link merge 会和 close_chain 一样被静默 skip |
| **Bug-2（merge -m 注入）** | per-link merge 频率更高，含特殊字符 commit message 直接挂或被注入 |
| **Issue-4（mainBranch 取 HEAD）** | per-link merge 需要稳定 target；不能每次取 HEAD |
| **Issue-5（无 fetch/pull）** | Worker pre-task rebase 必须能 fetch；否则只能 rebase 本地 main |

### 10.8 用户原问题回答

> **确认一下这样的工作流程是否合理？**

**方向上完全合理**（持续集成胜于 close_chain 批量合并），但具体落地需要三点修正：
1. **拆开仓库 A 与仓库 B 的处理**：仓库 A 沿用 per-worker 分支 + 显式 merge；仓库 B 用 Leader 串行 DocsCommitter（B2）。
2. **git 命令一律走 `execFileSync`**，claude-cli 只用于生成 commit message / 解释冲突。
3. **先修 Bug-1 / Bug-2 / Issue-4 / Issue-5 四项前置**，否则新流程会复刻旧流程的失败模式。

> **CO root commit 混乱的解决方案？**

推荐 **B2（Leader 单线程 DocsCommitter）**：Worker 只写文件并通过现有消息通道上报变更路径，Leader 串行 `git add <paths> && git commit -F <msg-file>`。这是相对于 B1（双倍 worktree）和 B3（粒度过粗）的折中点，且与"Leader 是机械路由器"的现有定位完全一致。
