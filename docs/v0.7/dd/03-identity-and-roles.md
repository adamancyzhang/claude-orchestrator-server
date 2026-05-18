# 03 — 身份注入与角色分配

> **DD 定位**：name pool 与 role 优先级填充、Worktree 创建幂等算法、`buildIdentityPrompt` 三段拼接、`roleWeights` 认领排序，以及 **[v0.7 NEW]** explorer 模板字段。
>
> **PRD 锚**：FR-05 / FR-06 / FR-07 / FR-08 / FR-31（explorer 模板） / FR-32（magic role 分配）。
>
> **Schema**：`02-contracts-and-protocol.md` §3.2（InstanceRole）/ §4（roleWeights）。

---

## 1. Name Pool

20 个拟人化名称，按启动顺序无重复分配：

```ts
export const NAME_POOL = [
  'Tom', 'Jerry', 'Lucy', 'Thomas', 'Jack',
  'Lisa', 'Mike', 'Anna', 'Bob', 'Mia',
  'Leo', 'Emma', 'Sam', 'Olivia', 'Noah',
  'Ava', 'Lucas', 'Sophia', 'Ethan', 'Isla',
] as const;
```

> 不足时循环复用 `<name>2` / `<name>3` 后缀（如 21 Worker → `Tom2`）。该上限对 v0.7 6~7 Worker 的典型部署完全不构成约束。

---

## 2. Role 优先级填充

### 2.1 默认模式（无 `--magic`）

填充顺序：

```
planner > executor > verifier > reviewer > accepter
```

| Worker # | role |
|---|---|
| 1 | planner |
| 2 | executor |
| 3 | verifier |
| 4 | reviewer |
| 5 | accepter |
| 6 | executor（兜底，覆盖"execute 是瓶颈"） |
| 7+ | executor |

### 2.2 `--magic` 模式 **[v0.7 NEW]**

填充顺序：

```
planner > executor > verifier > reviewer > accepter > explorer
```

| Worker # | role |
|---|---|
| 1 | planner |
| 2 | executor |
| 3 | verifier |
| 4 | reviewer |
| 5 | accepter |
| 6 | explorer |
| 7 | executor |
| 8+ | executor |

> 不变量：
> - `--magic` 模式至少需要 6 Worker（精确匹配 6 个 role），最小数与默认一致（FR-01 `N >= 6`）。
> - 第 7 个以后只补 executor（不补第 2 个 explorer）—— Explorer 只需 1 个，链尾决策不需要并发。

### 2.3 填充算法

```text
assignRoles(workerCount, magicMode):
  pool = magicMode ? MAGIC_ORDER : DEFAULT_ORDER
  result = []
  for i in [0..workerCount):
    role = pool[i] ?? 'executor'   // 超出 pool 长度的补 executor
    result.push({ index: i, role })
  return result
```

---

## 3. WorktreeInitializer

### 3.1 算法（幂等）

```text
WorktreeInitializer.initialize(workerCount, magicMode, projectRoot):
  config = readJSON(<projectRoot>/.claude-orchestrator/config.json) ?? {}
  config.worktree ??= {}

  rolesPlan = assignRoles(workerCount, magicMode)
  results = []

  for spec in rolesPlan:
    // 1. 选 name（已分配的复用；新的从 pool 取）
    existingEntry = findEntryByIndex(config.worktree, spec.index)
    if existingEntry:
      name = existingEntry.name
      instance_id = existingEntry.instance_id    // 复用历史 ID（Leader 崩溃重启不重新生成）
    else:
      name = allocateName(config.worktree, spec.index)
      instance_id = name                          // v0.7 直接用 name 作为 instance_id（简化）

    branch = `claude-orchestrator/${name}-workspace`
    worktreePath = `${projectRoot}/.claude-orchestrator/worktree/${name}`

    // 2. 创建 worktree（幂等）
    if !exists(worktreePath):
      run: git -C <projectRoot> worktree add -b <branch> <worktreePath>
    else:
      // 已存在 → 跳过（FR-07 完成判定 a）

    // 3. seed 模板与 skills（首次创建时）
    seedWorktreeArtifacts(worktreePath, spec.role)

    // 4. 写 config.json
    config.worktree[name] = {
      name,
      role: spec.role,
      path: worktreePath,
      branch,
      instance_id,
    }
    results.push(config.worktree[name])

  writeJSON(<projectRoot>/.claude-orchestrator/config.json, config)
  return results
```

### 3.2 config.worktree 字段

与 PRD 02 §3.3 一致：

```json
{
  "worktree": {
    "Tom":    { "name": "Tom",    "role": "planner",  "path": "/abs/.claude-orchestrator/worktree/Tom",    "branch": "claude-orchestrator/Tom-workspace",    "instance_id": "Tom" },
    "Jerry":  { "name": "Jerry",  "role": "executor", "path": "...", "branch": "...", "instance_id": "Jerry" },
    "Lucy":   { "name": "Lucy",   "role": "verifier", "path": "...", "branch": "...", "instance_id": "Lucy" },
    "Thomas": { "name": "Thomas", "role": "reviewer", "path": "...", "branch": "...", "instance_id": "Thomas" },
    "Jack":   { "name": "Jack",   "role": "accepter", "path": "...", "branch": "...", "instance_id": "Jack" },
    "Lisa":   { "name": "Lisa",   "role": "explorer", "path": "...", "branch": "...", "instance_id": "Lisa" }
  }
}
```

### 3.3 第二次启动幂等

| 触发 | 行为 |
|---|---|
| 同 workerCount + 同 magicMode | 完全复用既有配置；无新 git worktree 创建；instance_id 不变 |
| workerCount 增加 | 新增 Worker 按 §2.3 继续填充（追加） |
| workerCount 减少 | v0.7 不主动删除已有 worktree（候选 v0.8）；多余 worktree 闲置但不影响主链路 |
| magicMode 切换 | 已有 Worker 的 role 不重写（避免 destabilize）；新增 Worker 按当前模式分配 |

> 这是 PRD 02 §5.2 "WorktreeInitializer 检测 worktree 已存在 → 跳过 git worktree add；检测 config.json 中已有 instance_id → 复用"的精确实现。

### 3.4 seed 内容

`seedWorktreeArtifacts(worktreePath, role)` 在首次创建时复制：

| 源 | 目标 | 说明 |
|---|---|---|
| `templates/agents/worker-${role}.md` | （仅 Leader 读取，不复制到 worktree） | 身份卡第 3 段 |
| `templates/agents/worker-${role}-task.md` | （同上） | task wrapper |
| `templates/claude-memory/personal-claude-${role}.md` | `<worktree>/.claude/CLAUDE.md` | 角色 memory |
| `skills/task-${roleSkillName}/*` | `<worktree>/.claude/skills/...` | 责任链 skill（task-planning / task-execution / task-verification / task-review / task-acceptance / task-exploration） |

其中 roleSkillName 映射表：

| role | skill 目录 |
|---|---|
| planner | task-planning |
| executor | task-execution |
| verifier | task-verification |
| reviewer | task-review |
| accepter | task-acceptance |
| **explorer** **[v0.7 NEW]** | task-exploration |

---

## 4. 身份卡三段拼接

### 4.1 buildIdentityPrompt

```ts
function buildIdentityPrompt(spec: {
  name: string;
  role: WorkerRole;
  worktreePath: string;
  worktreeBranch: string;
  instanceId: InstanceId;
}): string {
  const part1 = renderTemplate('worker-identity.md', spec);
  const part2 = renderTemplate(`templates/claude-memory/personal-claude-${spec.role}.md`, spec);
  const part3 = readFile(`templates/agents/worker-${spec.role}.md`);
  return [part1, part2, part3].join('\n\n---\n\n');
}
```

### 4.2 worker-identity.md（第 1 段，PRD 02 §6.1）

```markdown
## Worker Identity
You are **{{name}}**, a **{{role}}** in the multi-agent orchestration system.
- Name: {{name}}
- Role: {{role}}
- Worktree: {{worktreePath}}
- Branch: {{worktreeBranch}}
- Instance: {{instanceId}}
```

5 个占位符在 `renderTemplate` 内做 `{{key}}` → `value` 严格替换。

### 4.3 第 2 段：角色 memory

`templates/claude-memory/personal-claude-${role}.md` —— 包括 explorer **[v0.7 NEW]**。

每个角色一份 markdown，内容典型结构：

```markdown
# CLAUDE.md — Personal memory for {{role}}

## Your role
<role 长期不变的工作规范>

## Trace → Execute → Map → Evidence → Record
<task-traceability 流程的角色化版本>

## Output format
<期望的 result.md 结构>
```

> seed 时 `{{role}}` / `{{name}}` 占位符替换；运行时 Worker 在每次任务流程头部 Read 这份 memory。

### 4.4 第 3 段：role 常驻规则

`templates/agents/worker-${role}.md` 原样拼接（不做占位符替换，因其内容不依赖具体 name）。定义角色的工作流约束，如：

- `worker-verifier.md`：必须先列证据再下结论
- `worker-explorer.md`（**[v0.7 NEW]**）：必须在自评估时同时输出 `next_requirement` 字段（如果选 `spawn_chain`）

### 4.5 cache-friendly 调用

每次 `claude -p` 调用：

```bash
claude --append-system-prompt "<part1>\n\n---\n\n<part2>\n\n---\n\n<part3>" \
       --dangerously-skip-permissions \
       --permission-mode dontAsk \
       -p "<task prompt>"
```

- 身份卡内容长期不变 → system prompt cache 命中率高
- 任务内容通过 `-p` 注入 user prompt
- 长期成本主要来自 user prompt 与输出 token

---

## 5. roleWeights 认领排序（实现一致性）

详细 schema 见 `02-contracts-and-protocol.md` §4。本节强调跨文件一致性：

| 维度 | 出现位置 | 必须一致 |
|---|---|---|
| 矩阵数值 | `@co/contracts/roleWeights.ts` | 唯一定义 |
| Worker 侧 claim 排序 | `TaskQueue.claim()`（详见 `06-tasks-and-workers.md` §2.1） | import 上一项 |
| TEAM 面板"跨角色协助"判定 | `04-tui-and-input.md` §3 `Executor ◀←` 标记 | 用 `roleWeights[role][link] != 100` 判定 |

### 5.1 复合排序键

```
1. assigned_to == self.instance_id   → 1 / 0
2. roleWeights[self.role][task.link] → 100 / 20 / 10 / 0
3. priority                          → HIGH(0) < NORMAL(1) < LOW(2) → asc
4. task_id (FIFO)                    → 字典序 asc
```

> 详见 `06-tasks-and-workers.md` §2。

### 5.2 跨角色协助触发条件

- TaskQueue 中存在 link=X 的 pending task
- 所有 role 偏好 X 的 Worker 均处于 claimed 状态
- 某个空闲 Worker 的 roleWeights[role][X] > 0（一定满足，因为矩阵无 0 值，除 leader 列）

→ 该 Worker claim 成功；`task_claimed` 事件中 `roleWeights[claimer.role][link] != 100` → emit `worker_role_borrowed` → TUI 渲染箭头标记（详见 `04-tui-and-input.md` §3）。

---

## 6. Explorer 角色完整说明 **[v0.7 NEW]**

### 6.1 模板清单

| 文件 | 角色 | 字段要求 |
|---|---|---|
| `templates/agents/worker-explorer.md` | 身份卡第 3 段：常驻规则 | 必含"在任何 explore 任务里：1) 通读链全貌 2) 二选一输出 spawn_chain / close_chain 3) 若 spawn_chain 必带 next_requirement 字段" |
| `templates/agents/worker-explorer-task.md` | 每次任务的 user prompt wrapper | 占位符 = `06-tasks-and-workers.md` §11.1 |
| `templates/claude-memory/personal-claude-explorer.md` | 角色 memory | seed 到 Worker worktree 的 `.claude/CLAUDE.md` |
| `skills/task-exploration/SKILL.md` | 责任链 skill | 与其它 5 个 task-* 共享 Trace→Execute→Map→Evidence→Record 流程 |

### 6.2 roleWeights 数值

| 行：explorer | plan | execute | verify | review | accept | explore |
|---|---|---|---|---|---|---|
| 权重 | 20 | 10 | 10 | 20 | 10 | **100** |

> 任意 Worker 在 `--magic` 模式下都可以兜底 explore 任务（最低权重 10），但 explorer 是 100 → 几乎总能优先认领。

### 6.3 与其它 role 的不同点

| 维度 | 其它 role | Explorer |
|---|---|---|
| 是否有 commit | 通常有（execute）或可能（verify/review/accept） | 通常无（只产 result.md 含 next_requirement 文本） |
| SelfEvaluator 输出 | activate_next / feedback / reject / close_chain | spawn_chain / close_chain（主路径）+ feedback / reject |
| 是否被 magic_mode 约束 | 否 | 仅 magic_mode=true 时存在 |
| 任务 prompt 上下文 | 仅本 link 上游 result.md | 整链全貌 + 父链摘要（详见 `06-tasks-and-workers.md` §11） |

---

## 7. 与其它 DD 文件交叉

| 主题 | 主文件 |
|---|---|
| InstanceRole / roleWeights schema | `02-contracts-and-protocol.md` §3.2 / §4 |
| TaskQueue.claim 排序细节 | `06-tasks-and-workers.md` §2 |
| 跨角色协助 TUI 渲染 | `04-tui-and-input.md` §3 |
| Worker 启动 fork + protocol 校验 | `06-tasks-and-workers.md` §1 |
| Explorer 任务流上下文汇编 | `06-tasks-and-workers.md` §11 |
| spawn_chain 端到端时序 | `10-magic-loop.md` §4 |
| seed worktree 与 worker_template_seeder | `01-architecture.md` §6 阶段 (2) |
