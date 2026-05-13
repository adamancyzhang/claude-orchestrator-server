# 交互式初始化检查器

## 问题

当前 `ensureEnvironment()` (`src/orchestrator/run.ts:74-140`) 在 `run` 命令启动时静默执行所有初始化操作：

1. 创建/更新 `~/.claude-orchestrator/config.json`
2. 复制 team CLAUDE.md 到项目根
3. 复制 7 个 skill 到 `.claude/skills/` —— **无条件 `rmSync` + 覆盖**

用户无法看到每一步在做什么，skill 替换等危险操作不经确认直接执行。此外，遗漏了将 `templates/user-global-claude.md` 复制到 `~/.claude/CLAUDE.md` 的步骤。

## 方案：`InitChecker` — 交互式步骤检查器

### 新增 CLI flag

```bash
claude-orchestrator run --worker 5        # 交互模式：每一步显示并确认
claude-orchestrator run --worker 5 -y     # 非交互模式：基于历史记忆自动决策
```

### 步骤定义

初始化拆分为 6 个独立步骤，每步有明确的操作类型、危险级别和状态持久化：

| Step | 操作 | 目标路径 | 危险级别 | 危险操作条件 |
|------|------|----------|----------|-------------|
| 1. global_config | 创建/补全 | `~/.claude-orchestrator/config.json` | Caution | 仅新增缺失字段，不覆盖已有值 |
| 2. user_claude_md | 复制 | `~/.claude/CLAUDE.md` | Danger | 目标已存在且内容不同 |
| 3. team_claude_md | 复制 | `./CLAUDE.md` | Danger | 目标已存在且内容不同 |
| 4. skills | 逐 skill 复制 | `.claude/skills/{name}/SKILL.md` | Danger | 目标 skill 已存在 |
| 5. worktrees | 创建/复用 | `.claude-orchestrator/worktree/{name}/` | Safe | 无危险操作（幂等） |
| 6. npm_install | 安装依赖 | 各 worktree | Caution | 耗时操作，可能失败 |

### 危险级别定义

```
Safe      (绿色) — 创建新文件/目录，不覆盖任何内容
Caution   (黄色) — 修改配置但保留用户数据，或耗时操作
Danger    (红色) — 覆盖/替换已有文件，不可逆
```

### 交互模式行为

每一步执行前：

1. **打印步骤标题和描述**（带颜色标记）
2. **显示操作详情**：源 → 目标，内容变更预览
3. **判断是否需要确认**：
   - Safe 操作：自动执行，仅打印结果
   - Caution 操作：打印警告，简要确认
   - Danger 操作：**必须征求用户同意**，显示 diff

示例输出：

```
╭─ Step 2/6: User Global CLAUDE.md ──────────────────────────────╮
│                                                                  │
│  Copy: templates/user-global-claude.md                           │
│    → ~/.claude/CLAUDE.md                                         │
│                                                                  │
│  ⚠ DANGER: Target already exists and content differs.           │
│                                                                  │
│  --- existing                                                      │
│  +++ new                                                           │
│  @@ -1,3 +1,7 @@                                                   │
│   # CLAUDE.md                                                      │
│  +Behavioral guidelines to reduce common LLM coding mistakes...   │
│                                                                  │
│  Proceed with overwrite? [y/N/skip/diff]                         │
╰──────────────────────────────────────────────────────────────────╯
```

### `-y` 模式行为

不显示交互提示，基于 `config.json` 中的 `init_status` 记忆自动决策：

| 历史状态 | `-y` 行为 |
|----------|----------|
| 无记录（首次） | 自动批准，记录 `action: "created"` |
| 曾批准（`created`/`updated`/`replaced`） | 自动批准 |
| 曾拒绝（`rejected`） | **仍然跳过**，尊重历史决策 |
| 曾跳过（`skipped`） | 仍然跳过 |

### 状态持久化

每个步骤执行后，将结果写入 `~/.claude-orchestrator/config.json` 的 `init_status` 段：

```json
{
  "commands": { "claude-cli": "..." },
  "hooks": { "..." },
  "cache_dir": ".claude-orchestrator/sessions",
  "zookeeper": { "..." },
  "init_status": {
    "global_config": {
      "action": "created",
      "timestamp": "2026-05-13T10:30:00Z"
    },
    "user_claude_md": {
      "action": "replaced",
      "timestamp": "2026-05-13T10:30:05Z",
      "reason": "User confirmed overwrite"
    },
    "team_claude_md": {
      "action": "skipped",
      "timestamp": "2026-05-13T10:30:08Z",
      "reason": "Already up to date"
    },
    "skills": {
      "task-planning": { "action": "replaced", "timestamp": "..." },
      "task-execution": { "action": "created", "timestamp": "..." },
      "task-verification": { "action": "skipped", "timestamp": "..." },
      "task-review": { "action": "skipped", "timestamp": "..." },
      "task-acceptance": { "action": "replaced", "timestamp": "..." },
      "task-traceability": { "action": "skipped", "timestamp": "..." },
      "claude-orchestrator": { "action": "created", "timestamp": "..." }
    },
    "worktrees": {
      "Tom": { "action": "created", "timestamp": "..." },
      "Jerry": { "action": "reused", "timestamp": "..." }
    },
    "npm_install": {
      "Tom": { "action": "completed", "timestamp": "..." },
      "Jerry": { "action": "failed", "timestamp": "...", "reason": "exit code 1" }
    }
  }
}
```

## 涉及改动

### 1. 新增 `src/orchestrator/init-checker.ts`

核心模块，管理步骤定义、交互确认、状态持久化：

```typescript
export type DangerLevel = "safe" | "caution" | "danger";
export type StepAction = "created" | "updated" | "replaced" | "skipped" | "rejected" | "completed" | "failed";

export interface StepRecord {
  action: StepAction;
  timestamp: string;
  reason?: string;
}

export interface InitStatus {
  global_config?: StepRecord;
  user_claude_md?: StepRecord;
  team_claude_md?: StepRecord;
  skills?: Record<string, StepRecord>;
  worktrees?: Record<string, StepRecord>;
  npm_install?: Record<string, StepRecord>;
}

export interface InitStep {
  id: string;
  title: string;
  description: string;
  dangerLevel: DangerLevel;
  /** 返回 true 表示需要用户确认 */
  check: () => Promise<{ needsConfirm: boolean; details: StepDetails }>;
  /** 实际执行 */
  execute: () => Promise<void>;
}

export class InitChecker {
  private status: InitStatus;
  private interactive: boolean;

  constructor(opts: { yFlag: boolean }) {
    this.interactive = !opts.yFlag;
    this.status = this.loadStatus();
  }

  /** 按序执行所有步骤 */
  async runAll(steps: InitStep[]): Promise<void> { ... }

  /** 单个步骤的执行逻辑 */
  private async runStep(step: InitStep): Promise<void> { ... }

  /** 加载历史状态 */
  private loadStatus(): InitStatus { ... }

  /** 持久化单个步骤状态 */
  private saveStepStatus(stepId: string, record: StepRecord): void { ... }

  /** 渲染交互提示 */
  private async promptUser(step: InitStep, details: StepDetails): Promise<boolean> { ... }
}
```

### 2. 修改 `src/orchestrator/run.ts`

将 `ensureEnvironment()` 重构为使用 `InitChecker`：

```typescript
async function ensureEnvironment(yFlag: boolean): Promise<void> {
  const checker = new InitChecker({ yFlag });

  const steps: InitStep[] = [
    createGlobalConfigStep(),
    createUserClaudeMdStep(),       // ← 新增：复制到 ~/.claude/CLAUDE.md
    createTeamClaudeMdStep(),
    createSkillsStep(),
    // worktrees 和 npm_install 在后面的阶段处理
  ];

  await checker.runAll(steps);
}
```

每个 step 的工厂函数：

- **`createGlobalConfigStep()`**：检查 `~/.claude-orchestrator/config.json`，缺失字段补全，已有字段不覆盖。危险级别 Caution（仅新增缺失 key，不覆盖已有值）。
- **`createUserClaudeMdStep()`**：复制 `templates/user-global-claude.md` → `~/.claude/CLAUDE.md`。目标已存在时显示 diff。危险级别 Danger。
- **`createTeamClaudeMdStep()`**：复制 `templates/claude-memory/team-claude.md` → `./CLAUDE.md`。目标已存在时显示 diff。危险级别 Danger。
- **`createSkillsStep()`**：遍历 7 个 skill，逐一检查。对已存在且不同的 skill 单独确认。危险级别 Danger。

### 3. 修改 `src/index.ts` — 新增 `-y` flag

```typescript
program
  .command("run")
  .description("One-shot orchestration: setup environment, start TUI, register Workers")
  .requiredOption("--worker <n>", "Number of Workers", parseInt)
  .option("-y, --yes", "Skip all interactive prompts, auto-approve based on history")
  .action(async function (this: Command) {
    const { worker, yes } = getSubOpts<{ worker: number; yes?: boolean }>(this);
    // ...
    await runOrchestrator({
      zkHosts: config.zk.url,
      workerCount: worker,
      name: undefined,
      debug,
      yFlag: !!yes,  // 新增
    });
  });
```

### 4. 修改 `src/config.ts` — 扩展 `InstanceConfig` 和持久化函数

```typescript
export interface InstanceConfig {
  // ... 现有字段
  init_status?: InitStatus;  // 新增
}

export function loadInitStatus(): InitStatus {
  const global = loadGlobalConfig();
  return (global.init_status as InitStatus) ?? {};
}

export function saveInitStatusStep(
  stepId: string,
  record: StepRecord,
  subId?: string,
): void {
  const global = loadGlobalConfig();
  const status: InitStatus = (global.init_status as InitStatus) ?? {};
  if (subId) {
    status[stepId as keyof InitStatus] = {
      ...status[stepId as keyof InitStatus],
      [subId]: record,
    } as unknown as StepRecord;
  } else {
    (status as Record<string, StepRecord>)[stepId] = record;
  }
  saveInstanceConfig({ init_status: status } as InstanceConfig, true);
}
```

### 5. Worktree 和 npm install 阶段也经过 InitChecker

`initializeWorktrees()` 返回的每个 worktree 配置经过检查器确认。复用已有 worktree 时 safe（跳过），创建新 worktree 时 safe（自动执行）。

`npm install` 耗时较长，Caution 级别，交互模式询问用户是否执行，`-y` 模式参考历史记录。

## 交互模式完整流程图

```
$ claude-orchestrator run --worker 5

╭─ Workspace Pre-flight Check ─────────────────────────────────────╮
│ git status: clean ✓                                               │
╰──────────────────────────────────────────────────────────────────╯

╭─ Step 1/6: Global Config ────────────────────────────────────────╮
│ Path: ~/.claude-orchestrator/config.json                          │
│ Action: Create (file does not exist)                     [SAFE]   │
│ Auto-executing...                                       CREATED   │
╰──────────────────────────────────────────────────────────────────╯

╭─ Step 2/6: User Global CLAUDE.md ────────────────────────────────╮
│ Source: templates/user-global-claude.md                           │
│ Target: ~/.claude/CLAUDE.md                                       │
│ Action: Overwrite (content differs)                     [DANGER]  │
│                                                                   │
│ --- existing                                                      │
│ +++ new                                                           │
│ ...                                                               │
│                                                                   │
│ Proceed? [y/N/s/diff] y                                          │
│ Executing...                                            REPLACED   │
╰──────────────────────────────────────────────────────────────────╯

╭─ Step 3/6: Team CLAUDE.md ───────────────────────────────────────╮
│ Target: ./CLAUDE.md                                               │
│ Action: Skip (already up to date)                       [SAFE]   │
│ Auto-executing...                                       SKIPPED   │
╰──────────────────────────────────────────────────────────────────╯

╭─ Step 4/6: Skills ───────────────────────────────────────────────╮
│                                                                   │
│ task-planning:   Create (new)                           [SAFE]   │
│ task-execution:  Replace (content differs)              [DANGER] │
│   Proceed? [y/N/s/diff] y                                         │
│ task-verification: Skip (up to date)                    [SAFE]   │
│ ...                                                               │
╰──────────────────────────────────────────────────────────────────╯

╭─ Step 5/6: Worktrees ────────────────────────────────────────────╮
│ Tom (planner):    Create new worktree                   [SAFE]   │
│ Jerry (builder):  Reuse existing                        [SAFE]   │
│ Lucy (verifier):  Create new worktree                   [SAFE]   │
│ Auto-executing...                                                 │
╰──────────────────────────────────────────────────────────────────╯

╭─ Step 6/6: Dependencies ─────────────────────────────────────────╮
│ npm install in Tom worktree...                          [CAUTION] │
│ npm install in Jerry worktree... (no package.json, skip)[SAFE]   │
│ npm install in Lucy worktree...                         [CAUTION] │
│ This may take a while. Proceed? [y/N] y                           │
╰──────────────────────────────────────────────────────────────────╯

Leader TUI starting...
```

## 兼容性

- `-y` flag 可选，不传时走交互模式
- `init_status` 是新字段，旧版 config.json 不存在时视为空对象，不影响现有逻辑
- Step 2（user_claude_md）是新增步骤，首次执行时若 `~/.claude/CLAUDE.md` 已存在会进入 Danger 确认
- 所有交互输入均支持 `Ctrl+C` 终止

## 收益

| 维度 | 当前 | 优化后 |
|------|------|--------|
| 可见性 | 静默执行，用户不知道发生了什么 | 每步打印，显示操作和结果 |
| 安全性 | skill 无条件 `rmSync` 覆盖 | Danger 操作征求确认 |
| 用户控制 | 无 | 可 skip 任意步骤 |
| 记忆 | 无，每次启动重复相同操作 | `init_status` 记录历史决策，`-y` 复用 |
| user CLAUDE.md | 遗漏，未复制 | 作为 Step 2 复制到 `~/.claude/CLAUDE.md` |
| 自动化 | 需人工判断 | `-y` 基于历史记录自动决策 |
