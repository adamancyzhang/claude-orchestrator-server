# v0.4 详细设计文档：多 Worker 工作区隔离架构

## 概述

v0.4 将 v0.3 分散的三个命令（`setup`、`leader`、`register`）合并为单一 `run` 命令，一步完成环境配置、TUI 启动和多 Worker 自动注册。引入 git worktree 机制实现每个 Worker 的文件系统隔离。每个 Worker 拥有独立的工作区，任务完成后自动提交变更，Leader 交叉验证并合并 Worker 分支到主工作区。

核心目标：

1. **一键启动**：`run --worker 5` 完成所有工作，无需分别执行 setup / leader / register
2. **隔离性**：每个 Worker 拥有独立的 git worktree，互不干扰
3. **自动化**：Worker 任务产生的代码变更自动提交，Leader 自动合并验证
4. **可观测性**：TUI 实时展示每个 Worker 的工作区路径和分支状态

---

## 1. run 命令统一入口

### 1.1 命令设计

v0.4 移除 `setup`、`leader`、`register` 三个命令，替换为单一 `run` 命令：

```bash
claude-orchestrator run --worker <数量>
```

支持的选项：

| 参数 | 必需 | 说明 |
|------|------|------|
| `--worker <n>` | 是 | Worker 数量 |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址，默认 `127.0.0.1:2181` |
| `-d, --debug` | 否 | 调试模式 |

### 1.2 启动流程

`run` 命令按以下阶段依次执行：

```
claude-orchestrator run --worker 5
  │
  ├─ 阶段 1: 环境自检
  │     ├─ 检查 .claude-orchestrator/config.json 是否存在
  │     ├─ 检查 .claude-orchestrator/agents/ 下模板是否齐全
  │     ├─ 检查 .claude/skills/ 下技能是否齐全
  │     └─ 任一缺失 → 进入交互式配置（原 setup 逻辑）
  │
  ├─ 阶段 2: 角色分配 & Worktree 初始化
  │     ├─ 分配 N 个单单词名称 + 角色
  │     ├─ 创建 git worktree（如不存在）
  │     └─ 写入配置
  │
  ├─ 阶段 3: 启动 TUI（Leader）
  │     ├─ 连接 ZK，创建 /leader EPHEMERAL 节点
  │     ├─ 注册 Leader Instance
  │     ├─ 启动 WorkerMonitor、TaskOrchestrator、TaskRecovery
  │     └─ 渲染 TUI
  │
  ├─ 阶段 4: 启动 Worker 子进程
  │     └─ fork N 个子进程，每个在对应 worktree 中执行
  │
  └─ 阶段 5: 等待退出
        └─ SIGINT → kill 子进程 → 注销 → 断开 ZK
```

### 1.3 阶段 1：交互式配置（继承原 setup）

当检测到以下任一条件时，进入交互式配置：

- `.claude-orchestrator/config.json` 不存在
- `.claude-orchestrator/agents/` 下模板文件缺失
- `.claude/skills/` 下技能文件缺失

配置流程（非交互式，自动执行）：

```typescript
async function ensureEnvironment(): Promise<void> {
  // 1. 确保全局配置 ~/.claude-orchestrator/config.json
  const globalConfig = loadGlobalConfig();
  if (!globalConfig.commands?.["claude-cli"] || !globalConfig.cache_dir) {
    saveInstanceConfig({
      commands: { "claude-cli": "claude --dangerously-skip-permissions --permission-mode dontAsk" },
      cache_dir: "~/.claude-orchestrator/sessions",
      hooks: { leader_message_start: null, leader_message_end: null, worker_message_start: null, worker_message_end: null },
      zookeeper: { url: "127.0.0.1:2181", root_path: "/claude-orchestrator", auth: null },
    }, true);
  }

  // 2. 复制模板到 .claude-orchestrator/agents/
  const agentsDir = path.join(process.cwd(), ".claude-orchestrator", "agents");
  const templateDir = path.join(__dirname, "..", "templates");
  for (const [filename, srcPath] of Object.entries(TEMPLATES)) {
    const destPath = path.join(agentsDir, filename);
    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }

  // 3. 复制技能到 .claude/skills/
  const skillsSrcDir = path.join(__dirname, "..", "skills");
  const skillsDstDir = path.join(process.cwd(), ".claude", "skills");
  // ... 同原 cmdSetup 中的拷贝逻辑
}
```

### 1.4 命令入口

`src/index.ts` 中移除 `setup`、`leader`、`register` 三个子命令，替换为：

```typescript
program
  .command("run")
  .description("一键启动编排环境：自动配置 + 启动 TUI + 注册 Worker")
  .requiredOption("--worker <n>", "Worker 数量", parseInt)
  .action(async function (this: Command) {
    const { worker } = getSubOpts<{ worker: number }>(this);
    const debug = getDebug(this);
    if (debug) Logger.enableDebug();
    const config = loadConfig({ zookeeper: getZkHosts(this) });
    const { runOrchestrator } = await import("./orchestrator/run.js");
    await runOrchestrator({ zkHosts: config.zk.url, workerCount: worker, name: undefined, debug });
  });
```

### 1.5 依赖关系变化

```typescript
// v0.3: leader/index.ts 负责 Leader 启动
//       cli/commands.ts cmdRegister 负责 Worker 注册
//       两者独立，需要分别执行

// v0.4: orchestrator/run.ts 统一编排
//       内联调用 leader 子系统 + worker 子系统
```

`src/orchestrator/run.ts` 是新的顶层入口：

```typescript
export async function runOrchestrator(config: {
  zkHosts: string;
  workerCount: number;
  name?: string;
  debug?: boolean;
}): Promise<void> {
  // 阶段 1: 环境自检 & 配置
  await ensureEnvironment();

  // 阶段 2: 角色分配 & Worktree 初始化
  const worktreeConfigs = await initializeWorktrees(
    process.cwd(), config.workerCount
  );

  // 阶段 3: 启动 TUI (Leader)
  const leaderHandle = await startLeader({
    zkHosts: config.zkHosts,
    name: config.name,
    debug: config.debug,
    worktreeConfigs, // 传入，用于 TUI 展示
  });

  // 阶段 4: 启动 Worker 子进程
  const children = await startAllWorkers({
    zkHosts: config.zkHosts,
    configs: worktreeConfigs,
    debug: config.debug,
  });

  // 阶段 5: 等待退出
  await handleShutdown(children, leaderHandle);
}
```

---

## 2. Worker 命名与角色分配

### 2.1 命名规则

- Worker 名称必须是**一个单词**，使用拟人化名称，如 `Tom`、`Jerry`、`Lucy`、`Thomas`、`Jack`
- 名称与角色独立分配——名称是身份标识，角色是职责
- 名称本身即为唯一标识，直接用作 worktree 目录名和分支名的组成部分
- 角色分配遵循优先级：`planner > builder > verifier > reviewer > accepter`

### 2.2 内置名称池

系统内置一组拟人化名称，按顺序取用：

```typescript
const BUILTIN_NAMES = [
  "Tom", "Jerry", "Lucy", "Thomas", "Jack", "Lisa",
  "Alice", "Bob", "Charlie", "Diana", "Edward", "Fiona",
  "George", "Helen", "Ivan", "Julia", "Kevin", "Linda",
  "Mike", "Nancy",
];
```

当 `workerCount <= BUILTIN_NAMES.length`（即 ≤ 20）时，直接从池中按顺序取用。

### 2.3 名称生成算法

```typescript
const ROLE_PRIORITY = ["planner", "builder", "verifier", "reviewer", "accepter"];

async function generateWorkerAssignment(
  count: number,
  projectRoot: string
): Promise<Array<{ name: string; role: string }>> {
  // 1. 分配角色
  const roles = assignRoles(count);

  // 2. 从内置名称池取用
  const usedNames = await scanExistingNames(projectRoot);
  const available = BUILTIN_NAMES.filter(n => !usedNames.has(n));

  if (available.length >= count) {
    // 内置名称足够
    return roles.map((role, i) => ({ name: available[i], role }));
  }

  // 3. 内置名称不够 → 先用完内置名称，剩余用 claude-cli 生成
  const result: Array<{ name: string; role: string }> = [];
  for (let i = 0; i < count; i++) {
    if (i < available.length) {
      result.push({ name: available[i], role: roles[i] });
    } else {
      // 后面由 generateNamesViaClaude 批量生成
      break;
    }
  }

  const remaining = count - available.length;

  // 4. 调用 claude-cli 生成剩余的人名
  if (remaining > 0) {
    const newNames = await generateNamesViaClaude(
      remaining,
      [...usedNames, ...available],
      roles.slice(available.length)
    );
    result.push(...newNames);
  }

  return result;
}

function assignRoles(count: number): string[] {
  if (count <= 5) {
    return ROLE_PRIORITY.slice(0, count);
  }
  // 超过 5 个，先保证每种角色至少 1 个，剩余的优先扩充 builder
  const roles = [...ROLE_PRIORITY];
  let remaining = count - 5;
  while (remaining > 0) {
    roles.push("builder");
    remaining--;
  }
  return roles;
}
```

### 2.4 claude-cli 生成人名

当内置名称池不够用时，调用 claude-cli 生成额外的拟人化名称：

```typescript
async function generateNamesViaClaude(
  count: number,
  usedNames: string[],
  roles: string[]
): Promise<Array<{ name: string; role: string }>> {
  const prompt = `Generate ${count} unique human first names (single word, e.g., "Oscar", "Peggy") for Worker agents.

Requirements:
- Common English first names, single word only, no numbers or special characters
- Each name must be unique and not in this list: ${usedNames.join(", ")}
- Generate exactly ${count} names

The names will be assigned to these roles: ${roles.join(", ")}

Output JSON: {"names": ["name1", "name2", ...]}`;

  // 调用 claude-cli 获取名称列表
  const output = await runClaudePrompt(prompt);
  const parsed = JSON.parse(output);
  const names: string[] = parsed.names;

  if (names.length < count) {
    // claude-cli 返回不足，用备用方案补齐
    const fallback = generateFallbackNames(count - names.length, [...usedNames, ...names]);
    names.push(...fallback);
  }

  return names.map((name, i) => ({ name, role: roles[i] }));
}

function generateFallbackNames(count: number, used: string[]): string[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const result: string[] = [];
  for (const letter of alphabet) {
    if (result.length >= count) break;
    for (const suffix of ["", "ay", "ee", "ie"]) {
      if (result.length >= count) break;
      const candidate = `${letter}${suffix}`;
      if (!used.includes(candidate)) {
        result.push(candidate);
        used.push(candidate);
      }
    }
  }
  return result;
}
```

### 2.5 分配示例

| Worker 数量 | 角色分配 | 名称分配 |
|-------------|----------|----------|
| 1 | builder | Tom |
| 2 | planner, builder | Tom (planner), Jerry (builder) |
| 3 | planner, builder, verifier | Tom, Jerry, Lucy |
| 4 | planner, builder, verifier, reviewer | Tom, Jerry, Lucy, Thomas |
| 5 | planner, builder, verifier, reviewer, accepter | Tom, Jerry, Lucy, Thomas, Jack |
| 6 | planner, builder×2, verifier, reviewer, accepter | Tom, Jerry, Lucy, Thomas, Jack, Lisa |
| 7 | ... + builder×3 | + Alice |
| 8 | ... + builder×4 | + Bob |
| 20 | ... | 内置名称池用完 |
| 21+ | ... | 前 20 用内置，第 21 个起由 claude-cli 生成（如 Oscar） |

### 2.6 名称唯一性保证

在初始化阶段，`scanExistingNames` 扫描已有的 worktree 目录和分支名，确保新生成的名称不与已存在的冲突：

```typescript
async function scanExistingNames(projectRoot: string): Promise<Set<string>> {
  const used = new Set<string>();
  const wtDir = path.join(projectRoot, ".claude-orchestrator", "worktree");

  // 1. 扫描已有 worktree 目录
  if (fs.existsSync(wtDir)) {
    for (const entry of await fs.promises.readdir(wtDir)) {
      used.add(entry);  // 目录名 = Worker 名
    }
  }

  // 2. 扫描已有 worktree 分支
  const branches = await execGit("branch -a", projectRoot);
  const wtBranchPattern = /claude-orchestrator\/(.+)-workspace/;
  for (const line of branches.split("\n")) {
    const m = line.trim().match(wtBranchPattern);
    if (m) used.add(m[1]);  // 从分支名提取名称
  }

  return used;
}
```

### 2.7 名称的稳定性

名称和角色的绑定关系持久化在根目录 `config.json` 的 `worktree` 段落。重复执行 `run` 时，若已有配置中存在该名称，则直接复用其角色绑定，不会重新分配。这保证了：

- `run --worker 5` 首次执行：Tom(planner), Jerry(builder), Lucy(verifier), Thomas(reviewer), Jack(accepter)
- `run --worker 5` 重复执行：复用上述绑定，不会打乱
- `run --worker 3` 缩减执行：只启动前 3 个（Tom, Jerry, Lucy），其余 worktree 保留在磁盘上但不启动

---

## 3. Git Worktree 初始化

### 3.1 目录结构

每个 Worker 的 worktree 目录直接使用其名称：

```
<项目根目录>/
└── .claude-orchestrator/
    └── worktree/
        ├── Tom/                  # git worktree (branch: claude-orchestrator/Tom-workspace)
        │   ├── .claude-orchestrator/
        │   │   └── config.json   # { "name": "Tom", "role": "planner" }
        │   └── ...
        ├── Jerry/                # git worktree (branch: claude-orchestrator/Jerry-workspace)
        │   └── ...               # { "name": "Jerry", "role": "builder" }
        ├── Lucy/                 # git worktree (branch: claude-orchestrator/Lucy-workspace)
        │   └── ...               # { "name": "Lucy", "role": "verifier" }
        ├── Thomas/               # git worktree (branch: claude-orchestrator/Thomas-workspace)
        │   └── ...               # { "name": "Thomas", "role": "reviewer" }
        └── Jack/                 # git worktree (branch: claude-orchestrator/Jack-workspace)
            └── ...               # { "name": "Jack", "role": "accepter" }
```

### 3.2 分支命名

分支名统一使用 `claude-orchestrator/${name}-workspace`：

```typescript
function getWorktreeBranch(name: string): string {
  return `claude-orchestrator/${name}-workspace`;
}
// 示例: claude-orchestrator/Planner-workspace
// 示例: claude-orchestrator/Builder2-workspace
```

### 3.3 配置持久化

项目根目录的 `.claude-orchestrator/config.json` 保存全局编排配置和所有 Worker 的 worktree 信息：

```json
{
  "worktree": {
    "Tom": {
      "name": "Tom",
      "role": "planner",
      "path": ".claude-orchestrator/worktree/Tom",
      "branch": "claude-orchestrator/Tom-workspace",
      "instance_id": "a1b2c3d4e5f6"
    },
    "Jerry": {
      "name": "Jerry",
      "role": "builder",
      "path": ".claude-orchestrator/worktree/Jerry",
      "branch": "claude-orchestrator/Jerry-workspace",
      "instance_id": "b2c3d4e5f6a1"
    }
  }
}
```

每个 worktree 内部也有自己的 `.claude-orchestrator/config.json`：

```json
{
  "name": "Planner",
  "role": "planner",
  "instance_id": "a1b2c3d4e5f6"
}
```

### 3.4 Worktree 创建流程

`src/worker/worktree-initializer.ts`：

```typescript
export interface WorktreeConfig {
  name: string;              // 拟人化名称，如 "Tom"
  role: string;              // 角色，如 "planner"
  worktreePath: string;      // 绝对路径
  relativePath: string;      // .claude-orchestrator/worktree/Tom
  branch: string;            // claude-orchestrator/Tom-workspace
  instanceId: string;        // 预生成的 instance ID
}

export async function initializeWorktrees(
  projectRoot: string,
  workerCount: number
): Promise<WorktreeConfig[]> {
  const assignments = generateWorkerNames(workerCount);
  const configs: WorktreeConfig[] = [];

  // 加载已有配置（支持重复注册）
  const existingConfig = loadProjectWorktreeConfig(projectRoot);
  const worktreeRoot = path.join(projectRoot, ".claude-orchestrator", "worktree");

  for (const { name, role } of assignments) {
    // 1. 检查是否已有配置（幂等性）
    const existing = existingConfig[name];
    if (existing && fs.existsSync(path.join(worktreeRoot, name))) {
      configs.push({
        name,  // "Tom", "Jerry" 等拟人化名称
        role,
        worktreePath: path.join(worktreeRoot, name),
        relativePath: `.claude-orchestrator/worktree/${name}`,
        branch: getWorktreeBranch(name),
        instanceId: existing.instance_id || crypto.randomUUID().replace(/-/g, ""),
      });
      continue;
    }

    // 2. 创建 worktree（名称已通过唯一性检查，无需追加后缀）
    const relativePath = `.claude-orchestrator/worktree/${name}`;
    const branch = getWorktreeBranch(name);
    const worktreePath = path.join(projectRoot, relativePath);

    await fs.promises.mkdir(worktreeRoot, { recursive: true });
    await execGit(projectRoot, `worktree add ${relativePath} -b ${branch}`);

    // 3. 生成 instanceId
    const instanceId = crypto.randomUUID().replace(/-/g, "");

    // 4. 写入 worktree 内部的 .claude-orchestrator/config.json
    const wtConfigDir = path.join(worktreePath, ".claude-orchestrator");
    await fs.promises.mkdir(wtConfigDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(wtConfigDir, "config.json"),
      JSON.stringify({ name, role, instance_id: instanceId }, null, 2)
    );

    // 5. 在 worktree 中复制模板和技能（使用 ensureEnvironment 的 worktree 版本）
    await ensureWorktreeEnvironment(worktreePath);

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

### 3.5 幂等性

`run` 命令可重复执行。如果 worktree 目录已存在且配置完整，则跳过创建步骤，直接复用已有配置：

```
run --worker 5 (首次)  → 创建 5 个 worktree
run --worker 5 (重复)  → 检测到 worktree 已存在，跳过创建，直接启动
run --worker 3 (缩减)  → 只启动前 3 个已有 worktree，其余不启动
```

### 3.6 错误处理

- **worktree 路径已存在**：跳过创建，复用已有（这是正常情况）
- **branch 已存在**：跳过 `git worktree add`，直接 checkout 到已有分支
- **git worktree add 失败**（其他原因）：跳过该 Worker，记录错误日志

---

## 4. Worker 名片机制

### 4.1 设计原则

发送给 claude-cli 的每一条 prompt 都必须包含当前 Worker 的身份名片。名片由 TemplateEngine 在渲染时统一注入，Worker 代码无需关心。

### 4.2 名片格式

```
## Worker Identity

You are **${name}**, a **${role}** in the multi-agent orchestration system.

- Name: ${name}
- Role: ${role}
- Worktree: ${worktree_path}
- Branch: ${worktree_branch}
- Instance: ${instance_id}

---
${original_prompt}
```

具体实现为生成一个 Markdown 块，插入在模板渲染后的 prompt 最前面。

### 4.3 TemplateEngine 变更

`src/executor/template.ts` 中的 `render` 方法修改为自动注入名片：

```typescript
const BUSINESS_CARD = `## Worker Identity

You are **{{name}}**, a **{{preset_role}}** in the multi-agent orchestration system.

- Name: {{name}}
- Role: {{preset_role}}
- Worktree: {{worktree_path}}
- Branch: {{worktree_branch}}
- Instance: {{instance_id}}

---
`;

export class TemplateEngine {
  // ... 现有代码 ...

  render(template: string, vars: Record<string, string>): string {
    // 1. 先渲染模板中的变量
    let body = template;
    for (const [key, value] of Object.entries(vars)) {
      body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    // 2. 在模板结果前面统一注入名片
    const card = BUSINESS_CARD
      .replace(/\{\{name\}\}/g, vars.name ?? "unknown")
      .replace(/\{\{preset_role\}\}/g, vars.preset_role ?? "unknown")
      .replace(/\{\{worktree_path\}\}/g, vars.worktree_path ?? "")
      .replace(/\{\{worktree_branch\}\}/g, vars.worktree_branch ?? "")
      .replace(/\{\{instance_id\}\}/g, vars.instance_id ?? "");

    return card + body;
  }
}
```

### 4.4 WorkerWatcher 传递名片变量

`src/worker/watcher.ts` 的 `processMessage` 中，模板变量增加名片字段：

```typescript
const prompt = template
  ? this.templateEngine.render(template, {
      name: this.instanceName,
      preset_role: this.instanceRole,
      task_title: (msg.task_title as string) ?? "",
      task_description: (msg.task_description as string) ?? msg.content,
      task_criteria: (msg.task_criteria as string) ?? "",
      task_doc_path: (msg.task_doc_path as string) ?? "",
      result_path: resultPath,
      work_dir: this.worktreePath,
      time: new Date().toISOString(),
      content: msg.content,
      // v0.4 名片字段
      worktree_path: this.worktreePath,
      worktree_branch: this.worktreeBranch,
      instance_id: this.instanceId,
    })
  : msg.content;
```

### 4.5 效果

无论 Worker 执行什么模板（plan、build、verify 等），claude-cli 收到的 prompt 始终以名片开头，例如：

```
## Worker Identity

You are **Tom**, a **planner** in the multi-agent orchestration system.

- Name: Tom
- Role: planner
- Worktree: .claude-orchestrator/worktree/Tom
- Branch: claude-orchestrator/Tom-workspace
- Instance: a1b2c3d4e5f6

---
## Task

... (模板原始内容)
```

---

## 5. Worker 子进程架构

### 5.1 为什么用 child_process 而不是 worker_threads

| 需求 | child_process | worker_threads |
|------|--------------|----------------|
| 独立的 `process.cwd()` | 天然支持 | 不支持（共享 cwd） |
| 独立的 git 操作 | 天然支持 | 需手动切换目录 |
| 独立的 ZK 连接 | 天然支持 | 支持但不隔离 |
| 独立的内存空间 | 是 | 共享堆 |
| 进程崩溃隔离 | 完全隔离 | 可能影响主进程 |

结论：`child_process.fork()` 是更合适的选择。

### 5.2 子进程入口

新建 `src/worker/child.ts`：

```typescript
#!/usr/bin/env node
import { startWorkerChild } from "./child-runner.js";

const config = JSON.parse(process.argv[2]);
startWorkerChild(config).catch((err) => {
  console.error("Worker child fatal error:", err);
  process.exit(1);
});
```

### 5.3 子进程核心逻辑

`src/worker/child-runner.ts`：

```typescript
export interface ChildConfig {
  worktreePath: string;      // 工作区绝对路径
  name: string;              // 单单词名称
  role: string;
  instanceId: string;
  branch: string;            // claude-orchestrator/${name}-workspace
  zkHosts: string;
  debug: boolean;
  cliCommand: string;
  cacheDir: string;
}

export async function startWorkerChild(config: ChildConfig): Promise<void> {
  // 1. 切换工作目录到 worktreePath
  process.chdir(config.worktreePath);

  // 2. 连接 ZK
  const zk = new ZkClient(config.zkHosts);
  await zk.connect();

  // 3. 注册 Instance（EPHEMERAL），携带 worktree 信息
  const registry = new InstanceRegistry(zk);
  const instance = await registry.register(config.name, config.role, config.instanceId);

  // 4. 初始化 ClaudeRunner（workDir = worktreePath）
  const agentsDir = path.join(config.worktreePath, ".claude-orchestrator", "agents");
  const runner = new ClaudeRunner(
    config.cliCommand, config.cacheDir, instance.id, config.worktreePath
  );

  // 5. 初始化 WorkerWatcher
  const templateEngine = new TemplateEngine(agentsDir);
  const evaluator = new SelfEvaluator(templateEngine, runner, config.name, config.role);
  const commitChecker = new CommitChecker(config.worktreePath, runner);
  const hooks = new HookEngine();

  const watcher = new WorkerWatcher(
    zk, instance.id, instance.id,
    hooks, templateEngine, runner, evaluator, commitChecker,
    config.worktreePath, config.branch
  );

  // 6. 启动父进程存活检测
  const parentCheck = startParentAliveCheck(watcher, zk);

  // 7. 启动监听循环
  await watcher.start();

  // 8. 等待 SIGINT
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(parentCheck);
      watcher.stop();
      resolve();
    });
  });

  // 9. 清理
  await registry.unregister(instance.id);
  await zk.disconnect();
}
```

### 5.4 主进程管理

`src/orchestrator/run.ts` 中启动所有子进程：

```typescript
async function startAllWorkers(opts: {
  zkHosts: string;
  configs: WorktreeConfig[];
  debug: boolean;
}): Promise<ChildProcess[]> {
  const resolvedConfig = loadConfig({ zookeeper: opts.zkHosts });
  const children: ChildProcess[] = [];

  for (const cfg of opts.configs) {
    const child = fork(
      path.join(__dirname, "..", "worker", "child.js"),
      [JSON.stringify({
        worktreePath: cfg.worktreePath,
        name: cfg.name,
        role: cfg.role,
        instanceId: cfg.instanceId,
        branch: cfg.branch,
        zkHosts: opts.zkHosts,
        debug: opts.debug,
        cliCommand: resolvedConfig.cliCommand,
        cacheDir: resolvedConfig.cacheDir,
      })],
      { stdio: "inherit" }
    );
    children.push(child);
  }

  // SIGINT → 转发给所有子进程
  process.on("SIGINT", () => {
    for (const child of children) child.kill("SIGINT");
  });

  return children;
}
```

### 5.5 子进程崩溃恢复

```typescript
child.on("exit", (code, signal) => {
  if (code !== 0 && code !== null && !shuttingDown) {
    const retries = restartCount.get(cfg.name) ?? 0;
    if (retries < 3) {
      logger.warn(`Worker ${cfg.name} 异常退出 (code=${code})，第 ${retries + 1} 次重启`);
      restartCount.set(cfg.name, retries + 1);
      spawnChild(cfg);
    } else {
      logger.error(`Worker ${cfg.name} 已达最大重启次数，放弃`);
    }
  }
});
```

### 5.6 孤儿进程防护

子进程自主检测父进程存活性。每秒检查一次，如果父进程不存在，子进程主动退出。

```typescript
function startParentAliveCheck(
  watcher: WorkerWatcher,
  zk: ZkClient
): ReturnType<typeof setInterval> {
  const parentPid = process.ppid;

  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);  // 信号 0 只检查进程是否存在
    } catch {
      watcher.stop();
      zk.disconnect();
      process.exit(0);
    }
  }, 1000);

  return timer;
}
```

主进程侧也有防护：

```typescript
["exit", "SIGINT", "SIGTERM", "uncaughtException"].forEach((signal) => {
  process.on(signal, () => {
    for (const child of children) {
      try { child.kill("SIGTERM"); } catch { /* 子进程可能已退出 */ }
    }
  });
});
```

---

## 6. TUI 布局设计

### 6.1 整体布局

由于多个 Worker 可能同时处理消息，且每条消息内容可能很长，v0.4 引入 **Worker 可切换的消息面板**：

- TEAM 面板中通过键盘选择当前关注的 Worker（高亮显示）
- WORKER MESSAGES 面板只展示**被选中 Worker** 的详细消息内容和历史
- 通过 `Tab` / `Shift+Tab` 切换选中的 Worker

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TEAM                              cols-2                                    │
│ ─────────────────────────────────────────────────────────────────────────── │
│   Name    Role      Worktree    Branch                       PID    Status  │
│ > Tom     planner   Tom         claude-or…om-workspace     48291  busy     │
│   Jerry   builder   Jerry       claude-or…ry-workspace     48292  busy     │
│   Lucy    verifier  Lucy        claude-or…cy-workspace     48293  idle     │
└─────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────┐ ┌────────────────────────────┐
│ PENDING                    │ │ IN PROGRESS                │
│ ...                        │ │ ...                        │
└────────────────────────────┘ └────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ WORKER MESSAGES — Tom (planner)           [Tab/Shift+Tab 切换 Worker]        │
│ ─────────────────────────────────────────────────────────────────────────── │
│ ◆ 当前任务 (12:03:45)  [decompose]                                          │
│   "Decompose user authentication module into actionable chain tasks.        │
│    The requirements include login, registration, password reset..."         │
│                                                                             │
│ 历史消息:                                                                    │
│   12:01:22 [decompose]  "Analyze project structure and identify core..."     │
│   11:58:05 [decompose]  "Review initial requirements for the auth..."       │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ EVENT LOG                                                                   │
│ 12:03:45 Tom received decompose message                                     │
│ 12:04:12 Jerry received build message                                       │
└─────────────────────────────────────────────────────────────────────────────┘

> Type a message and press Enter to send█
```

### 6.2 键盘交互

`LeaderTui` 在现有输入处理基础上增加 Worker 切换按键：

| 按键 | 行为 |
|------|------|
| `Tab` | 选中下一个 Worker，循环（到末尾后回到第一个） |
| `Shift+Tab` | 选中上一个 Worker，循环 |
| `1`-`9` | 直接跳转到第 N 个 Worker |

敲击 `Tab` 时，`selectedWorkerIndex` 自增并对 Worker 总数取模。TUI 立即 re-render，TEAM 面板的 `>` 标记移动到新行，WORKER MESSAGES 面板切换内容。

```typescript
// LeaderTui 中
private selectedWorkerIndex = 0;

private setupInput(): void {
  process.stdin.on("data", (data: Buffer) => {
    const key = data.toString();

    // ... 现有逻辑：Ctrl+C, Enter, Backspace, Escape ...

    if (key === "\t") {
      // Tab — 下一个 Worker
      if (this.state && this.state.workers.length > 0) {
        this.selectedWorkerIndex =
          (this.selectedWorkerIndex + 1) % this.state.workers.length;
        this.rerender();
      }
      return;
    }

    if (key === "\x1b[Z") {
      // Shift+Tab — 上一个 Worker
      if (this.state && this.state.workers.length > 0) {
        this.selectedWorkerIndex =
          (this.selectedWorkerIndex - 1 + this.state.workers.length) %
          this.state.workers.length;
        this.rerender();
      }
      return;
    }

    // 数字键 1-9 直接跳转
    if (key >= "1" && key <= "9") {
      const idx = parseInt(key) - 1;
      if (this.state && idx < this.state.workers.length) {
        this.selectedWorkerIndex = idx;
        this.rerender();
      }
      return;
    }

    // ... 现有可打印字符处理 ...
  });
}

// 选中索引在 worker_left 时修正
// 在 LeaderState.apply 的 worker_left 处理后通知 TUI 修正选中索引
```

### 6.3 TEAM 面板选中高亮

渲染 TEAM 面板时，选中的 Worker 行前缀 `>` 标记并高亮：

```typescript
function renderTeamRow(w: WorkerInfo, selected: boolean, cols: number): string {
  const marker = selected ? `${BOLD}${CYAN}>${RESET}` : " ";
  const name = selected ? `${BOLD}${CYAN}${w.name}${RESET}` : w.name;
  // ... 其余列渲染 ...
  return ` ${marker} ${name} ...`;
}
```

### 6.4 Worker Messages 面板设计

面板只展示当前选中 Worker 的消息详情。分为两部分：

**当前任务段**：如果 Worker 正在处理消息，展示消息全文（或更长截断，例如 300 字符）；如果空闲则显示 `(idle)`。

**历史消息段**：展示该 Worker 最近收到的消息列表（最多 5 条），每条一行：时间戳 + link 标签 + 消息摘要（截断）。

```typescript
function renderWorkerMessages(
  worker: WorkerInfo,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  const contentW = maxWidth - 4; // 内边距

  // ── 当前任务 ──
  if (worker.status === "busy" && worker.currentMessage) {
    const linkTag = worker.currentMessageLink
      ? ` ${CYAN}[${worker.currentMessageLink}]${RESET}`
      : "";
    const time = worker.currentMessageTime
      ? ` ${DIM}(${worker.currentMessageTime})${RESET}`
      : "";
    lines.push(` ${GREEN}◆${RESET} ${BOLD}当前任务${RESET}${time}${linkTag}`);

    // 消息全文，自动换行
    const wrapped = wrapText(worker.currentMessage, contentW - 2);
    for (const line of wrapped) {
      lines.push(`   ${line}`);
    }
    lines.push("");
  } else if (worker.lastCompletedTask) {
    lines.push(` ${DIM}◇ (idle) — 上次任务: ${worker.lastCompletedTask}${RESET}`);
    lines.push("");
  } else {
    lines.push(` ${DIM}◇ (idle)${RESET}`);
    lines.push("");
  }

  // ── 历史消息 ──
  if (worker.messageHistory.length > 0) {
    lines.push(` ${BOLD}历史消息:${RESET}`);
    for (const entry of worker.messageHistory.slice(-5).reverse()) {
      const time = `${DIM}${entry.timestamp}${RESET}`;
      const link = entry.link ? ` ${CYAN}[${entry.link}]${RESET}` : "";
      const summary = truncate(entry.content, contentW - 25);
      lines.push(`   ${time}${link}  "${summary}"`);
    }
  }

  return lines;
}
```

### 6.5 LeaderState 扩展

```typescript
export interface WorkerMessageEntry {
  timestamp: string;
  content: string;      // 消息摘要（截断存储，最多 200 字符）
  contentFull: string;  // 完整消息内容（展示用）
  link: string | null;
  messageId: string;
}

export interface WorkerInfo {
  id: string;
  name: string;
  presetRole: string;
  currentRole: string | null;
  status: string;
  currentTaskId: string | null;
  worktreeName: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  pid: number | null;
  // v0.4 Worker Messages 面板
  currentMessage: string | null;
  currentMessageLink: string | null;
  currentMessageTime: string | null;
  messageHistory: WorkerMessageEntry[];  // 最多保留 20 条
  lastCompletedTask: string | null;
}

export class LeaderState {
  workers: WorkerInfo[] = [];
  selectedWorkerIndex = 0;  // TUI 当前选中的 Worker 序号
  // ...
}
```

### 6.6 消息事件流

```
1. Worker 收到任务消息
   → LeaderWatcher 发出 worker_message_received 事件
   → LeaderState.apply():
       worker.currentMessage = content
       worker.messageHistory.push(entry)     // 追加到历史
       worker.messageHistory.slice(-20)      // 保留最近 20 条

2. 用户按 Tab → TUI 更新 selectedWorkerIndex → re-render
   → TEAM 面板: > 标记移动
   → WORKER MESSAGES 面板: 切换为新的 Worker 的内容

3. Worker 完成任务，发送 completion report
   → ChainRouter 处理 → emit task_completed
   → LeaderState.apply():
       worker.lastCompletedTask = task.title
       worker.currentMessage = null
       worker.currentMessageLink = null
       worker.currentMessageTime = null
```

### 6.7 LeaderState.apply 变更

```typescript
case "worker_message_received": {
  const w = this.workers.find(w => w.id === event.instanceId);
  if (w) {
    const rawContent = (event.content as string) ?? "";
    const timestamp = (event.timestamp as string) ?? "";

    w.currentMessage = rawContent;  // 完整内容
    w.currentMessageLink = (event.link as string) ?? null;
    w.currentMessageTime = timestamp;

    w.messageHistory.push({
      timestamp,
      content: rawContent.slice(0, 200),
      contentFull: rawContent,
      link: (event.link as string) ?? null,
      messageId: (event.messageId as string) ?? "",
    });
    if (w.messageHistory.length > 20) {
      w.messageHistory = w.messageHistory.slice(-20);
    }

    w.status = "busy";
  }
  break;
}

case "task_completed": {
  const w = this.workers.find(w => w.id === event.instanceId);
  if (w) {
    w.lastCompletedTask = (event.task as Record<string, unknown>)?.title as string ?? null;
    w.currentMessage = null;
    w.currentMessageLink = null;
    w.currentMessageTime = null;
  }
  // ... 现有逻辑 ...
  break;
}

case "worker_left": {
  // 如果选中的 Worker 下线，重置选中索引
  const leftIdx = this.workers.findIndex(w => w.id === event.instanceId);
  this.workers = this.workers.filter(w => w.id !== event.instanceId);
  if (leftIdx === this.selectedWorkerIndex) {
    this.selectedWorkerIndex = Math.min(this.selectedWorkerIndex, this.workers.length - 1);
  }
  // ...
  break;
}
```

### 6.8 TUI 渲染实现

```typescript
render(state: LeaderState): void {
  // ... 现有的 TEAM / PENDING / IN PROGRESS 渲染 ...

  // ── Worker Messages Panel ──
  const selected = state.workers[state.selectedWorkerIndex];
  if (selected) {
    const msgWidth = cols - 2;
    const msgLines: string[] = [];

    const title = `WORKER MESSAGES — ${selected.name} (${selected.presetRole})`;
    const hint = `${DIM}[Tab/Shift+Tab 切换 Worker]${RESET}`;
    const titleLine = ` ${title}${" ".repeat(Math.max(2, msgWidth - 4 - stripAnsi(title).length - stripAnsi(hint).length))}${hint}`;
    msgLines.push(titleLine);
    msgLines.push(` ${DIM}${"─".repeat(msgWidth - 4)}${RESET}`);

    msgLines.push(...renderWorkerMessages(selected, msgWidth));
    out += box(msgWidth, ...msgLines);
  }

  // ... EVENT LOG / INPUT LINE ...（input 处理增加 Tab/数字键）
}
```

### 6.9 高度自适应

TUI 面板高度优先级：

1. **TEAM 面板**：N 个 Worker + 2（header + divider），最多显示 8 行，超出截断
2. **PENDING / IN PROGRESS**：各最多 10 个任务
3. **WORKER MESSAGES**：固定高度（当前任务 5 行 + 历史消息最多 5 行 + header + divider = ~12 行），不随 Worker 数量变化
4. **EVENT LOG**：剩余空间
5. **INPUT LINE**：固定 4 行

```typescript
const teamH = Math.min(state.workers.length, 8) + 2;
const taskH = Math.min(Math.max(pendLines.length, progLines.length), 10) + 2;
const msgH = 12;  // 固定 12 行（当前任务 + 5 条历史）
const inputH = 4;
const logH = Math.max(3, rows - teamH - taskH - msgH - inputH - 5);
```

相比之前每个 Worker 一行撑满面板的设计，固定高度 + 可切换的方案在 Worker 数量较多时（如 20 个）不会占用过多终端空间。用户只需 `Tab` 切换到关心的 Worker 即可查看详细消息。

### 6.10 Instance Schema 扩展

`src/models/schemas.ts`：

```typescript
export const InstanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: InstanceRole.default("builder"),
  status: InstanceStatus.default("idle"),
  current_task_id: z.string().nullable().default(null),
  connected_since: z.string(),
  work_dir: z.string().nullable().default(null),
  // v0.4 新增
  worktree_name: z.string().nullable().default(null),
  worktree_path: z.string().nullable().default(null),
  worktree_branch: z.string().nullable().default(null),
  pid: z.number().int().nullable().default(null),
});
5. INPUT LINE：固定 4 行

```typescript
const teamH = Math.min(state.workers.length, 8) + 2;
const taskH = Math.min(Math.max(pendLines.length, progLines.length), 10) + 2;
const msgH = state.workers.length + 2;
const inputH = 4;
const logH = Math.max(3, rows - teamH - taskH - msgH - inputH - 5);
```

### 6.9 Instance Schema 扩展

`src/models/schemas.ts`：

```typescript
export const InstanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: InstanceRole.default("builder"),
  status: InstanceStatus.default("idle"),
  current_task_id: z.string().nullable().default(null),
  connected_since: z.string(),
  work_dir: z.string().nullable().default(null),
  // v0.4 新增
  worktree_name: z.string().nullable().default(null),
  worktree_path: z.string().nullable().default(null),
  worktree_branch: z.string().nullable().default(null),
  pid: z.number().int().nullable().default(null),
});
```

---

## 7. 任务完成后自动提交

### 7.1 CommitChecker 模块

`src/worker/commit-checker.ts`：

```typescript
export interface CommitResult {
  sha: string;
  message: string;
  changedFiles: string[];
  untrackedFiles: string[];
}

export class CommitChecker {
  constructor(
    private worktreePath: string,
    private runner: ClaudeRunner
  ) {}

  async check(taskContext: {
    link: string;
    taskTitle: string;
    taskDescription: string;
  }): Promise<CommitResult | null> {
    // 1. git status --porcelain
    const statusOutput = await this.execGit("status --porcelain");
    if (!statusOutput.trim()) return null;

    // 2. 解析变更
    const { changed, untracked } = this.parseStatus(statusOutput);

    // 3. claude-cli 生成 commit message
    const commitMsg = await this.generateCommitMessage(changed, untracked, taskContext);

    // 4. git add -A && git commit
    await this.execGit("add -A");
    await this.execGit(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);

    // 5. 获取 commit SHA
    const sha = (await this.execGit("rev-parse HEAD")).trim();

    return { sha, message: commitMsg, changedFiles: changed, untrackedFiles: untracked };
  }

  private async generateCommitMessage(
    changed: string[], untracked: string[], ctx: CommitContext
  ): Promise<string> {
    // prompt 通过 runner.run 发送给 claude-cli
    // Runner 会自动在 prompt 前面注入 Worker 名片（见第 4 节）
    const prompt = `## Commit Task

Changed files:
${changed.join("\n")}

Untracked files:
${untracked.join("\n")}

Task: ${ctx.taskTitle} (${ctx.link})

Generate a concise git commit message (single line, under 72 chars).
Output ONLY the commit message.`;

    const logPath = this.runner.logPath(`commit-${Date.now().toString(36)}`);
    await this.runner.run(prompt, logPath);
    const output = await fs.promises.readFile(logPath, "utf-8");
    return output.trim().split("\n")[0].slice(0, 72);
  }
}
```

### 7.2 WorkerWatcher 集成

`processMessage` 中在 `sendCompletionReport` 之前调用：

```typescript
let commitResult: CommitResult | null = null;
if (link !== "_generic") {
  commitResult = await this.commitChecker.check({
    link, taskTitle, taskDescription,
  });
}

await this.sendCompletionReport(link, msg, resultPath, uniqueKey, commitResult);
```

Completion report 中包含 commit 信息：

```json
{
  "decision": "activate_next",
  "reason": "...",
  "nextLink": "verify",
  "commit": {
    "sha": "a1b2c3d",
    "message": "Implement user authentication",
    "branch": "claude-orchestrator/Builder-workspace",
    "changed_files": ["src/auth/login.ts"],
    "untracked_files": []
  }
}
```

---

## 8. Leader 交叉验证与合并

### 8.1 MergeValidator 模块

`src/leader/merge-validator.ts`：

```typescript
export interface MergeDecision {
  decision: "merge" | "skip" | "review_first";
  reason: string;
}

export class MergeValidator {
  constructor(
    private projectRoot: string,
    private runner: ClaudeRunner,
    private eventBus: LeaderEventBus
  ) {}

  async validate(commitInfo: {
    sha: string; message: string; branch: string;
    taskTitle: string; taskLink: string;
  }): Promise<MergeDecision> {
    const mainBranch = await this.getMainBranch();
    const merged = await this.isCommitMerged(commitInfo.sha, mainBranch);
    if (merged) return { decision: "skip", reason: "已合并" };

    const decision = await this.askMergeDecision(commitInfo, mainBranch);

    if (decision.decision === "merge") {
      try {
        await this.execGit(`checkout ${mainBranch}`);
        await this.execGit(
          `merge ${commitInfo.branch} --no-ff -m "Merge ${commitInfo.branch}: ${commitInfo.message}"`
        );
        this.eventBus.emit({
          type: "debug_info",
          message: `合并成功: ${commitInfo.branch} → ${mainBranch}`,
        });
      } catch {
        await this.execGit("merge --abort");
        return { decision: "review_first", reason: "合并冲突，需人工处理" };
      }
    }

    return decision;
  }

  private async askMergeDecision(
    commit: MergeValidatorCommit, mainBranch: string
  ): Promise<MergeDecision> {
    const prompt = `
Branch \`${commit.branch}\` has unmerged commits.

- SHA: ${commit.sha}
- Message: ${commit.message}
- Task: ${commit.taskTitle} (${commit.taskLink})

Options:
- merge: merge into ${mainBranch}
- skip: leave unmerged
- review_first: flag for human review

Respond with JSON: {"decision": "merge|skip|review_first", "reason": "..."}
`;
    const logPath = this.runner.logPath(`merge-decision-${Date.now().toString(36)}`);
    await this.runner.run(prompt, logPath);
    const output = await fs.promises.readFile(logPath, "utf-8");
    return JSON.parse(output);
  }
}
```

### 8.2 ChainRouter 集成

`handleCompletionReport` 中解析 commit 信息并触发验证：

```typescript
private async handleCompletionReport(msg: Message): Promise<void> {
  try {
    const parsed = JSON.parse(msg.content);
    if (parsed.commit?.sha) {
      const mergeDecision = await this.mergeValidator.validate({
        sha: parsed.commit.sha,
        message: parsed.commit.message,
        branch: parsed.commit.branch,
        taskTitle: (msg.task_title as string) ?? "unknown",
        taskLink: (msg.link as string) ?? "unknown",
      });
      // ... 记录决策
    }
  } catch { /* 继续正常流程 */ }

  // ... 现有 EvalDecision 处理 ...
}
```

---

## 9. 文件变更清单

### 9.1 新增文件

| 文件 | 职责 |
|------|------|
| `src/orchestrator/run.ts` | `run` 命令顶层入口：环境自检 → worktree 初始化 → 启动 Leader TUI → spawn Worker 子进程 |
| `src/worker/worktree-initializer.ts` | 角色分配、git worktree 创建、配置持久化、幂等性检查 |
| `src/worker/child.ts` | 子进程入口，接收 JSON 配置 |
| `src/worker/child-runner.ts` | 子进程核心逻辑：chdir、ZK 连接、注册 Instance、启动 WorkerWatcher |
| `src/worker/commit-checker.ts` | 任务后 git status 检查、claude-cli 生成 commit message、自动 commit |
| `src/leader/merge-validator.ts` | 交叉验证 worker 分支合并状态、claude-cli 决策 merge/skip/review_first、执行 merge |

### 9.2 修改文件

| 文件 | 变更内容 |
|------|----------|
| `src/index.ts` | 移除 `setup`/`leader`/`register` 命令，新增 `run --worker <n>` 命令 |
| `src/cli/commands.ts` | 移除 `cmdRegister`/`cmdSetup` 导出，保留 `cmdPushTask`/`cmdSendMessage` 等 |
| `src/executor/template.ts` | `render()` 方法统一注入 Worker 名片 |
| `src/worker/watcher.ts` | 增加 `worktreePath`/`worktreeBranch` 构造参数；模板变量增加名片字段；集成 CommitChecker |
| `src/leader/chain-router.ts` | 增加 `mergeValidator` 依赖；`handleCompletionReport` 提取 commit 并验证合并 |
| `src/leader/event-bus.ts` | 新增 `worker_message_received` 事件类型 |
| `src/leader/state.ts` | `LeaderState` 增加 `selectedWorkerIndex`；`WorkerInfo` 增加 worktree/pid/message/messageHistory/lastCompletedTask 字段；`apply()` 处理新事件并修正选中索引 |
| `src/leader/tui.ts` | Team 面板增加 Worktree/Branch/PID 列 + 选中高亮；新增可切换 Worker Messages 面板；输入处理增加 Tab/Shift+Tab/数字键 |
| `src/leader/watcher.ts` | 处理消息时发出 `worker_message_received` 事件 |
| `src/leader/index.ts` | 接受 `worktreeConfigs` 参数，初始化 `MergeValidator` 并注入 `ChainRouter` |
| `src/models/schemas.ts` | `InstanceSchema` 增加 worktree/pid 字段；`MessageSchema` 增加 commit 字段 |
| `src/config.ts` | 增加 `loadProjectWorktreeConfig`/`saveProjectWorktreeConfig` 函数 |
| `package.json` | 版本号升级到 `0.4.0` |

### 9.3 移除的内容

| 移除项 | 说明 |
|--------|------|
| `src/index.ts` 中 `setup` 子命令 | 合并到 `run` 阶段 1 |
| `src/index.ts` 中 `leader` 子命令 | 合并到 `run` 阶段 3 |
| `src/index.ts` 中 `register` 子命令 | 合并到 `run` 阶段 4 |
| `src/cli/commands.ts` 中 `cmdSetup` 函数 | 合并到 `run.ts` 的 `ensureEnvironment` |
| `src/cli/commands.ts` 中 `cmdRegister` 函数 | 合并到 `run.ts` 的 `startAllWorkers` |

### 9.4 不变文件

- `src/zk/client.ts`、`src/zk/paths.ts` — ZK 操作不变
- `src/modules/registry.ts`、`src/modules/task-queue.ts`、`src/modules/message-router.ts` — 模块不变
- `src/worker/evaluator.ts` — 自评估逻辑不变
- `src/executor/runner.ts` — Runner 不变
- `src/hooks/`、`src/utils/` — 基础设施不变
- `src/templates/`、`skills/` — 模板和技能文件不变

---

## 10. 数据流

### 10.1 完整启动流程

```
用户执行: claude-orchestrator run --worker 5
  │
  ├─ 阶段 1: ensureEnvironment()
  │     ├─ 检查 ~/.claude-orchestrator/config.json → 不存在则写入默认值
  │     ├─ 检查 .claude-orchestrator/agents/ → 缺失则复制模板
  │     └─ 检查 .claude/skills/ → 缺失则复制技能
  │
  ├─ 阶段 2: initializeWorktrees(projectRoot, 5)
  │     ├─ generateWorkerAssignment(5) → [Tom(planner), Jerry(builder), Lucy(verifier), Thomas(reviewer), Jack(accepter)]
  │     ├─ 加载已有 worktree 配置（幂等性检查）
  │     ├─ 对每个 name:
  │     │   ├─ 已存在 → 跳过创建，复用
  │     │   └─ 不存在 → git worktree add + 写 config + npm install
  │     └─ saveProjectWorktreeConfig() → 持久化到 config.json
  │
  ├─ 阶段 3: startLeader()
  │     ├─ ZK 连接 + 创建 /leader EPHEMERAL
  │     ├─ 注册 Leader Instance
  │     ├─ 启动 WorkerMonitor / TaskOrchestrator / TaskRecovery / LeaderWatcher
  │     └─ 渲染 TUI（显示 worktree 信息 + Worker Messages 面板）
  │
  ├─ 阶段 4: startAllWorkers()
  │     ├─ fork Tom 子进程 → chdir(.claude-orchestrator/worktree/Tom)
  │     ├─ fork Jerry 子进程 → chdir(.claude-orchestrator/worktree/Jerry)
  │     ├─ fork Lucy 子进程
  │     ├─ fork Thomas 子进程
  │     └─ fork Jack 子进程
  │
  └─ 阶段 5: 阻塞等待
        └─ SIGINT → kill 所有子进程 → 注销 → 断开 ZK
```

### 10.2 任务处理流程

```
LeaderWatcher 收到用户输入 (TUI)
  │
  └─ ChainRouter.route()
        └─ handleRequirement() → 发送 decompose 消息给 Tom (planner)
              │
              ├─ Tom Worker (worktree: .claude-orchestrator/worktree/Tom)
              │     ├─ LeaderWatcher 发出 worker_message_received → TUI 更新
              │     │     └─ Worker Messages: ◆ Tom (planner): "Decompose..."  [plan]  12:03
              │     ├─ WorkerWatcher.processMessage()
              │     ├─ TemplateEngine.render(decompose, vars)
              │     │     └─ 注入名片: "You are Tom, a planner..."
              │     ├─ runner.run(prompt)  ← 带名片
              │     ├─ commitChecker.check()
              │     │     ├─ git status → dirty
              │     │     ├─ runner.run("Generate commit...")  ← 带名片
              │     │     └─ git add -A && git commit
              │     └─ 发送 completion report → Leader
              │           └─ TUI 清除: Tom 的 currentMessage
              │
              ├─ Leader ChainRouter.handleCompletionReport()
              │     ├─ mergeValidator.validate() → merge 成功
              │     ├─ 解析 EvalDecision → activate_next
              │     └─ 创建 build 任务 → 发送给 Jerry (builder)
              │
              └─ Jerry Worker (worktree: .claude-orchestrator/worktree/Jerry)
                    ├─ TUI Worker Messages: ◆ Jerry (builder): "Implement..."  [build]  12:04
                    └─ (同上流程, 执行 build 模板)
```

---

## 11. 错误处理矩阵

| 场景 | 位置 | 处理策略 |
|------|------|----------|
| config.json / 模板 / 技能缺失 | run.ts 阶段 1 | 自动写入默认值，不阻塞 |
| worktree 目录已存在 | worktree-initializer | 复用已有配置（幂等性） |
| branch 已存在 | worktree-initializer | 跳过 `git worktree add`，复用已有分支 |
| git worktree add 失败 | worktree-initializer | 跳过该 Worker，记录错误 |
| ZK 连接失败 | child-runner | 重试 3 次（指数退避），仍失败则退出 |
| ZK 注册失败（ID 冲突） | InstanceRegistry | 重新生成 Instance ID 并重试 |
| 子进程异常退出 | run.ts 阶段 4 | 自动重启，最多 3 次 |
| 主进程被 kill -9 | child-runner | 子进程检测父进程不存在，主动退出 |
| 主进程未捕获异常崩溃 | run.ts | `exit`/`uncaughtException` handler kill 所有子进程 |
| git status 失败 | CommitChecker | 返回 null（不阻塞任务流程） |
| claude-cli 生成 commit message 失败 | CommitChecker | 使用默认 message "chore: auto-commit from ${name}" |
| 合并决策 claude-cli 调用失败 | MergeValidator | 默认 `review_first` |
| 合并冲突 | MergeValidator | `git merge --abort`，返回 `review_first` |
| Leader 不在运行时收到 completion | N/A | Worker 正常发送，Leader 启动后处理积压消息 |

---

## 12. 向后兼容性

| 变更项 | 兼容性影响 |
|--------|-----------|
| `setup`/`leader`/`register` 命令移除 | **破坏性变更**。v0.3 的三个命令被 `run --worker` 取代 |
| `InstanceSchema` 新增 worktree/pid 字段 | 向后兼容，默认 null |
| `MessageSchema` 新增 commit 字段 | 向后兼容，默认 null |
| ZK 节点树结构 | 完全不变 |
| `push-task`/`send-message` 等其他命令 | 完全不变 |
| 模板文件 | 不变（名片由 TemplateEngine 注入，不修改模板文件本身） |
| TUI 布局 | 视觉变更（新增三列），功能不受影响 |

---

## 13. 实现顺序

1. **`src/orchestrator/run.ts`** — `run` 命令顶层编排：环境自检 + 阶段串联
2. **`src/worker/worktree-initializer.ts`** — 角色分配 + worktree 创建 + 配置持久化
3. **`src/executor/template.ts`** — 名片注入机制
4. **`src/worker/child.ts` + `src/worker/child-runner.ts`** — 子进程框架
5. **`src/index.ts`** — 命令合并（移除旧命令，新增 `run`）
6. **`src/models/schemas.ts` + `src/leader/state.ts` + `src/leader/tui.ts`** — TUI 展示 worktree/分支/PID
7. **`src/worker/commit-checker.ts` + `src/worker/watcher.ts`** — 自动提交
8. **`src/leader/merge-validator.ts` + `src/leader/chain-router.ts` + `src/leader/index.ts`** — 交叉验证合并
9. **集成测试** — 端到端测试 `run --worker 3` 完整流程
