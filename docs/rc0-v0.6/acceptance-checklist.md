# Acceptance Checklist — v0.6 RC0

> **文档定位**：v0.6 RC0 端到端验收清单。每项条目均可独立勾选，命中失败时按 `feature-matrix.md` 对应行追溯。验收人可分组分配；同组项可并行验证（除"启动 / TUI" 组必须先行）。
>
> **环境前提**：仓库已 `pnpm install && pnpm -r build` 完成；ZooKeeper 通过 `docker-compose up -d` 启动；`claude` CLI 已认证。所有路径假设项目根为当前工作目录。

---

## A 区：核心功能（A-01 ~ A-24）

### A-01 一键启动 `run --worker N`

- [ ] **A-01-1** 执行 `node packages/cli/dist/index.js run --worker 6`，进入 TUI 不报错
- [ ] **A-01-2** 执行 `node packages/cli/dist/index.js run --worker 5`，应报错 `\`--worker\` must be an integer >= 6`
- [ ] **A-01-3** 不带 `--worker` 时使用默认值 6
- [ ] **A-01-4** TUI 启动后 ZK `/claude-orchestrator/leader` 节点存在，6 个 `/instances/<id>` 节点为 EPHEMERAL

### A-02 五链责任链结构

- [ ] **A-02-1** `grep -n "NEXT_LINKS\|PREV_LINKS" packages/leader/src/chain-router.ts` 确认 plan→build→verify→review→accept→null
- [ ] **A-02-2** `grep -n "CHAIN_LINKS" packages/worker/src/evaluator.ts` 同步 5 项
- [ ] **A-02-3** TUI 输入"实现一个简单 hello-world"，观察 EVENT LOG 依次出现 `chain_activated` → `task_dispatch` 5 次（plan→…→accept）→ `chain_closed`

### A-03 EvalDecision 四态

- [ ] **A-03-1** 单测 `pnpm --filter @co/leader test` 中 `chain-router.test.ts` 全绿
- [ ] **A-03-2** activate_next 路径：plan 完成后 EVENT LOG 出现 `task_dispatch (build)`
- [ ] **A-03-3** feedback 路径：制造 verify 失败，观察 EVENT LOG 中 `task_dispatch (build)` 出现且 task description 包含原 feedback 文本
- [ ] **A-03-4** reject 路径：在 worker-evaluate.md 模板中临时让某 link 返回 reject，确认 `chain_closed (aborted)` 出现
- [ ] **A-03-5** close_chain 路径：accept link 输出 close_chain，链关闭、所有 commit merge 到 main

### A-04 ChainDef 拆解（plan 可选）

- [ ] **A-04-1** 在 `worker-decompose.md` prompt 中让 LLM 输出 `"plan": null` 的 ChainDef，观察首任务直接派发为 build
- [ ] **A-04-2** ZK `/tasks/pending/` 下应有 4 个任务节点（不包含 plan）

### A-05 角色权重表

- [ ] **A-05-1** `cat packages/contracts/src/roleWeights.ts` 与 `dd/contracts.md` §6 表格一致
- [ ] **A-05-2** TUI TEAM 面板显示每个 Worker 的角色与名称

### A-06 名称池 + 角色解耦

- [ ] **A-06-1** 启动 6 Worker，TEAM 面板显示 6 个名字来自 [Tom, Jerry, Lucy, Thomas, Jack, Lisa, ...]
- [ ] **A-06-2** 角色分配满足"planner > builder > verifier > reviewer > accepter"优先级
- [ ] **A-06-3** 启动 7 Worker，第 7 个为 builder 类（扩充 builder）

### A-07 Git Worktree 隔离

- [ ] **A-07-1** 启动后 `git worktree list` 显示 6 个 worktree，分支命名 `claude-orchestrator/<name>-workspace`
- [ ] **A-07-2** `cat .claude-orchestrator/config.json` 显示 worktree 段落含 6 个条目
- [ ] **A-07-3** 在 Worker 的 worktree 中 `pwd` 与主 worktree 不同

### A-08 身份注入

- [ ] **A-08-1** 启动并发任务后 `ps aux | grep claude` 看到子进程命令行包含 `--append-system-prompt`
- [ ] **A-08-2** 注入字符串包含"You are **<name>**, a **<role>**"
- [ ] **A-08-3** `templates/agents/worker-identity.md` 中的 5 个占位符已被替换

### A-09 TUI 六面板

- [ ] **A-09-1** 启动 TUI，能看到 TEAM / PENDING / IN PROGRESS / WORKER MESSAGES / EVENT LOG / INPUT 六个区
- [ ] **A-09-2** PENDING 面板新增任务时实时刷新
- [ ] **A-09-3** IN PROGRESS 面板显示 claimed 任务及其 owner
- [ ] **A-09-4** EVENT LOG 滚动显示最新 100 条事件

### A-10 TUI 键盘交互

- [ ] **A-10-1** Tab / Shift+Tab 切换 WORKER MESSAGES 面板焦点
- [ ] **A-10-2** 按 `1`-`9` 直接跳转到第 N 个 Worker
- [ ] **A-10-3** Enter 把输入发出（EVENT LOG 出现 `chain_activated`）
- [ ] **A-10-4** Backspace 删除最后字符；Escape 清空输入
- [ ] **A-10-5** `?` 切换 help 面板；Ctrl+C 关停所有子进程

### A-11 输入框路由

- [ ] **A-11-1** 输入"做一个登录功能"+回车，ZK `/messages/<leader_id>/msg-*` 多一条 `user_input`
- [ ] **A-11-2** 后续出现 `chain_activated` + 5 个 `task_created`

### A-12 `/init` slash 命令

- [ ] **A-12-1** TUI 输入 `/init` 回车，EVENT LOG 出现 `[debug] /init: bootstrap done`
- [ ] **A-12-2** `~/.claude-orchestrator/projects/<leader_id>/memory/CLAUDE.md` 存在
- [ ] **A-12-3** `~/.../memory/packages/leader/src/chain-router.md` 存在且 front-matter 含 `source_hash`
- [ ] **A-12-4** 重复 `/init`，第二次跳过已生成项

### A-13 `memory_refresh` 增量

- [ ] **A-13-1** 让 builder 修改 `packages/leader/src/chain-router.ts` 并提交，等待数秒
- [ ] **A-13-2** `~/.../memory/packages/leader/src/chain-router.md` 的 `source_hash` 已更新到最新

### A-14 `refreshStale` 检测

- [ ] **A-14-1** 手工修改一个源文件并 commit，不触发 worker；下次 `/init` 时，`stale entries refreshed` 出现

### A-15 自评估三连重试

- [ ] **A-15-1** `pnpm --filter @co/worker test` 中 `evaluator.test.ts` 全绿
- [ ] **A-15-2** 模拟 LLM 输出 junk JSON，观察 cache 下三个 eval-N.log 文件存在

### A-16 自动 commit

- [ ] **A-16-1** Builder 完成 build 任务后，其 worktree `git log -1` 显示新 commit
- [ ] **A-16-2** commit message 来自 `worker-commit-message.md`（首行 ≤ 72 字符）

### A-17 MergeValidator

- [ ] **A-17-1** chain close 时，cache 下 `merges/merge-*.log` 出现，包含 merge decision JSON

### A-18 close_chain → MergeValidator + closeChain

- [ ] **A-18-1** 跑通完整链，最后 main 分支含 5 个新 commit（每链节一个）
- [ ] **A-18-2** `~/.../chains/<chain_id>/manifest.json` 中 `status: "completed"` + `completed_at` 已写

### A-19 Recovery

- [ ] **A-19-1** 让某 Worker 子进程跑 build 时被 `kill -9`
- [ ] **A-19-2** Leader EVENT LOG 出现 `worker_left` → `task_recovered (retry 1)`
- [ ] **A-19-3** 主进程自动 fork 新 Worker 子进程；任务被认领续跑
- [ ] **A-19-4** 重复 kill 4 次后任务归档 `failed` 而非无限重试

### A-20 子进程自动重启

- [ ] **A-20-1** 单独 kill 一个 Worker 子进程，主进程在 EVENT LOG 中显示 `restart 1/3` 后重启
- [ ] **A-20-2** 三次重启后放弃，发 `worker_left`

### A-21 父进程死亡 → 自杀

- [ ] **A-21-1** kill 主进程，所有 Worker 子进程在 1 秒内退出（不变成孤儿）

### A-22 ChainAudit

- [ ] **A-22-1** 跑通一条链后 `~/.../chains/<chain_id>/manifest.json` 字段齐全（status, link_tasks, link_workers, total_retry_count, max_total_retries, requirement_path）
- [ ] **A-22-2** `audit.jsonl` 至少包含 events: chain_opened, requirement_received, task_dispatch ×5, completion_report ×5, chain_closed
- [ ] **A-22-3** `requirement.md` 内容与用户原始输入一致

### A-23 chain-shared cache

- [ ] **A-23-1** 跑通一条链后 `~/.../tasks/<task_id>/result.md` 5 份（每链节一份）
- [ ] **A-23-2** `~/.../docs/<worker>/<date>/<prefix>-<chain_id>.md` 各 worker 自留备份齐全

### A-24 Lifecycle hooks

- [ ] **A-24-1** 在 `~/.claude-orchestrator/config.json` 配 `hooks.worker_message_start = "echo $CO_TASK_ID >> /tmp/hook.log"`
- [ ] **A-24-2** 跑任意一链，`/tmp/hook.log` 至少有 5 行（每链节一次）

---

## R 区：REVIEW.md 修复验证（R-01 ~ R-06；R-07 含于 R-02）

### R-01 commit 失败 → feedback 回退（A1）

- [ ] **R-01-1** 在某 Worker worktree 中安装一个 `pre-commit` hook：`echo "no" >&2 && exit 1`
- [ ] **R-01-2** 让该 Worker 处理一个会写文件的 build 任务
- [ ] **R-01-3** EVENT LOG 出现 `task_dispatch (build retry…)` 回退给同 Worker（不是 close_chain 也不是 activate_next）
- [ ] **R-01-4** `~/.../chains/<chain_id>/audit.jsonl` 含 `feedback_sent` 事件，原因显示"commit failed"
- [ ] **R-01-5** 移除 hook，下次 retry 正常完成

### R-02 merge_failed + Builder retry + 用户可见（A2+A3）

- [ ] **R-02-1** 在 Builder worktree 与 main 上对同一文件构造无法自动合并的修改
- [ ] **R-02-2** 跑通链至 accept → close_chain
- [ ] **R-02-3** EVENT LOG 出现红色 `MERGE_FAILED chain <id>: 1 branch(es) [co/<name>-1] — retry tasks pushed`
- [ ] **R-02-4** Builder 收件箱出现新 task_dispatch，description 含 "Merge conflict on branch <branch> at <sha>"
- [ ] **R-02-5** `manifest.json` 中 `status: "merge_failed"` 而非 `"completed"`
- [ ] **R-02-6** Builder 解决冲突后再次提交，重新触发链路，最终 `status: "completed"` 且 main 含完整链 commit

### R-03 evaluator 一律 reject（A4）

- [ ] **R-03-1** `pnpm --filter @co/worker test -- -t "falls back to reject"` 通过 2 个用例
- [ ] **R-03-2** 在 accept link 临时让评估器 prompt 输出非法 JSON 三次，cache 下 eval-N.log 共 3 个；completion_report.content 解析后 `decision === "reject"`，不是 close_chain
- [ ] **R-03-3** ChainAudit manifest.status 转为 `aborted`，不是 `completed`

### R-04 反馈硬上限（A5）

- [ ] **R-04-1** 设 `export CO_CHAIN_MAX_RETRIES=2`，启动 TUI
- [ ] **R-04-2** 制造一条会无限相互 feedback 的链（让 verify 总是 feedback、build 又 feedback 回 verify）
- [ ] **R-04-3** 第 3 次反馈被阻止：EVENT LOG 出现 `[debug] chain <id> aborted: retry ceiling 2 exceeded`
- [ ] **R-04-4** `manifest.json` status = `aborted`，extra 字段含 `reason: "retry_ceiling_exceeded"`
- [ ] **R-04-5** `audit.jsonl` 含 `retry_ceiling_exceeded` 事件
- [ ] **R-04-6** 不设环境变量时默认 9

### R-05 不可解析 feedback 丢弃（A6）

- [ ] **R-05-1** 让 plan link 输出 feedback（无 explicit feedback_target 且 manifest 中无 plan 前置 link）
- [ ] **R-05-2** EVENT LOG 出现 `[debug] feedback for chain <id>/plan dropped: no resolvable target`
- [ ] **R-05-3** 没有任何新 task_dispatch 发出
- [ ] **R-05-4** `audit.jsonl` 含 `feedback_unresolved` 事件

### R-06 chain_id 冲突拒绝（A7）

- [ ] **R-06-1** 跑通一条链至 close_chain
- [ ] **R-06-2** 手工构造同样 chain_id 的 ChainDef 再次输入（可写测试脚本或 mock decompose）
- [ ] **R-06-3** EVENT LOG 出现 `[debug] chain <id> already completed; new requirement dropped`
- [ ] **R-06-4** `audit.jsonl` 含 `chain_id_conflict` 事件，原 manifest 未被覆盖

---

## 全量回归

- [ ] **G-01** `pnpm -r --workspace-concurrency=1 test` 全部包通过
- [ ] **G-02** `pnpm -r exec tsc --noEmit` 类型检查无错
- [ ] **G-03** `pnpm -r build` 全部包构建成功
- [ ] **G-04** `pnpm depcheck && pnpm pkgcheck` 依赖规则通过

---

## 验收结论

完成上述所有勾选项后填写：

- **执行人**：____________________
- **日期**：____________________
- **结论**：☐ Go（全部通过，可正式发布 v0.6） ☐ No-Go（hold 发布，问题清单见下）
- **未通过项**：____________________
