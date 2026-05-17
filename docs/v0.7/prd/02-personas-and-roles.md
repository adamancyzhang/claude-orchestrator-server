# 02 — 用户画像与角色体系

> **文档定位**：定义系统的用户类别（谁会用），以及系统内的 6 个 role（Leader 与 5 个 Worker role）的职责、权重、隔离机制与身份注入方式。

## 1. 用户画像

| 用户类别 | 典型动作 | 接触面 |
|---------|---------|-------|
| **操作员** | 启动 `run --worker N`、在 TUI 输入需求、按 Tab/数字键观察 Worker、Ctrl+C 关停 | TUI 全部 6 面板（TEAM / PENDING / IN PROGRESS / WORKER MESSAGES / EVENT LOG / INPUT） |
| **验收人** | 按 `acceptance-checklist.md` 逐项勾选；查 chain manifest / audit.jsonl 判定 done | ChainAudit 输出 + ZK 节点状态 |
| **开发者（定制方）** | 写/改 `templates/agents/*.md`、`templates/claude-memory/*.md`、`skills/*`、`hooks.*` shell 脚本 | 配置文件 + 模板目录 + skills 目录 |

PRD 只描述上述 3 类用户在产品形态下的预期体验；系统内 6 个 role 是系统本身的工作者，不是用户。

## 2. 系统内 6 个 role 全景

| role | 责任链位置 | 核心职责 | 默认 system prompt |
|------|-----------|---------|-------------------|
| `leader` | 协调者（不在链中） | 接收需求 → 拆解任务链 → 调度 Worker → 跟踪闭环 → 合并到 main | 由 `worker-decompose.md` / `worker-merge-decision.md` 临时承载 |
| `planner` | 链首：定义 | 把握整体方向、定义任务蓝图、拆解执行路径 | `templates/agents/worker-planner.md` |
| `builder` | 链中：执行 | 按蓝图实现代码，产出可验证的 commit | `templates/agents/worker-builder.md` |
| `verifier` | 链中：验证 | 验证 Builder 产出与蓝图的一致性，发现偏离 | `templates/agents/worker-verifier.md` |
| `reviewer` | 链中：审查 | 审查产出是否符合设计意图，签发 Pass/Revise | `templates/agents/worker-reviewer.md` |
| `accepter` | 链尾：验收 | 从业务需求角度签 Go/No-Go | `templates/agents/worker-accepter.md` |

每个 role 同时拥有一份责任链 skill（`.claude/skills/task-{planning|execution|verification|review|acceptance}`）与一份 per-task wrapper 模板（`worker-{role}-task.md`），所有 role 共享底层 `task-traceability` 流程（Trace → Execute → Map → Evidence → Record）。

## 3. 名称 - 角色解耦

### 3.1 名称池

20 个拟人化名称：`Tom / Jerry / Lucy / Thomas / Jack / Lisa / Mike / Anna / Bob / Mia / Leo / Emma / Sam / Olivia / Noah / Ava / Lucas / Sophia / Ethan / Isla`。

按启动顺序无重复分配。如名称不足，循环复用 `<name>2`、`<name>3` 后缀。

### 3.2 角色按优先级填充

启动时按 `planner > builder > verifier > reviewer > accepter` 顺序填充：

- 5 Worker：每个 role 各 1 个
- 6 Worker（默认）：填到 accepter 后，第 6 个再补一个 builder（覆盖"build 是瓶颈"的典型负载）
- N > 6：第 7 个以后均为 builder

### 3.3 名称-角色绑定持久化

绑定关系写入项目根 `.claude-orchestrator/config.json` 的 `worktree` 段落：

```json
{
  "worktree": {
    "Tom":    { "name": "Tom",    "role": "planner",  "path": "...", "branch": "claude-orchestrator/Tom-workspace",    "instance_id": "..." },
    "Jerry":  { "name": "Jerry",  "role": "builder",  "path": "...", "branch": "claude-orchestrator/Jerry-workspace",  "instance_id": "..." },
    "Lucy":   { "name": "Lucy",   "role": "verifier", "path": "...", "branch": "claude-orchestrator/Lucy-workspace",   "instance_id": "..." },
    "Thomas": { "name": "Thomas", "role": "reviewer", "path": "...", "branch": "claude-orchestrator/Thomas-workspace", "instance_id": "..." },
    "Jack":   { "name": "Jack",   "role": "accepter", "path": "...", "branch": "claude-orchestrator/Jack-workspace",   "instance_id": "..." }
  }
}
```

第二次启动若同名 worktree 已存在则跳过创建（InitChecker 幂等）。

## 4. role 是权重，不是身份

Worker 启动时的 `role` 字段是任务认领排序时的偏好分。`@co/contracts/roleWeights.ts` 中的 role × link 权重表：

| role | plan | build | verify | review | accept |
|------|------|-------|--------|--------|--------|
| planner  | **100** | 10  | 10  | 20  | 10  |
| builder  | 10  | **100** | 20  | 10  | 10  |
| verifier | 10  | 20  | **100** | 20  | 10  |
| reviewer | 20  | 10  | 20  | **100** | 20  |
| accepter | 10  | 10  | 10  | 20  | **100** |
| leader   | 0   | 0   | 0   | 0   | 0   |

权重 100 表示首选；非 0 表示可兜底（任意 Worker 在 idle 时都能被派发任意 link 的任务）。

### 4.1 认领优先级

`TaskQueue.claim()` 排序复合键：

1. `assigned_to == self.id`（显式指派，最高优）
2. `roleWeight(self.role, task.link)` 倒序
3. `priority` 升序（HIGH=0 最优先）
4. `task_id` FIFO

效果：

- planner 优先认领 plan 任务
- 无 plan 任务时按权重转向其它 link
- 显式 `assigned_to` 始终优先（用于 merge_failed 派回原 Builder、commit failure 派回同 Worker）

### 4.2 跨角色协助

当 build link 任务积压且所有 builder 都忙时，空闲的 verifier / reviewer 会按权重表（verifier→build=20，reviewer→build=10）兜底认领；TUI TEAM 面板对应 Worker 行的 Current Role 显示 `Builder ◀←`（箭头标记本次为跨角色）。

## 5. Worker 物理隔离

### 5.1 git worktree 分目录

```
<project>/.claude-orchestrator/worktree/
├── Tom/        # branch: claude-orchestrator/Tom-workspace
├── Jerry/      # branch: claude-orchestrator/Jerry-workspace
├── Lucy/       # branch: claude-orchestrator/Lucy-workspace
├── Thomas/     # branch: claude-orchestrator/Thomas-workspace
├── Jack/       # branch: claude-orchestrator/Jack-workspace
└── Lisa/       # branch: claude-orchestrator/Lisa-workspace
```

| 隔离维度 | 实现 |
|---------|------|
| 文件系统 | Worker 启动后 `process.chdir(worktreePath)` |
| Git 状态 | 独立分支，互不污染；commit 只在自己分支上 |
| 进程内存 | `fork(child.js)` 独立子进程 |
| 错误传播 | 子进程崩溃不影响 Leader 与其它 Worker；父进程死 → Worker 1 Hz 自杀 |
| 任务输入 | ZK `/messages/{instance_id}/msg-*` 隔离的收件箱 |
| 日志输出 | `cache_dir/{leader_id}/tasks/<task_id>/exec-*.log`（chain 共享）+ `docs/<worker>/<date>/<prefix>-<chain_id>.md`（worker 自留） |

### 5.2 创建幂等

`WorktreeInitializer` 检测 worktree 已存在 → 跳过 `git worktree add`；检测 config.json 中已有 instance_id → 复用，不重生成。这让 Leader 崩溃重启不会重建已有 Worker。

## 6. 身份注入：三段拼接

每次 `claude -p` 调用时通过 `--append-system-prompt` 注入身份卡。身份卡 = 三段顺序拼接：

```
<worker-identity.md 渲染结果>
+
<templates/claude-memory/personal-claude-{role}.md 渲染结果>
+
<templates/agents/worker-{role}.md 内容>
```

### 6.1 第一段：worker-identity.md

```markdown
## Worker Identity
You are **{{name}}**, a **{{role}}** in the multi-agent orchestration system.
- Name: {{name}}
- Role: {{role}}
- Worktree: {{worktreePath}}
- Branch: {{worktreeBranch}}
- Instance: {{instanceId}}
```

5 个驼峰占位符由 `ClaudeRunner.buildIdentityPrompt()` 替换。

### 6.2 第二段：角色专属 memory

`templates/claude-memory/personal-claude-{role}.md` 在 worktree 初始化时 `{{name}}` / `{{role}}` 替换后写入 `~/.claude-orchestrator/projects/<leader_id>/docs/<name>/CLAUDE.md`。Worker 任务流程头部会 Read 这份 memory。

### 6.3 第三段：role 常驻规则

`templates/agents/worker-{role}.md` 原样拼接，定义 role 的工作流（如 verifier 必须先列证据再下结论）。

### 6.4 身份/任务分离 → prompt cache 命中

身份卡内容与每条任务正交（身份不变 → system prompt cache 命中），任务内容通过 `-p` 注入 user prompt：

```bash
claude --append-system-prompt '<3 段身份卡>' \
  -p '<本次任务正文>'
```

效果：长期运行后 system prompt cache 命中率高，每条任务的实际计费 token 主要是 user prompt 部分。

## 7. 引用

- 完整 5 个 Worker 身份卡实例：`../../rc0-v0.6/workflow/00-identity-cards.md` §5
- role × link 权重表的代码定义：`packages/contracts/src/roleWeights.ts`
- 名称池：`packages/orchestrator/src/worktree-initializer.ts`
