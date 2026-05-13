# CLI Optimization Plan: `--add-dir` + `--append-system-prompt` + `--resume`

相关文档：
- [`resume-session.md`](./resume-session.md) — `--resume` 优化方案：保持对话上下文传递

## Scope

优化 Leader 和 Worker 中所有 Claude Code CLI 调用以及 worktree 初始化流程，利用三个原生 CLI flag 替代当前的 Node.js 端模板渲染和文件拷贝。

## 设计原则 0: `execWithStreaming` 作为唯一执行入口

**当前 `src/utils/exec.ts` 有三个函数**：`execWithTee`、`execWithStreaming`、`execAndCapture`。它们逻辑高度重复，核心差异仅在于是否逐行解析 stdout 以及是否捕获返回值字符串。`ClaudeRunner.run()` 根据是否传入 `onStreamChunk` 回调来二选一。

**优化后**：`execWithStreaming` 是唯一的执行入口。所有 Claude CLI 调用统一走流式输出（逐行 JSON 解析），这是 `session_id` 提取和 TUI 实时展示的基础设施。

```typescript
// 统一的执行入口
async function execWithStreaming(
  command: string,
  message: string,
  logPath: string,
  onChunk?: (line: string) => void,  // 可选，TUI streaming 时传入
  cwd?: string,
  quiet?: boolean,
): Promise<{ code: number; sessionId?: string }>
```

`execWithTee` 和 `execAndCapture` 删除，其功能由 `execWithStreaming` 覆盖：
- `execWithTee` 的 tee 写日志 → `execWithStreaming` 内部同步写日志
- `execAndCapture` 的 stdout/stderr 捕获 → 不再需要（调用方不消费这两个字符串）
- 无论是否传入 `onChunk`，逐行 JSON 解析始终执行，确保 `session_id` 一定被提取

## 前置条件：`--output-format stream-json --verbose` 强制追加

**当前 `-p` 已经在 `exec.ts` 中强制追加**（`src/utils/exec.ts:15`），但 `--output-format stream-json` 和 `--verbose` 仅存在于默认 `cliCommand` 配置中，用户覆盖 `commands.claude-cli` 时可能丢失，导致 session_id 提取失败等不可控问题。

**改动**：在 `execWithStreaming` 中，将 `--output-format stream-json --verbose` 与 `-p` 一样强制追加到 shell 命令中。

```typescript
// 当前
const shellCmd = `exec ${command} -p '${escapedMsg}' | tee -a '${logPath}'`;

// 优化后
const shellCmd = `exec ${command} --output-format stream-json --verbose -p '${escapedMsg}' | tee -a '${logPath}'`;
```

同时将 `src/config.ts` 的默认 `cliCommand` 中移除这两个 flag（它们现在是代码强制追加的）：

```typescript
function defaultCliCommand(): string {
  return "claude --dangerously-skip-permissions --permission-mode dontAsk";
}
```

## 当前痛点

### 1. Worktree 初始化开销大 (`src/worker/worktree-initializer.ts:125-209`)

每个 Worker 的 worktree 初始化需要拷贝：
- 7 个 agent 模板文件 → `.claude-orchestrator/agents/`
- 7 个 skill 目录 → `.claude/skills/`
- Team CLAUDE.md → 根目录 `CLAUDE.md`
- Personal CLAUDE.md → `.claude-orchestrator/docs/{name}/CLAUDE.md`

对于 3 个 Worker 就是 3 × (7 + 7 + 2) = 48 次文件拷贝。这些模板和 skill 对所有 Worker 完全相同，每个 worktree 存一份冗余且浪费。

### 2. 模板渲染在 Node.js 侧做纯字符串操作 (`src/executor/template.ts:52-66`)

`TemplateEngine.render()` 做了两件不相关的事：
- **Business card 注入**：把 `{{name}}`、`{{role}}`、`{{instance_id}}` 等身份信息拼入 prompt
- **任务变量替换**：把 `{{task_title}}`、`{{task_description}}` 等任务信息替换进模板

Business card 属于"你是谁"（system prompt 层），任务变量属于"你要做什么"（user prompt 层）。混在一起后整个 prompt 都通过 `-p` 传入，Claude Code 无法利用 system prompt 缓存。

### 3. CLI 命令拼接脆弱 (`src/utils/exec.ts:14-15`)

```typescript
const escapedMsg = message.replace(/'/g, "'\\''");
const shellCmd = `exec ${command} -p '${escapedMsg}' | tee -a '${logPath}'`;
```

整个 prompt 经过单引号转义后嵌入 shell 命令，prompt 越长转义越脆弱。Business card 分离后 `-p` 内容缩短，降低风险。

### 4. 模板和 skill 在每个 worktree 内是孤立副本

模板更新后需要重建 worktree 才能生效，不利于迭代。当前 watch loop 在 worker 启动时一次性 `loadAll()`，运行期间不会重新加载。

---

## 优化方案

### 方案 A: `--add-dir` — 共享资源免拷贝

**目标**：消除 worktree 初始化中对 agent 模板和 skill 的文件拷贝。

**原理**：`claude --add-dir <path>` 让 Claude Code 可以访问指定目录。将模板和 skill 保留在项目根目录的单一副本，通过 `--add-dir` 指向它们。

**涉及改动**：

| 文件 | 改动点 |
|------|--------|
| `src/config.ts:62-63` | 默认 `cliCommand` 追加 `--add-dir .claude-orchestrator` |
| `src/worker/worktree-initializer.ts:135-183` | 删除 agent 模板和 skill 的拷贝逻辑 |
| `src/worker/worktree-initializer.ts:185-208` | 保留 team/personal CLAUDE.md 生成（worktree 特定） |
| `src/worker/child-runner.ts:67` | `agentsDir` 指向项目根目录的共享路径而非 worktree 内路径 |
| `src/leader/chain-router.ts` | Leader 的 runner 同样受益于 `--add-dir` |

**共享路径设计**：

```
{projectRoot}/
  .claude-orchestrator/
    agents/           ← 共享模板（单一来源）
    sessions/         ← 运行时数据（不变）
    worktree/{name}/  ← 仅保留 worktree 特定文件
      .claude-orchestrator/
        config.json   ← worker 身份
        docs/{name}/
          CLAUDE.md   ← personal CLAUDE.md
      CLAUDE.md       ← team CLAUDE.md
  .claude/
    skills/           ← 共享 skill（单一来源）
```

对于 Leader（cwd = projectRoot），`--add-dir .claude-orchestrator` 直接指向项目根下的目录。

对于 Worker（cwd = worktreePath），`--add-dir` 必须使用项目根的**绝对路径**：

```
--add-dir /abs/path/to/project/.claude-orchestrator
```

**禁止使用软链接**。`.claude-orchestrator/docs/` 中的 Worker 工件需要被 git 跟踪和 commit，软链接会导致 git 无法正确追踪实际内容。

**Worker 命令构建变更** (`src/worker/child-runner.ts:68-74`)：

```typescript
// 当前
const runner = new ClaudeRunner(config.cliCommand, ...);

// 优化后：注入 projectRoot 用于 --add-dir
const addDirFlag = `--add-dir ${path.join(projectRoot, '.claude-orchestrator')}`;
const fullCommand = `${config.cliCommand} ${addDirFlag}`;
const runner = new ClaudeRunner(fullCommand, ...);
```

类似地，skill 目录也用 `--add-dir` 指向 `{projectRoot}/.claude/skills`。

---

### 约束: `.gitignore` 不得忽略 `.claude-orchestrator/`

**问题**：当前 `.gitignore` 包含 `.claude-orchestrator/` 全局忽略规则。Worker 在 `.claude-orchestrator/docs/{name}/YYYY-MM-DD/` 下生成的工作产物（chain-def.json、blueprint.md、traceability-map.md、verification-map.md、review-judgment.md、acceptance-report.md 等）会被 `git add -A` 跳过，`CommitChecker` 无法提交。

**要求**：`.gitignore` 移除 `.claude-orchestrator/` 全局忽略，改为仅忽略运行时临时子目录：

```diff
- .claude-orchestrator/
+ .claude-orchestrator/sessions/
+ .claude-orchestrator/worktree/
```

| 路径 | 是否忽略 | 原因 |
|------|----------|------|
| `.claude-orchestrator/config.json` | 不忽略 | 项目级配置，需要版本控制 |
| `.claude-orchestrator/docs/` | 不忽略 | Worker 工作产物，需要 commit |
| `.claude-orchestrator/sessions/` | 忽略 | Leader 运行时日志，临时数据 |
| `.claude-orchestrator/worktree/` | 忽略 | git worktree 各自独立仓库，主仓库不应跟踪 |

注意：git worktree 共享主仓库的 `.gitignore`，因此主仓库的一次修改对所有 worktree 生效。

---

### 方案 B: `--append-system-prompt` — 身份注入分离

**目标**：将 Business Card（身份信息）从 `-p` 的用户 prompt 移到 system prompt。

**原理**：`claude --append-system-prompt '<text>'` 将文本追加到 Claude Code 的 system prompt。身份信息（name, role, instance_id 等）属于 system 层，不应混在 user prompt 里。

**当前 prompt 结构**（`template.ts:52-66`）：
```
## Worker Identity
You are **Tom**, a **planner** ...
---
[模板内容 with {{var}} 替换]
```

**优化后结构**：
```
--append-system-prompt:
  ## Worker Identity
  You are **Tom**, a **planner** ...
  - Name: Tom
  - Role: planner
  - Worktree: /path/to/worktree
  - Branch: claude-orchestrator/Tom-workspace
  - Instance: abc123

-p:
  [模板内容 with {{var}} 替换]
```

**涉及改动**：

| 文件 | 改动点 |
|------|--------|
| `src/executor/template.ts:5-16` | 删除 `BUSINESS_CARD` 常量 |
| `src/executor/template.ts:52-66` | `render()` 不再拼接 business card，只做 `{{var}}` 替换 |
| `src/executor/runner.ts:11-18` | `ClaudeRunner` 构造函数新增 `systemPrompt` 参数 |
| `src/executor/runner.ts:59-68` | `run()` 方法构建 system prompt flag 并传入 `execWithStreaming` |
| `src/utils/exec.ts` | `execWithStreaming` 支持 `--append-system-prompt` 参数 |
| `src/worker/watcher.ts:78-93` | 渲染后分离 business card vars 和 task vars |
| `src/leader/chain-router.ts:74-88` | 同上 |

**`ClaudeRunner` 新接口**：

```typescript
export class ClaudeRunner {
  constructor(
    private command: string,
    private cacheDir: string,
    private leaderInstanceId: string,
    private workDir: string,
    private quiet = false,
  ) {}

  // 新增：构建身份 system prompt
  buildIdentityPrompt(vars: {
    name: string;
    role: string;
    worktree_path: string;
    worktree_branch: string;
    instance_id: string;
  }): string {
    return `## Worker Identity
You are **${vars.name}**, a **${vars.role}** in the multi-agent orchestration system.
- Name: ${vars.name}
- Role: ${vars.role}
- Worktree: ${vars.worktree_path}
- Branch: ${vars.worktree_branch}
- Instance: ${vars.instance_id}`;
  }

  async run(
    prompt: string,
    logPath: string,
    opts?: {
      systemPrompt?: string;
      onStreamChunk?: (line: string) => void;
      resumeSessionId?: string;
    },
  ): Promise<{ code: number; sessionId?: string }> {
    // 始终调用 execWithStreaming
  }
}
```

---

### 方案 C: 合并优化 — 模板职责简化

**目标**：综合 A + B 后，`TemplateEngine` 职责大幅简化，甚至可以被移除。

**当前 `TemplateEngine` 的三项职责**：

1. **加载模板文件** (`loadAll()`): 从磁盘读取 `worker-{link}.md`
2. **渲染变量** (`render()`): 替换 `{{key}}` → value
3. **注入身份卡**: 拼接 `BUSINESS_CARD`

**优化后**：

1. ~~加载模板文件~~ → 委托给 Claude Code。模板通过 `--add-dir .claude-orchestrator` 可被 Claude 访问
2. **渲染变量** → 保留但简化，仅用于生成 `-p` 内容
3. ~~注入身份卡~~ → 委托给 `--append-system-prompt`

**进一步简化**：由于 team CLAUDE.md 和 personal CLAUDE.md 已在 worktree 中（方案 A 保留），它们会被 Claude Code 自动加载为 system prompt 的一部分。模板中的角色特定指令可以逐步从模板文件迁移到 CLAUDE.md，最终模板文件只保留最简的"请完成以下任务"骨架。

这样 `TemplateEngine` 可以从 ~70 行简化为 ~20 行（只做基本的 `{{var}}` 替换）。

---

## 实施步骤

### Phase 0: 统一执行入口 + 强制 flag (前置)

1. **合并 `exec.ts` 为一个函数**：删除 `execWithTee` 和 `execAndCapture`，`execWithStreaming` 作为唯一入口
2. **强制追加 flag**：在 `execWithStreaming` 中强制追加 `--output-format stream-json --verbose`
3. **修改 `runner.ts`**：`ClaudeRunner.run()` 始终调用 `execWithStreaming`，`onChunk` 改为可选参数
4. **修改 `config.ts`**：从默认 `cliCommand` 中移除 `--output-format stream-json`

### Phase 1: `--add-dir` (低风险，纯增量)

1. **修改默认 `cliCommand`** (`src/config.ts:62-63`)
   ```typescript
   function defaultCliCommand(): string {
     return "claude --dangerously-skip-permissions --permission-mode dontAsk";
   }
   // --add-dir 通过 ChildConfig 按需注入，不放在全局默认中
   ```

2. **修改 `.gitignore`**：移除 `.claude-orchestrator/` 全局忽略，改为仅忽略 `sessions/` 和 `worktree/` 子目录

3. **修改 worktree 初始化** (`src/worker/worktree-initializer.ts`)
   - 删除 `ensureWorktreeEnvironment` 中 agent 模板拷贝 (`lines 139-151`)
   - 删除 skill 拷贝 (`lines 153-183`)
   - 保留 team CLAUDE.md 拷贝 (`lines 185-190`)
   - 保留 personal CLAUDE.md 生成 (`lines 192-208`)

4. **修改 `agentsDir` 指向** (`src/worker/child-runner.ts:67`)
   ```typescript
   // 当前
   const agentsDir = path.join(config.worktreePath, ".claude-orchestrator", "agents");
   // 优化后：指向项目根的共享目录
   const agentsDir = path.join(projectRoot, ".claude-orchestrator", "agents");
   ```

5. **确认 Leader 同样受益**
   - Leader 的 cwd 是 projectRoot，`--add-dir .claude-orchestrator` 直接生效
   - Leader 的 `TemplateEngine` 同样从共享目录加载模板

### Phase 2: `--append-system-prompt` (中风险，需改模板渲染链路)

1. **扩展 `execWithStreaming`** (`src/utils/exec.ts`)
   - 添加 `systemPrompt?: string` 参数
   - 在 shell 命令中插入 `--append-system-prompt '${escapedSystemPrompt}'`

2. **扩展 `ClaudeRunner`** (`src/executor/runner.ts`)
   - `run()` 方法新增 `systemPrompt?: string` 参数
   - 新增 `buildIdentityPrompt(vars)` 辅助方法

3. **简化 `TemplateEngine.render()`** (`src/executor/template.ts`)
   - 删除 `BUSINESS_CARD` 常量和拼接逻辑 (`lines 5-16, 58-63`)
   - `render()` 只做 `{{var}}` 替换

4. **更新调用方**
   - `src/worker/watcher.ts:78-93`: 分离 identity vars 和 task vars，分别传入
   - `src/leader/chain-router.ts:74-88`: 同上

### Phase 3: 清理 (低风险)

1. 考虑是否仍需要 `TemplateEngine` 作为一个独立类
2. 考虑将模板中的角色指令逐步迁移到 CLAUDE.md
3. 清理 worktree 中不再需要的 `.claude-orchestrator/agents/` 目录

---

## 兼容性

- 所有改动向后兼容：新 flag 通过 `cliCommand` 配置注入，用户可通过 `config.json` 的 `commands.claude-cli` 覆盖回旧行为
- `--add-dir` 是纯增量 flag，不影响现有 prompt 执行
- `--append-system-prompt` 仅改变 prompt 的组织方式，不改变内容
- worktree 初始化简化不影响已存在的 worktree

## 收益总结

| 指标 | 当前 | 优化后 |
|------|------|--------|
| Worktree 初始化的文件拷贝数 | 48 (3 workers × 16 files) | 6 (3 workers × 2 CLAUDE.md) |
| 模板加载方式 | Node.js 读文件 + 字符串替换 | 直接传 `-p`（模板引用由 Claude Code 处理） |
| 身份注入方式 | 拼入用户 prompt (`-p`) | System prompt (`--append-system-prompt`) |
| System/User prompt 分离 | 不分离，全部在 `-p` | 分离，支持 system prompt 缓存 |
| 模板更新生效 | 需重建 worktree | 立即生效（共享目录） |
| `TemplateEngine` 代码量 | ~70 行 | ~20 行 |
