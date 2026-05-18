# 06 — 已知边界（v0.6 不做、不保证）

> **文档定位**：v0.7 PRD 明确声明**不保证、不实现**的能力。验收人遇到这些场景时不应当作 v0.6 缺陷上报，应判断是否纳入 v0.7+ roadmap。开发者新增功能前需先确认是否触及这些边界。
>
> 每条边界给出：当前行为 / 用户影响 / 回避方法 / v0.7 是否计划修复（候选 / 不计划 / 保留）。

## 1. 链路与流程边界

### 1.1 close_chain 单向，不可逆开

- **当前行为**：链关闭（status = `completed` / `aborted` / `merge_failed` / `failed`）后，无 API 重新激活
- **用户影响**：accept 签字后任何回归发现的问题，需新建 chain 重做；不可复用旧 chain 的 plan/execute 产出
- **回避方法**：开新需求时使用新的 chain_id；写新 plan
- **v0.7 是否修复**：候选。引入 `chain_audit.reopenChain(chainId)` API + `/abort` / `/replay` / `/reopen` 三个 TUI 命令

### 1.2 跨级 feedback 实用性受限

- **当前行为**：默认 feedback 只回退一步（PREV_LINKS）。Worker 可显式提供 `feedback_target` 跨级，但 Worker 在自身 worktree 子进程中无法读 chain manifest 获取上游 worker 的 instance_id，因此跨级 target 实际只能由人工注入
- **用户影响**：Review 想直接退给 Executor、Accept 想直接退给 Executor 的场景受限
- **回避方法**：依靠默认的"一步一步往回退"路径；保证每个中间 link 都能正确反馈
- **v0.7 是否修复**：候选。在 worker prompt 中注入 `{{prev_link_workers_json}}`（manifest.link_workers 的 JSON）让 Worker 能选择跨级目标

### 1.3 跨级 feedback 下游产物不自动失效

- **当前行为**：即使发生跨级 feedback（Review 显式 feedback_target=Executor），中间 link（Verify）的旧 completed task 与 `manifest.link_tasks["verify"]` 仍指向旧 task_id；新 execute 完成 activate_next 时复用旧 verify pending task（如有）或新建
- **用户影响**：旧 verify 报告基于过时 execute 跑出，但仍可能影响 review 的输入
- **回避方法**：人工评估是否需清理 manifest；默认走单步反馈避免
- **v0.7 是否修复**：候选

### 1.4 反馈硬上限不可禁用

- **当前行为**：每条 chain 的总反馈次数 `max_total_retries` 默认 9，可通过 `CO_CHAIN_MAX_RETRIES` 环境变量覆写。超过上限链强制 `aborted`，无 bypass 选项
- **用户影响**：极少数复杂任务可能超过 9 次反馈
- **回避方法**：启动时 `export CO_CHAIN_MAX_RETRIES=N` 覆写
- **v0.7 是否修复**：可能调整默认值；不计划提供 disable 选项（防止资源耗尽）

### 1.5 无 deploy 后回归测试钩子

- **当前行为**：MergeValidator 完成 merge 到 main 后无任何 CI/test 触发；merge 是终态，不再有后续校验
- **用户影响**：merge 后出现的 regression 不会被本系统发现
- **回避方法**：CI 由项目层独立配置
- **v0.7 是否修复**：候选。增加 `merged_chain` 事件与 hook，便于挂接外部 CI

### 1.6 Plan 链节可选但模板默认仍生成

- **当前行为**：`ChainDef.tasks.plan` 在 schema 中可为 null，链可跳过 plan 直接从 execute 开始；但默认 `worker-decompose.md` 模板始终生成 plan
- **用户影响**：可定制化跳过 plan，但模板未提供示例
- **回避方法**：定制 `worker-decompose.md` 显式输出 `"plan": null`
- **v0.7 是否修复**：候选（文档与模板均给示例）

## 2. 进程与高可用边界

### 2.1 单 Leader、无热备

- **当前行为**：`/leader` EPHEMERAL 节点保证全局唯一；Leader 崩溃后所有 Worker 进入 idle 等待，需操作员重新执行 `run --worker N`
- **用户影响**：Leader 重启窗口期新任务不会被认领
- **回避方法**：监控 Leader 进程并配置自动重启
- **v0.7 是否修复**：不在 v0.7 范围。Leader HA 是 v0.x → v1 的候选

### 2.2 Worker 子进程崩溃重启上限 3 次

- **当前行为**：子进程崩溃父进程自动重启，最多 3 次；超过即认为不可恢复，标 `worker_left`
- **用户影响**：偶发故障可恢复；持续性故障会下线 Worker
- **v0.7 是否修复**：保留当前行为；可能开放配置项

### 2.3 ZK 临时断开自动重连上限 10 次

- **当前行为**：指数退避 10 次后放弃，进程退出
- **v0.7 是否修复**：保留

## 3. 协议与扩展边界

### 3.1 Hook 事件名不可扩展

- **当前行为**：固定 4 个 hook 事件：`worker_message_start` / `worker_message_end` / `task_claimed` / `task_completed`（外加 `task_recovered` / `task_failed`）。无法注册自定义事件
- **回避方法**：在已有事件中做差异化
- **v0.7 是否修复**：候选

### 3.2 不支持自定义 EvalDecision 分支

- **当前行为**：四态封闭（activate_next / feedback / reject / close_chain）；任何 schema-extra 字段被忽略
- **v0.7 是否修复**：不计划，扩展即协议破坏

### 3.3 协议版本字段强校验

- **当前行为**：`PROTOCOL_VERSION = "0.6.0"`，Worker 启动校验 `/leader` 的协议版本，不匹配即退出
- **用户影响**：多版本混跑被禁止
- **v0.7 是否修复**：保留

### 3.4 单 ZK 节点上限 1 MiB

- **当前行为**：ZK 原生限制；超 64 KiB 的 result 落盘以 `file://` 引用
- **v0.7 是否修复**：保留

## 4. 存储与上下文边界

### 4.1 无 `/context` ZK 路径

- **当前行为**：v0.5 设计中曾规划 `/context` 树（Worker 之间共享上下文），v0.6 未实现
- **回避方法**：使用 chain manifest 的 `link_tasks` + result.md 路径实现跨 link 上下文
- **v0.7 是否修复**：不计划，chain manifest 已覆盖此需求

### 4.2 无 completed task TTL 自动清理

- **当前行为**：`/tasks/completed/` 子节点永久保留；cache 下 `tasks/<task_id>/` 目录永久保留
- **用户影响**：长期运行后 ZK 节点数 / 磁盘使用线性增长
- **回避方法**：定期人工清理；或 cron 删除过期节点
- **v0.7 是否修复**：候选

### 4.3 Workspace memory 仅镜像 `packages/**/*.ts`

- **当前行为**：bootstrap 与 stale-refresh 只覆盖 `packages/**/*.ts`；不镜像 `tests/`、`docs/`、`templates/`、`skills/`、`scripts/`
- **用户影响**：非 TypeScript 源码变更不会触发 memory 更新
- **回避方法**：扩展 `MemoryBootstrap.enumerateSources` 自行加入规则
- **v0.7 是否修复**：候选

### 4.4 Worktree 复用 + `reset_on_reuse=true` 有损清理 **[v0.7 NEW]**

- **当前行为**：orchestrator 启动时若发现 `<projects_root>/<worker_name>/` 已存在的 worktree，默认走"复用"路径：`git reset --hard <leader_head>` + `git clean -fd`，**丢弃 worktree 中所有未 commit 的变更**
- **用户影响**：人工在 worktree 中遗留的实验性代码 / 未 push 的本地 commit 会被清掉（提交到 worker 分支的 commit 仍保留在远端）
- **回避方法**：(a) 启动前 `git stash` 保护变更；(b) 显式禁用 `reset_on_reuse`（仅作为内部参数，需修改 worktree-initializer 调用，目前未对外暴露配置）
- **v0.7 是否修复**：不计划，复用 + 硬重置是 rc1 pre-task rebase 模型的前提（每个 link 必须从已知基线起步）

### 4.5 跨 chain 不传 `link_commits` / `upstream_commits` **[v0.7 NEW]**

- **当前行为**：spawn_chain 派生的子链开新 manifest，`link_commits={}`；子链的 plan link 不感知父链 worktree commit；pre-task rebase 在子链 plan 处无 upstream，跳过
- **用户影响**：子链是"从 main 重新出发"的独立链；若 Explorer `next_requirement` 隐含依赖父链未合并的代码，可能导致子链 verify / review 失败
- **回避方法**：父链必须先 close_chain merge 成功，再让 Explorer 启动子链；子链通过 main 上的合并 commit 间接看到父链产出（与 §1.1 close_chain 单向不可逆配套）
- **v0.7 是否修复**：不计划；跨 chain 上下文传递不是 v0.7 目标（PRD §6.1 已声明 Explorer 不读跨 chain 历史）

### 4.6 Docs commit best-effort，可缺失 **[v0.7 NEW]**

- **当前行为**：双轨 commit 中**轨 B**（CO root `docs/<worker_name>/`）使用 `git commit --only`、限定路径作用域，但若并发 Worker 同时写、`.git/index.lock` 抢锁失败，DocsCommitter 返回 `null` 而非抛错；`LinkCommitRecord.docs=null`；audit 仅 `log.error`，不进事件流
- **用户影响**：CO root 仓上可能漏掉某个 link 的 `result.md` commit（项目仓代码 commit 不受影响）；TUI 不感知；close_chain merge 不阻塞
- **回避方法**：(a) 排查 CO root 仓 `.git/index.lock` 是否长期残留；(b) 降低并发（`--worker 6` 已是最小值，无法再降）；(c) 查看 cache 下 `tasks/<task_id>/result.md` 与 CO root 的实际 docs 是否同步
- **v0.7 是否修复**：不计划；轨 B 是归档与追溯，不影响代码合并正确性，best-effort 是有意权衡

## 5. 测试与可观测性边界

### 5.1 stream_chunk 事件存在但未渲染

- **当前行为**：`packages/leader/src/tui/renderer.ts` 对 `stream_chunk` 返回空字符串，事件被吸收但不显示
- **用户影响**：Worker 子进程的 streaming 输出无法在 EVENT LOG 实时观察
- **回避方法**：`tail -f ~/.../tasks/<task_id>/exec-*.log`
- **v0.7 是否修复**：候选

### 5.2 TUI 无 unit test

- **当前行为**：tui/renderer 渲染逻辑通过 e2e 验证；缺少快照/单测
- **v0.7 是否修复**：候选

### 5.3 CLI 命令面狭窄

- **当前行为**：仅暴露 `run` 与 `config` 两个 CLI 命令。任务/消息/实例的 push/poll/claim 等操作不再以 CLI 形式开放（v0.5 曾有 13 命令）
- **用户影响**：脚本化操作需要直接读写 ZK 或封装新 CLI
- **回避方法**：使用 `@co/coordination` 包写自定义脚本
- **v0.7 是否修复**：候选（按需求）

## 6. v0.7 NEW：自主循环模式（`--magic`）边界

### 6.1 Explorer 不可读跨 chain 历史上下文

- **当前行为**：Explorer 在评估时只读到当前 chain 的 manifest 与各 link result.md，不读取 sibling chain 或祖先 chain 的产出
- **用户影响**：长跑式探索时缺乏全局记忆，可能在不同 chain 中重复提出相似需求
- **回避方法**：通过 workspace memory（FR-28 ~ FR-30）注入项目级共享状态；或人工在某轮 Ctrl+C 中断后注入新种子需求
- **v0.7 是否修复**：v0.7 内不计划；候选 v0.8

### 6.2 spawn_chain 不会继承 max_total_retries 余量

- **当前行为**：新 chain 的 `total_retry_count` 从 0 起算，与父 chain 解耦
- **用户影响**：单 magic 跑出 N 条链可能累计反馈次数远高于 9
- **回避方法**：通过 `--magic-max-chains` 控制总链数 + `CO_CHAIN_MAX_RETRIES` 控制单链
- **v0.7 是否修复**：保留当前行为（设计如此，避免父链反馈消耗子链余量）

### 6.3 magic 循环不自动停于"已达成"判断

- **当前行为**：是否停止 magic 循环完全由 Explorer 自评估的 `spawn_chain` / `close_chain` 决定；系统不提供"任务已经做完"的智能判断
- **用户影响**：Explorer 模板质量直接决定循环何时停；糟糕 prompt 可能让 Explorer 永远输出 `spawn_chain`
- **回避方法**：依赖 `--magic-max-chains` 兜底；定期审阅 Explorer 的 `worker-explorer.md` 模板与 chain manifest
- **v0.7 是否修复**：保留；不计划引入"任务完成度"自动判定

### 6.4 spawn_chain 仅在 explore link 合法

- **当前行为**：任何其它 link 输出 `spawn_chain` 被视作 ValidationError，链直接 reject 转 `aborted`
- **用户影响**：自定义模板若不慎让非 explorer 输出 spawn_chain 会触发链终止
- **回避方法**：审计模板，确保 `worker-{role}.md` 不含 `spawn_chain` 提示
- **v0.7 是否修复**：保留（封闭式协议，避免误用）

### 6.5 v0.7 与 v0.6 协议不兼容、不混跑

- **当前行为**：`PROTOCOL_VERSION = "0.7.0"` 强校验；v0.7 Worker 拒绝连接 v0.6 Leader，反之亦然
- **用户影响**：升级需停机重启全栈；运行中混跑被禁止
- **回避方法**：所有节点同步升级；保留 v0.6 包可回滚但不能并存
- **v0.7 是否修复**：保留（协议优先原则）

## 7. 必须通过验收的事项

为避免误把上述边界当作待修缺陷，明确以下场景必须纳入 v0.7 验收范围：

- 单链 P→E→V→R→A 全程顺利的"快乐路径"（默认模式）
- **[v0.7 NEW]** `--magic` 模式 P→E→V→R→A→Explore→（spawn_chain → 第二条链 → 第二条链完整闭环）的循环路径
- **[v0.7 NEW]** Explorer 输出 `close_chain` 终止循环路径
- **[v0.7 NEW]** `--magic-max-chains M` 达上限时 `spawn_chain` 被降级
- 任一链节 feedback 单步回退到上一链节
- Worker 子进程崩溃后 `task_recovered` + 子进程重启（≤3 次）
- close_chain 正常合并到 main
- close_chain 合并冲突路径走 `merge_failed` + Executor retry（FR-17 / R-02）
- commit 失败回退为 feedback（FR-21 / R-01）
- 反馈累计超过 `max_total_retries` 链转 `aborted`（FR-18 / R-04）
- 不可解析 feedback 静默丢弃（FR-19 / R-05）
- chain_id 重用冲突拒绝（FR-20 / R-06）
- evaluator 三连失败一律 `reject`（FR-22 / R-03）

A-* / R-* 编号体系沿用自 v0.6 RC0,旧 acceptance-checklist 文档已随 v0.6 目录移除；v0.7 验收以 `04-functional-requirements.md` 每条 FR 末尾的"done 判定"为准,v0.7 NEW 验收项已嵌入对应 FR 的判定列。
