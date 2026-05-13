# Worker Worktree 隔离与身份体系

本文档描述 Worker 的物理隔离机制（git worktree）、命名体系（拟人化名称池）、身份注入方式（`--append-system-prompt`）、三层 Directory Memory 设计。

## 1. Git Worktree 隔离

### 1.1 设计目标

每个 Worker 拥有独立的 git 工作目录与分支，避免多个 Worker 同时操作主仓库时的文件竞争。

- 文件系统隔离：每个 Worker `chdir` 到自己的 worktree，`process.cwd()` 互不干扰
- Git 状态隔离：每个 Worker 在独立分支上 commit，Leader 通过 `MergeValidator` 决策何时合并
- 进程隔离：子进程独立内存空间，崩溃不影响其他 Worker 或 Leader

### 1.2 目录结构

```
<项目根目录>/
└── .claude-orchestrator/
    └── worktree/
        ├── Tom/                       # git worktree (branch: claude-orchestrator/Tom-workspace)
        │   ├── .claude-orchestrator/
        │   │   ├── config.json        # { "name": "Tom", "role": "planner", "instance_id": "..." }
        │   │   ├── agents/            # 12 个 Worker 模板（从 templates/agents/ 复制）
        │   │   └── docs/Tom/          # 个人级 + 每日级 directory memory
        │   ├── .claude/skills/        # 8 个 Skill 副本
        │   ├── CLAUDE.md              # 团队级 directory memory
        │   └── ...                    # 项目源码
        ├── Jerry/                     # git worktree (branch: claude-orchestrator/Jerry-workspace)
        │   └── ...                    # { "name": "Jerry", "role": "builder", ... }
        ├── Lucy/                      # git worktree (branch: claude-orchestrator/Lucy-workspace)
        ├── Thomas/                    # git worktree (branch: claude-orchestrator/Thomas-workspace)
        └── Jack/                      # git worktree (branch: claude-orchestrator/Jack-workspace)
```

### 1.3 分支命名规则

```typescript
function getWorktreeBranch(name: string): string {
  return `claude-orchestrator/${name}-workspace`;
}
```

| Worker 名 | 分支名 |
|----------|--------|
| Tom | `claude-orchestrator/Tom-workspace` |
| Jerry | `claude-orchestrator/Jerry-workspace` |
| Oscar | `claude-orchestrator/Oscar-workspace` |

斜杠 `claude-orchestrator/` 前缀使分支在 `git branch -a` 中分组显示，便于识别。

### 1.4 创建流程

[src/worker/worktree-initializer.ts](../../src/worker/worktree-initializer.ts) `initializeWorktrees(projectRoot, n)`：

```typescript
export async function initializeWorktrees(
  projectRoot: string,
  workerCount: number,
): Promise<WorktreeConfig[]> {
  const assignments = await generateWorkerAssignment(workerCount, projectRoot);
  const configs: WorktreeConfig[] = [];
  const existingConfig = loadProjectWorktreeConfig(projectRoot);
  const worktreeRoot = path.join(projectRoot, ".claude-orchestrator", "worktree");

  for (const { name, role } of assignments) {
    // 1. 幂等检查（已有 worktree 直接复用）
    const existing = existingConfig[name];
    if (existing && fs.existsSync(path.join(worktreeRoot, name))) {
      configs.push({
        name, role,
        worktreePath: path.join(worktreeRoot, name),
        relativePath: `.claude-orchestrator/worktree/${name}`,
        branch: getWorktreeBranch(name),
        instanceId: existing.instance_id || crypto.randomUUID().replace(/-/g, ""),
      });
      continue;
    }

    // 2. 创建 worktree
    const relativePath = `.claude-orchestrator/worktree/${name}`;
    const branch = getWorktreeBranch(name);
    const worktreePath = path.join(projectRoot, relativePath);

    await fs.promises.mkdir(worktreeRoot, { recursive: true });
    await execGit(projectRoot, `worktree add ${relativePath} -b ${branch}`);

    // 3. 生成 instanceId
    const instanceId = crypto.randomUUID().replace(/-/g, "");

    // 4. worktree 内部 config.json
    const wtConfigDir = path.join(worktreePath, ".claude-orchestrator");
    await fs.promises.mkdir(wtConfigDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(wtConfigDir, "config.json"),
      JSON.stringify({ name, role, instance_id: instanceId }, null, 2),
    );

    // 5. 复制 agents 模板 + skills + personal CLAUDE.md
    await ensureWorktreeEnvironment(worktreePath, name, role);

    // 6. 安装依赖
    if (fs.existsSync(path.join(worktreePath, "package.json"))) {
      await execCmd("npm install", worktreePath);
    }

    configs.push({ name, role, worktreePath, relativePath, branch, instanceId });
  }

  // 7. 持久化到根目录 config.json
  await saveProjectWorktreeConfig(projectRoot, configs);
  return configs;
}
```

### 1.5 三级幂等检查

`scanExistingNames(projectRoot)` 扫描已有名称，避免冲突：

```typescript
async function scanExistingNames(projectRoot: string): Promise<Set<string>> {
  const used = new Set<string>();
  const wtDir = path.join(projectRoot, ".claude-orchestrator", "worktree");

  // 第 1 级：已有 worktree 目录
  if (fs.existsSync(wtDir)) {
    for (const entry of await fs.promises.readdir(wtDir)) {
      used.add(entry);
    }
  }

  // 第 2 级：已有 worktree 分支
  const branches = await execGit("branch -a", projectRoot);
  const wtBranchPattern = /claude-orchestrator\/(.+)-workspace/;
  for (const line of branches.split("\n")) {
    const m = line.trim().match(wtBranchPattern);
    if (m) used.add(m[1]);
  }

  // 第 3 级：config.json 已有名称
  const existingConfig = loadProjectWorktreeConfig(projectRoot);
  for (const name of Object.keys(existingConfig)) {
    used.add(name);
  }

  return used;
}
```

### 1.6 错误处理

| 场景 | 处理 |
|------|------|
| worktree 路径已存在 | 跳过创建，复用配置（正常情况） |
| branch 已存在 | 跳过 `-b`，使用 `git worktree add --force` 或直接 checkout |
| Worker 名称已被占用 | 三级唯一性检查兜底；最差情况调用 claude-cli 生成新名称 |
| `git worktree add` 失败（其他原因） | 跳过该 Worker，记录错误，继续其他 Worker |

## 2. 拟人化命名系统

### 2.1 设计原则

- 名称必须是**一个单词**，便于在 TUI 与日志中识别
- 使用拟人化名称（Tom / Jerry / Lucy / ...），让多 Agent 协作可读
- 名称与角色独立分配 —— 名称是身份标识，角色是权重偏好
- 名称用作 worktree 目录名 + 分支名的组成部分

### 2.2 内置名称池

[src/worker/worktree-initializer.ts](../../src/worker/worktree-initializer.ts) 内置 20 个名称：

```typescript
const BUILTIN_NAMES = [
  "Tom",    "Jerry", "Lucy",   "Thomas",  "Jack",   "Lisa",
  "Alice",  "Bob",   "Charlie","Diana",   "Edward", "Fiona",
  "George", "Helen", "Ivan",   "Julia",   "Kevin",  "Linda",
  "Mike",   "Nancy",
];
```

当 `workerCount <= 20` 且无名称冲突时，直接从池中按顺序取用。

### 2.3 角色分配优先级

```typescript
const ROLE_PRIORITY = ["planner", "builder", "verifier", "reviewer", "accepter"];

function assignRoles(count: number): string[] {
  if (count <= 5) {
    return ROLE_PRIORITY.slice(0, count);
  }
  // 超过 5 个，先保证每种角色至少 1 个，剩余优先扩充 builder
  const roles = [...ROLE_PRIORITY];
  let remaining = count - 5;
  while (remaining > 0) {
    roles.push("builder");
    remaining--;
  }
  return roles;
}
```

| Worker 数 | 角色分配 | 内置名称 |
|-----------|---------|---------|
| 1 | builder | Tom |
| 2 | planner, builder | Tom, Jerry |
| 3 | planner, builder, verifier | Tom, Jerry, Lucy |
| 4 | planner, builder, verifier, reviewer | Tom, Jerry, Lucy, Thomas |
| 5 | planner, builder, verifier, reviewer, accepter | Tom, Jerry, Lucy, Thomas, Jack |
| 6 | + builder | + Lisa |
| 7 | + builder | + Alice |
| 8 | + builder | + Bob |
| 20 | 5 角色 + 15 builder | 内置名称池用尽 |
| 21+ | 同上 | 前 20 内置，第 21 起由 claude-cli 生成 |

### 2.4 名称生成算法

```typescript
async function generateWorkerAssignment(
  count: number,
  projectRoot: string,
): Promise<Array<{ name: string; role: string }>> {
  // 1. 分配角色
  const roles = assignRoles(count);

  // 2. 扫描已用名称
  const usedNames = await scanExistingNames(projectRoot);
  const available = BUILTIN_NAMES.filter(n => !usedNames.has(n));

  // 3. 优先用内置名称池
  if (available.length >= count) {
    return roles.map((role, i) => ({ name: available[i], role }));
  }

  // 4. 不够 → 先用完内置，剩余由 claude-cli 生成
  const result: Array<{ name: string; role: string }> = [];
  for (let i = 0; i < available.length; i++) {
    result.push({ name: available[i], role: roles[i] });
  }

  const remaining = count - available.length;
  if (remaining > 0) {
    const newNames = await generateNamesViaClaude(
      remaining,
      [...usedNames, ...available],
      roles.slice(available.length),
    );
    result.push(...newNames);
  }

  return result;
}
```

### 2.5 claude-cli 生成补充名称

```typescript
async function generateNamesViaClaude(
  count: number,
  usedNames: string[],
  roles: string[],
): Promise<Array<{ name: string; role: string }>> {
  const prompt = `Generate ${count} unique human first names (single word, e.g., "Oscar", "Peggy") for Worker agents.

Requirements:
- Common English first names, single word only, no numbers or special characters
- Each name must be unique and not in this list: ${usedNames.join(", ")}
- Generate exactly ${count} names

The names will be assigned to these roles: ${roles.join(", ")}

Output JSON: {"names": ["name1", "name2", ...]}`;

  const output = await runClaudePrompt(prompt);
  const parsed = JSON.parse(output);
  let names: string[] = parsed.names;

  // 返回不足时用字母序补齐
  if (names.length < count) {
    const fallback = generateFallbackNames(count - names.length, [...usedNames, ...names]);
    names.push(...fallback);
  }

  return names.map((name, i) => ({ name, role: roles[i] }));
}
```

`generateFallbackNames` 按字母 A-Z 加后缀（如 `Aay`、`Bee`、`Cie`）补齐。

### 2.6 名称稳定性

名称与角色的绑定关系持久化在根目录 `config.json` 的 `worktree` 段落：

```json
{
  "worktree": {
    "Tom":    { "name": "Tom",    "role": "planner",  "path": "...", "branch": "...", "instance_id": "..." },
    "Jerry":  { "name": "Jerry",  "role": "builder",  "path": "...", "branch": "...", "instance_id": "..." }
  }
}
```

重复执行 `run` 时，若已有配置中存在该名称，则直接复用其角色与 instance_id 绑定，不会重新分配。这保证：

- `run --worker 5` 首次执行：Tom(planner), Jerry(builder), Lucy(verifier), Thomas(reviewer), Jack(accepter)
- `run --worker 5` 重复执行：复用上述绑定
- `run --worker 3` 缩减执行：只启动前 3 个，其余 worktree 保留磁盘上但不启动
- `run --worker 7` 扩张执行：复用前 5 个，新建 Lisa(builder), Alice(builder)

## 3. 身份注入：`--append-system-prompt`

### 3.1 设计动机

身份信息（name、role、worktree、instance_id）属于 system prompt 层概念，**不**属于任务变量。将身份混在 user prompt 中存在两个问题：

- 每条任务消息都重复一遍身份信息，增加 user prompt 长度
- system prompt / user prompt 不分离，无法享受 prompt caching

v0.5 中身份通过 `claude --append-system-prompt` 注入到 system prompt 层，与 user prompt（`-p` 内容）分离。

### 3.2 buildIdentityPrompt

[src/executor/runner.ts](../../src/executor/runner.ts) `buildIdentityPrompt()` 生成身份卡片：

```typescript
class ClaudeRunner {
  constructor(
    private command: string,
    private cacheDir: string,
    private leaderInstanceId: string,
    private workDir: string,
    private identity?: {
      name: string;
      role: string;
      worktreePath?: string;
      worktreeBranch?: string;
      instanceId: string;
    },
  ) {}

  buildIdentityPrompt(): string {
    if (!this.identity) return "";
    return `## Worker Identity

You are **${this.identity.name}**, a **${this.identity.role}** in the multi-agent orchestration system.

- Name: ${this.identity.name}
- Role: ${this.identity.role}
- Worktree: ${this.identity.worktreePath ?? ""}
- Branch: ${this.identity.worktreeBranch ?? ""}
- Instance: ${this.identity.instanceId}`;
  }
}
```

### 3.3 system prompt / user prompt 分离

```
WorkerWatcher.processMessage(msg):
  template = templateEngine.get(`worker-${link}.md`)
  prompt = templateEngine.render(template, taskVars)   ← 仅含任务变量
  systemPrompt = runner.buildIdentityPrompt()           ← 含身份信息

  runner.run(prompt, logPath, { systemPrompt })
    └─ execWithStreaming(command, prompt, logPath, systemPrompt, ...)
       └─ shell: `${command} --append-system-prompt '${escapeShell(systemPrompt)}' -p '${escapeShell(prompt)}'`
```

最终 claude-cli 看到的命令结构：

```bash
claude --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  --append-system-prompt '## Worker Identity

You are **Tom**, a **planner** in the multi-agent orchestration system.

- Name: Tom
- Role: planner
- Worktree: /Users/me/project/.claude-orchestrator/worktree/Tom
- Branch: claude-orchestrator/Tom-workspace
- Instance: a1b2c3d4...' \
  -p '## Task

Title: Plan auth module
Description: ...
Criteria: ...'
```

身份在 system prompt 一次注入，整个 session 内有效。后续 `--resume` 调用自动继承同一 system prompt。

### 3.4 TemplateEngine 职责简化

`TemplateEngine.render()` 仅做 `{{var}}` 替换，**不再**拼接身份卡片：

```typescript
class TemplateEngine {
  render(template: string, vars: Record<string, string>): string {
    let body = template;
    for (const [key, value] of Object.entries(vars)) {
      body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
    return body;
  }
}
```

总代码量约 46 行。详见 [`execution-runtime.md`](execution-runtime.md) §4。

## 4. Shell 转义

`execWithStreaming` 对 `--append-system-prompt` 和 `-p` 的值都做单引号转义：

```typescript
function escapeShell(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const cmd = systemPrompt
  ? `${baseCommand} --append-system-prompt ${escapeShell(systemPrompt)} -p ${escapeShell(prompt)}`
  : `${baseCommand} -p ${escapeShell(prompt)}`;
```

身份信息中可能出现的特殊字符（如 worktree 路径中的空格）都被安全处理。

## 5. 三层 Directory Memory

### 5.1 概念

每个 worktree 内部维护三层 `CLAUDE.md`，承载不同时间尺度的上下文：

```
<worktree>/
├── CLAUDE.md                          ← 第 1 层：团队级
│     团队角色表、产出目录规范、Skill 索引、Git 规则
│
├── .claude-orchestrator/
│   └── docs/{Name}/
│       ├── CLAUDE.md                  ← 第 2 层：个人级（角色规范）
│       └── YYYY-MM-DD/
│           └── CLAUDE.md              ← 第 3 层：每日级（会话记忆）
```

### 5.2 三层来源与维护方

| 层 | 路径 | 来源 | 维护方 |
|---|------|------|--------|
| 团队级 | `<worktree>/CLAUDE.md` | `templates/claude-memory/team-claude.md` | InitChecker step 3 复制（一次性，更新时显示 diff 确认） |
| 个人级 | `<worktree>/.claude-orchestrator/docs/{Name}/CLAUDE.md` | `templates/claude-memory/personal-claude-{role}.md` | WorktreeInitializer 复制（按 role 选模板） |
| 每日级 | `<worktree>/.claude-orchestrator/docs/{Name}/{YYYY-MM-DD}/CLAUDE.md` | — | Worker 在任务执行时自行创建和维护 |

### 5.3 团队级 (`team-claude.md`)

内容覆盖：

- 团队角色表（Planner / Builder / Verifier / Reviewer / Accepter）的职责
- 责任链 P→B→V→R→A 的流转规则
- 产出目录规范：`.claude-orchestrator/docs/` 是唯一文档产出目录
- Skill 索引：每个责任链环节对应的 Skill 路径
- Git 规则：commit 命名约定、分支命名

每个 Worker 在执行任务前应读取此文件了解团队约定。

### 5.4 个人级 (`personal-claude-{role}.md`)

按 5 个角色提供 5 个模板：

- `personal-claude-planner.md` — Planner 的工作规范
- `personal-claude-builder.md` — Builder 的工作规范
- `personal-claude-verifier.md` — Verifier 的工作规范
- `personal-claude-reviewer.md` — Reviewer 的工作规范
- `personal-claude-accepter.md` — Accepter 的工作规范

每个模板包含：

- 该角色在责任链中的位置和核心职责
- task-traceability 五步法在该角色的具体应用
- 该角色的产出格式（result_path 写什么）
- 与上下游环节的接口约定

### 5.5 每日级 (`{YYYY-MM-DD}/CLAUDE.md`)

Worker 在任务执行时自维护，承载当日会话记忆：

- 当日处理过的任务摘要
- 关键决策与依据
- 待办项与开放问题
- 跨任务的共享上下文

每个 worker-{link}.md 模板的 "Step 0: Directory Memory" 都包含读取三层 memory 的指引：

```markdown
## Step 0: Directory Memory

Before starting, read these files for context:
- `./CLAUDE.md` — team-level conventions
- `./.claude-orchestrator/docs/{{name}}/CLAUDE.md` — your role specification
- `./.claude-orchestrator/docs/{{name}}/{{today}}/CLAUDE.md` — today's session memory (if exists)

If today's session memory doesn't exist, create it and use it to track decisions you make.
```

模板变量 `{{name}}` 来自 `WorkerWatcher` 渲染上下文，`{{today}}` 由系统生成（ISO 日期前缀）。

### 5.6 产出物目录约束

所有 Worker 文档产出**必须**写入 `.claude-orchestrator/docs/{Name}/` 下，避免污染主仓库代码目录。

`.gitignore` 通过 negation 规则保护 Worker 产出可被 git 跟踪：

```gitignore
.claude-orchestrator/*
!.claude-orchestrator/docs/
```

| 路径 | 是否忽略 | 原因 |
|------|---------|------|
| `.claude-orchestrator/config.json` | 忽略 | 含 instance_id 等运行时信息 |
| `.claude-orchestrator/docs/` | **不忽略** | Worker 工作产物，需要 commit |
| `.claude-orchestrator/sessions/` | 忽略 | Leader 运行时日志 |
| `.claude-orchestrator/worktree/` | 忽略 | git worktree 自成仓库，不应在主仓库跟踪 |

## 6. WorktreeInitializer 内部协议

### 6.1 输入

```typescript
initializeWorktrees(
  projectRoot: string,     // 项目根目录绝对路径
  workerCount: number,     // 来自 run --worker N
): Promise<WorktreeConfig[]>;
```

### 6.2 输出

```typescript
interface WorktreeConfig {
  name: string;            // "Tom"
  role: string;            // "planner"
  worktreePath: string;    // 绝对路径
  relativePath: string;    // ".claude-orchestrator/worktree/Tom"
  branch: string;          // "claude-orchestrator/Tom-workspace"
  instanceId: string;      // 预生成 UUID（hex，无连字符）
}
```

### 6.3 副作用

- 创建 `<project>/.claude-orchestrator/worktree/{name}/` 目录与 git worktree
- 创建 git 分支 `claude-orchestrator/{name}-workspace`
- 写入 `<worktree>/.claude-orchestrator/config.json`
- 复制 `templates/agents/` → `<worktree>/.claude-orchestrator/agents/`
- 复制 `skills/` → `<worktree>/.claude/skills/`
- 复制 `templates/claude-memory/team-claude.md` → `<worktree>/CLAUDE.md`
- 复制 `templates/claude-memory/personal-claude-{role}.md` → `<worktree>/.claude-orchestrator/docs/{Name}/CLAUDE.md`
- 在 worktree 有 `package.json` 时执行 `npm install`
- 持久化所有 `WorktreeConfig` 到 `<project>/.claude-orchestrator/config.json` 的 `worktree` 段

### 6.4 与 InitChecker 的边界

InitChecker step 5（worktrees）和 step 6（npm_install）调用 WorktreeInitializer。InitChecker 负责交互/记忆，WorktreeInitializer 负责具体动作：

| 关注点 | InitChecker | WorktreeInitializer |
|--------|------------|---------------------|
| 交互确认 / `-y` 模式 | ✓ | — |
| 历史决策记忆 (`init_status`) | ✓ | — |
| 名称分配算法 | — | ✓ |
| `git worktree add` 执行 | — | ✓ |
| 配置文件写入 | — | ✓ |
| 错误处理与日志 | 调用上层 | 实际执行 |

## 7. 与其他文档的边界

| 关注点 | 所属文档 |
|--------|---------|
| git worktree、命名、身份注入、三层 memory | `worktree-and-identity.md`（本文档） |
| Worker 子进程模型、模板渲染、自评估 | [`worker-design.md`](worker-design.md) |
| 五阶段编排、InitChecker、子进程管理 | [`orchestration.md`](orchestration.md) |
| `ClaudeRunner` / `--append-system-prompt` / `execWithStreaming` | [`execution-runtime.md`](execution-runtime.md) |
| 责任链、角色即权重、名称-角色解耦 | [`role-design.md`](role-design.md) |
| Instance schema（含 worktree 字段） | [`zookeeper-schema.md`](zookeeper-schema.md) §2.2 |
