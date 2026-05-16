# docs/v0.6/workflow 评估报告

本报告以 `docs/v0.6/workflow/` 为基线，逐项对照现有代码实现，重点回答两个问题：

1. **责任链设计是否完整**：plan→build→verify→review→accept 五环节在文档与代码层是否一致？
2. **回退路径是否完备**：任意阶段验证不通过、accept 签字之后再发现问题时，链路如何处理？

> 注：仓库已迁至 monorepo 结构，代码路径前缀为 `packages/{leader,worker,coordination,contracts}/src/`，与 `CLAUDE.md` 中描述的 `src/` 单包路径不同。本报告按实际路径引用。

---

## 1. 责任链结构对照

### 1.1 文档基线声明

| 环节 | 角色 | 文档位置 | 默认 feedback 目标 | EvalDecision 触发分支 |
|------|------|----------|--------------------|--------|
| Plan | Tom (planner) | 02-plan-link.md §5 | 自己（retry 同 link） | activate_next / feedback / reject |
| Build | Jerry (builder) | 03-build-link.md §6.8.1 | 自己（retry 同 link） | activate_next / feedback / reject |
| Verify | Lucy (verifier) | 04-verify-link.md §7.9.1 | **Builder**（PREV_LINKS["verify"]="build"） | activate_next / feedback / reject |
| Review | Mia (reviewer) | 05-review-link.md §8.7 | **Verifier**（需显式 feedback_target 才能跨级） | activate_next / feedback / reject |
| Accept | Leo (acceptor) | 06-accept-and-close.md §9.7 | **Reviewer**（默认上一环） | close_chain / feedback / reject |

### 1.2 代码实现（验证）

- `packages/leader/src/chain-router.ts:36-50` 中 `NEXT_LINKS` / `PREV_LINKS` 与文档完全一致：plan→build→verify→review→accept→(null)；accept 是终点
- `packages/worker/src/evaluator.ts:16-22` `CHAIN_LINKS` 同上
- `packages/contracts/src/schemas/eval.ts:5-34` 定义 `EvalDecisionSchema` 为四变体 discriminated union，与文档对齐

**结论**：链路结构与代码完全一致，4 决策分支全部实现，5 个 worker 角色 / template / skill 完整。

---

## 2. 场景 A：任意阶段验证不通过的处理（链路内反馈）

### 2.1 文档与实现一致的"理想路径"

以"Verify 发现 Build 不达标"为例，代码路径如下：

1. Lucy 自评估输出 `{"decision":"feedback","reason":"...","feedback_to_worker":"...","feedback_target":null}` — `packages/worker/src/evaluator.ts:56-128`
2. `packages/worker/src/watcher.ts:465-517` `sendCompletionReport()` 打包发给 Leader
3. `packages/leader/src/chain-router.ts:422-433` 进入 feedback case
4. `resolveFeedbackTarget()` (`chain-router.ts:505-519`)：优先级 ① 显式 target → ② `manifest.link_workers["build"]` → ③ `msg.from_instance`
5. `dispatchFeedbackAsRetry()` (`chain-router.ts:531-597`)：
   - `prevLink = PREV_LINKS["verify"] = "build"`（line 545）
   - `lookupPriorRetry()` 查 build 链当前 retry_count（611-638 行）
   - `task_queue.push()` 创建新 task：`retry_count++`、`description = feedback_to_worker`、`assigned_to = jerry-01`、`link = "build"`
   - `chain_audit.setLinkTask("build", new_task_id)`，记录 `feedback_sent` 事件
6. Jerry claim 新 retry task，跑标准流程；旧 build completed task 留在 `/tasks/completed/` 供审计

此路径在 Verify→Build / Review→Verify / Accept→Review 三种"单步回退"场景都工作正常。

### 2.2 严重缺陷（代码级证据）

#### 缺陷 A1 — 反馈循环无硬上限 / 无 circuit breaker

- `retry_count` 在每次反馈都递增（`chain-router.ts:560`）
- **全代码库无任何"if retry_count > N then reject"的检查**
- `packages/worker/src/evaluator.ts:24` 的 `MAX_RETRIES = 3` 仅用于自评估生成 JSON 失败的重试，与反馈循环无关
- `packages/leader/src/recovery.ts:11` 的 `MAX_RETRIES = 3` 仅用于孤儿任务恢复，与反馈循环无关
- 后果：A→B→A→B 可无限循环，最终堆满 ZK task queue 与 cache，唯一止损是人工 kill

#### 缺陷 A2 — Worker 无法主动跨级反馈

- 默认 feedback 只回退一步（PREV_LINKS）
- Review 想直接回 Builder、Accept 想直接回 Builder 的常见场景下，需要显式 `feedback_target`
- 但 Worker（在自己的 worktree 子进程中）**没有读取 chain manifest 的能力**，拿不到上游 worker 的 instance_id
- `templates/agents/worker-reviewer.md:1-21` 和 `templates/agents/worker-accepter.md:1-21` 完全没有提及 feedback_target 怎么填
- `templates/agents/worker-evaluate.md:52-57` 和 `templates/agents/worker-evaluate-format-hint.md:10-20` 仅示例 `"feedback_target": null`
- 后果：跨级反馈在实际产品中几乎不可用；只能依赖默认的"一步一步往回退"，但中间环节并未真正发现问题

#### 缺陷 A3 — 跨级反馈时下游环节的旧产出不会自动失效

- 假设 Review 显式 feedback 给 Builder
- 新 build retry task 创建，retry_count++
- 但旧的 verify completed task 仍在 `/tasks/completed/`，`manifest.link_tasks["verify"]` 仍指向旧 task_id
- 新 build 完成 activate_next → verify 时，`findOrCreatePendingTask()` (`chain-router.ts:650-667`) 会重新分配 verify 任务；但语义上**旧 verify 报告是基于旧 build 跑的，已经无效**
- 文档 04/05 未说明这种"跨级反馈下游级联失效"的语义
- 后果：审计轨迹混乱；reviewer 可能基于过时的 verify 产出继续工作

#### 缺陷 A4 — 默认 feedback_target 的 fallback 不当

- `resolveFeedbackTarget()` 第 ③ 级 fallback 是 `msg.from_instance`，即报告者自己（`chain-router.ts:518`）
- 若 chain_audit 为空或 manifest.link_workers[prev] 缺失，feedback 会派回给报告者自己
- 后果：worker 收到自己发出的 feedback，可能产生死循环或语义混乱；应至少 warn 或 escalate

#### 缺陷 A5 — 自评估 3 次失败强制推进

- `packages/worker/src/evaluator.ts:115-127`：当 evaluator 3 次都拿不到合法 JSON 时，强制输出 `{"decision":"activate_next", "reason":"auto-advance from <link> after 3 eval failures", "next_link":"<NEXT_LINKS[link]>"}`
- 当 link = "accept" 时，fallback 是 `close_chain`（因 NEXT_LINKS["accept"]=null）
- 后果：**accept 环节如果连续 3 次自评估失败，会被自动 close_chain 当成"完成"**；质量门反向失效

#### 缺陷 A6 — commit 失败但 task 完成

- `packages/worker/src/commit-checker.ts` 中 `git commit` 失败 → 返回 null；但 task 仍走完 complete 流程
- 后果：close_chain 时 `chainCommits` 中缺该环节的 commit，MergeValidator 跳过该环节合并，主线缺一环代码

---

## 3. 场景 B：签字（close_chain）之后的回退

### 3.1 文档基线声明

`docs/v0.6/workflow/06-accept-and-close.md` §9.7-9.10 与 README 治理项只描述 Accept 的三种决策：
- `close_chain` → MergeValidator 自动合并 → manifest.status="completed"
- `feedback` → 物化 retry task 回 Reviewer（NO-GO 路径）
- `reject` → manifest.status="aborted"，不合并

**文档完全没有提及**："close_chain 之后如何回退"或"completed 状态后再次开启"。

`appendix-state-reference.md` 第 369 行（唯一相关）：
> "Leader 重启会丢失尚未触发 close_chain 的 commit 记录；这是已知接受的边界（重启后需要重新跑链或人工补 merge）。"

隐含语义：**close_chain 后链不可回退**。

### 3.2 代码实现（验证文档隐含语义）

`packages/leader/src/chain-router.ts:435-445` close_chain case 执行四步：
1. `runMergeValidation(chain_id)` — 遍历 commits，逐个 `merge_validator.validate(commit)`
2. `chain_audit.closeChain(chainId, "completed")` — 写 manifest.status
3. `emitChainClosed(chainId)` — TUI 事件
4. `forgetChain(chainId)` — `this.chainCommits.delete(chainId)`（`chain-router.ts:138-140`）

**关键事实**：
- 代码库**没有 `reopenChain()` / `resumeChain()` / `replayChain()` 任何方法**
- `ChainAudit.closeChain()` (`packages/leader/src/chain-audit.ts:189-212`) 只写 manifest.status 和 completed_at，未保留"恢复点"
- TUI 没有"重开 / 暂停 / 强制回退"的命令；只能输入新需求开新链

### 3.3 严重缺陷（代码级证据）

#### 缺陷 B1 — close_chain 单向不可逆

- 无 reopenChain API
- 用户唯一的"回退"路径：开一条全新的 chain（新 chain_id），不知道前一链上下文，无法复用 plan/build 产出
- 后果：accept 后任何回归发现的问题，重做成本极高

#### 缺陷 B2 — 重用 chain_id 会污染审计轨迹

- 若用户（或调用者）意外发送相同 chain_id 的新需求
- `ChainRouter.handleTaskDefinitions()` (`chain-router.ts:220-336`) 调用 `chain_audit.openChain()` (`chain-audit.ts:244-255`)
- openChain 会**硬覆盖** manifest.status 回 "running"，但 completed_at 保留旧值
- audit.jsonl 追加新事件，无冲突检测
- 后果：审计文件出现"completed → running → completed"的混乱轨迹，无 warning

#### 缺陷 B3 — 合并冲突被 swallow，链已 completed 无法修正

`packages/leader/src/merge-validator.ts:37-81`：
- merge 冲突时 try/catch `git merge --abort`，主线未污染（**这点是好的**）
- 但向上抛 `MergeConflictError`

`packages/leader/src/chain-router.ts:476-492` `runMergeValidation()`：
```typescript
for (const commit of commits) {
  try {
    await this.opts.merge_validator.validate(commit);
  } catch (err) {
    this.opts.logger.warn("merge validation failed", { ... });
  }
}
```
- 所有错误被 `logger.warn` 吞掉，循环继续
- 后续 commit 继续 validate，**没有"前面冲突，后面也 skip"或"全部回滚"的逻辑**
- 此时 close_chain 已执行完毕，manifest 已标 "completed"
- 后果：可能出现"plan/build commit 合并成功 + verify commit 冲突 abort + review/accept commit 合并成功"的诡异主线状态，且系统认为"链已完成"

#### 缺陷 B4 — MergeValidator 失败不通知用户、不创建 retry task

- `runMergeValidation` 仅 `logger.warn`，**没有**：
  - 发任何 TUI 事件提醒用户
  - 创建新 retry task 让 Builder 修复冲突
  - 暂停链关闭流程
- 后果：合并失败完全是"无声失败"；用户从 TUI 上看到 `chain_closed("completed")` 时，可能并不知道有 commit 没合进去

#### 缺陷 B5 — accept 自评估 fallback 会"假装签字"

- 见 §2.2 缺陷 A5：accept 自评估 3 次失败时，evaluator.ts 强制 fallback 为 `close_chain`
- 这会**绕过 Leo 的真实判断**，直接触发自动合并流程
- 后果：accept 环节最关键的"二元 GO/NO-GO"决策可能被格式失败的 fallback 顶替

#### 缺陷 B6 — 缺少"持续验证"概念

- merge 到主线 ≠ deploy；deploy 之后的回归测试无机制
- 文档与代码都没有"merge 后再跑一遍 CI/test"的钩子
- 用户问"签字以后是否能持续回归"，当前答案是：**完全不能**

---

## 4. 责任链完整性的整体评价

### 4.1 已做到的

- 5 环节齐全，角色/template/skill 完整
- 4 决策类型 + manifest 持久化 + retry task 物化 + 自评估 fallback
- 单步反馈在 Verify→Build / Review→Verify / Accept→Review 工作正常

### 4.2 设计层面的缺口（汇总）

| # | 缺口 | 类型 | 影响 |
|---|------|------|------|
| 1 | 反馈循环无硬上限 | 实现 | 资源耗尽，无止损 |
| 2 | Worker 无法跨级反馈（拿不到 instance_id） | 设计 | 跨级回退不可用 |
| 3 | 跨级反馈时下游产出不自动失效 | 设计+文档 | 审计混乱 |
| 4 | 默认 fallback 反馈给报告者自己 | 实现 | 死循环风险 |
| 5 | 自评估 3 次失败强制推进/close_chain | 实现 | 质量门反向失效 |
| 6 | commit 失败但 task 完成 | 实现 | 主线缺代码 |
| 7 | close_chain 单向不可逆 | 设计 | 签字后无回退 |
| 8 | 重用 chain_id 污染审计 | 实现 | 轨迹混乱 |
| 9 | 合并冲突 swallow，链仍 completed | 实现 | 半合并态主线 |
| 10 | 合并失败不通知用户 / 不创建 retry | 实现 | 无声失败 |
| 11 | 缺少"持续验证 / 发布后回归"环节 | 设计 | 整链一次性 |
| 12 | plan 可选但 worker-planner.md 未说明 | 文档 | 不一致 |

---

## 5. 建议

### 5.1 文档层面应补的章节

1. **`06-accept-and-close.md`** 增加"签字后回退"章节，明确：当前不支持，回退唯一路径是开新链；将该限制列入"已知接受的边界"
2. **`04/05/06`** 增加"跨级反馈语义"段落：Review/Accept 显式 `feedback_target` 跨级时，中间环节旧产出如何处理？manifest.link_tasks 如何重置？
3. **`worker-reviewer.md` / `worker-accepter.md`** 给出 `feedback_target` 的具体填写指引（包含如何在 prompt 中暴露上游 worker 的 instance_id）
4. **README 治理项** 列出当前已知边界：无反馈循环上限 / 无 close_chain 逆转 / merge 失败 swallow / accept 自评失败 fallback close_chain

### 5.2 代码层面（若后续要支持持续回归）

1. **chain manifest 加 `total_retry_count` 与 `max_retries` 字段**：超过阈值时 ChainRouter 自动 reject 并通知用户
2. **MergeValidator 失败时**：在 `runMergeValidation` 内 catch 后 push 一条 retry task 回 Builder，并在用户决定前阻止 `closeChain("completed")`
3. **引入 `ChainAudit.reopenChain(chainId)` API**：把 manifest.status 从 completed 改回 running，记 audit 事件 `chain_reopened`
4. **TUI 增加命令**：`/abort <chain_id>`、`/replay <chain_id> <link>`、`/reopen <chain_id>`
5. **evaluator fallback 改为 reject**：连续 3 次自评失败时输出 `reject` 而非 `activate_next`/`close_chain`，避免质量门反向失效
6. **跨级反馈机制**：在 prompt 中向 worker 注入 `{{prev_link_workers_json}}`（manifest.link_workers 的 JSON），让 worker 能选择跨级目标

---

## 6. 关键文件索引

### 代码（monorepo）

- `packages/leader/src/chain-router.ts`：NEXT/PREV_LINKS（36-50）、handleCompletionReport（374-459）、resolveFeedbackTarget（505-519）、dispatchFeedbackAsRetry（531-597）、lookupPriorRetry（611-638）、runMergeValidation（476-492）、forgetChain（138-140）、findOrCreatePendingTask（650-667）
- `packages/leader/src/chain-audit.ts`：closeChain（189-212）、setLinkTask（109-132）、setLinkWorker（134-164）、readManifest
- `packages/leader/src/merge-validator.ts`：validate（37-81）、merge abort（59-76）
- `packages/leader/src/recovery.ts`：MAX_RETRIES=3（11，仅用于孤儿）
- `packages/worker/src/evaluator.ts`：CHAIN_LINKS（16-22）、MAX_RETRIES=3（24）、fallback 强制推进（115-127）
- `packages/worker/src/watcher.ts`：sendCompletionReport（465-517）
- `packages/worker/src/commit-checker.ts`：commit 失败返回 null
- `packages/coordination/src/task-queue.ts`：push / claim / complete
- `packages/contracts/src/schemas/eval.ts`：EvalDecisionSchema 4 变体（5-34）
- `packages/contracts/src/schemas/chain.ts`：Chain.tasks 结构，plan 可选（16-22）

### 文档基线（workflow）

- `docs/v0.6/workflow/README.md`（治理项基线）
- `docs/v0.6/workflow/02-plan-link.md` §5.8.2 / §5.9.3
- `docs/v0.6/workflow/03-build-link.md` §6.8.1
- `docs/v0.6/workflow/04-verify-link.md` §7.7 / §7.9.1
- `docs/v0.6/workflow/05-review-link.md` §8.7（Review feedback 默认到 Verifier）
- `docs/v0.6/workflow/06-accept-and-close.md` §9.7 / §9.9 / §9.10
- `docs/v0.6/workflow/appendix-state-reference.md` §C.4-C.6、第 369 行（重启边界）

### 模板（缺失指引）

- `templates/agents/worker-reviewer.md`：未教 feedback_target
- `templates/agents/worker-accepter.md`：未教 feedback_target
- `templates/agents/worker-evaluate.md`：feedback_target 仅示例 null
- `templates/agents/worker-evaluate-format-hint.md`：feedback_target 仅示例 null
