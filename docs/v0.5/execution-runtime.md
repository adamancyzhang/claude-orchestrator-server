# 执行运行时设计 — Runner / exec / Template / Hooks

本文档描述 Claude Orchestrator 调用 claude-cli 的统一执行层：`ClaudeRunner`、`execWithStreaming`、`TemplateEngine`、`HookEngine`、`--resume` / `--fork-session` 会话续接机制。

## 1. ClaudeRunner — 身份注入入口

[src/executor/runner.ts](../../src/executor/runner.ts) 是 Leader 与 Worker 调用 claude-cli 的统一封装。

### 1.1 构造

```typescript
export class ClaudeRunner {
  constructor(
    private command: string,              // "claude --dangerously-skip-permissions ..."
    private cacheDir: string,              // ".claude-orchestrator/sessions"
    private leaderInstanceId: string,      // 用于 cacheDir 子目录
    private workDir: string,               // chdir 目标（Worker = worktree 路径）
    private identity?: {                   // 身份信息，由 buildIdentityPrompt() 使用
      name: string;
      role: string;
      worktreePath?: string;
      worktreeBranch?: string;
      instanceId: string;
    },
    private onChunk?: (line: string) => void,  // TUI streaming callback
    private quiet?: boolean,                    // 抑制 stdout 输出
  ) {}
}
```

`identity` 仅 Worker 子进程提供完整字段；Leader 也使用 `ClaudeRunner` 但身份字段为 Leader 默认值（name="Leader", role="leader", instanceId=leaderInstanceId）。

### 1.2 buildIdentityPrompt

```typescript
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
```

返回的字符串作为 system prompt 文本，通过 `--append-system-prompt` 注入。

### 1.3 run

```typescript
async run(
  prompt: string,
  logPath: string,
  opts?: {
    systemPrompt?: string;
    resumeSessionId?: string;
    forkSession?: boolean;
  },
): Promise<{ code: number; sessionId?: string }> {
  let cmd = this.command;
  if (opts?.resumeSessionId) {
    cmd = `${cmd} --resume ${opts.resumeSessionId}`;
    if (opts?.forkSession) {
      cmd = `${cmd} --fork-session`;
    }
  }
  return execWithStreaming(
    cmd, prompt, logPath,
    opts?.systemPrompt, this.onChunk, this.workDir, this.quiet,
  );
}
```

支持四种调用模式：

| 场景 | 参数 |
|------|------|
| 主任务执行 | `run(prompt, logPath, { systemPrompt: buildIdentityPrompt() })` |
| 生成 commit message | `run(prompt, logPath, { resumeSessionId: mainSessionId })` |
| 自评估 | `run(prompt, logPath, { systemPrompt, resumeSessionId, forkSession: true })` |
| Leader decompose | `run(prompt, logPath, { systemPrompt: leaderIdentity })` |

### 1.4 logPath 辅助

```typescript
logPath(uniqueKey: string): string {
  return path.join(this.cacheDir, this.leaderInstanceId, `${uniqueKey}.log`);
}
```

调用方拼接 `uniqueKey`（如 `task-{taskId}-{ts}`、`commit-{ts}`、`eval-{ts}`），获得 cache_dir 下的绝对路径。

## 2. execWithStreaming — 唯一执行入口

[src/utils/exec.ts](../../src/utils/exec.ts) 提供唯一的执行函数。所有 claude-cli 调用最终都流经此函数。

### 2.1 签名

```typescript
export async function execWithStreaming(
  command: string,
  message: string,
  logPath: string,
  systemPrompt?: string,
  onChunk?: (line: string) => void,
  cwd?: string,
  quiet?: boolean,
): Promise<{ code: number; sessionId?: string }>;
```

### 2.2 关键设计

- 始终逐行解析 JSON stdout，提取 `session_id`
- 始终同步写日志（内置 tee 行为）
- `systemPrompt` 可选，传入时通过 `--append-system-prompt` 注入
- `onChunk` 可选，TUI streaming 时传入
- `cwd` 可选，子进程的工作目录（Worker = worktree 路径）
- `quiet` 可选，抑制 stdout passthrough（用于 commit / eval 等内部调用）

### 2.3 命令组装

```typescript
function buildCommand(
  baseCommand: string,
  prompt: string,
  systemPrompt: string | undefined,
): string {
  const escapedPrompt = escapeShell(prompt);
  const flags = "--output-format stream-json --verbose";  // 强制追加
  let cmd = `${baseCommand} ${flags} -p ${escapedPrompt}`;
  if (systemPrompt) {
    cmd = `${baseCommand} ${flags} --append-system-prompt ${escapeShell(systemPrompt)} -p ${escapedPrompt}`;
  }
  return cmd;
}

function escapeShell(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
```

`--output-format stream-json --verbose` 强制追加，使得 stdout 输出可解析的 JSON 流，每行一个事件。

### 2.4 session_id 提取

```typescript
function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    return obj.session_id || null;
  } catch {
    return null;
  }
}
```

`execWithStreaming` 逐行处理 stdout，第一行通常是 `system/init` 事件，包含 `session_id`。

### 2.5 执行流程

```
execWithStreaming(command, prompt, logPath, systemPrompt, onChunk, cwd, quiet)
  ├─ fs.mkdirSync(path.dirname(logPath), {recursive: true})
  ├─ 打开 logPath 的 append-only 写入流
  ├─ spawn("sh", ["-c", buildCommand(command, prompt, systemPrompt)], {cwd})
  │     ├─ child.stdout.on("data", (chunk) => {
  │     │     for (const line of chunk.toString().split("\n")) {
  │     │       if (!sessionId) sessionId = extractSessionId(line);
  │     │       logStream.write(line + "\n");
  │     │       onChunk?.(line);
  │     │       if (!quiet) process.stdout.write(line + "\n");
  │     │     }
  │     │   })
  │     ├─ child.stderr.on("data", ...) — 同样写入 logPath
  │     └─ child.on("exit", (code) => resolve({code, sessionId}))
  └─ return Promise<{code, sessionId}>
```

### 2.6 日志前缀

执行前打印 `[Exec]` 前缀日志（仅 `quiet=false` 时）：

```
[Exec] claude --dangerously-skip-permissions --output-format stream-json --verbose \
       --append-system-prompt '...' -p '...' | tee -a /path/to/logPath
```

## 3. `--resume` + `--fork-session` 会话续接

### 3.1 问题

Worker 执行一个 chain-link 任务时，会多次调用 `claude -p`：

```
1. claude -p "执行 plan 任务"           → 完整上下文 A
2. claude -p "自我评估刚才的输出"        → 空白上下文，看不到步骤 1
3. claude -p "生成 git commit message"  → 空白上下文，看不到步骤 1 和 2
```

如果每次都是冷启动，会导致：

- 评估质量低（看不到任务实际产出）
- commit message 无意义（看不到代码变更）
- 重试成本高（每次重新分析任务）

### 3.2 `--resume` 工作机制

```
claude -p "执行任务"                              # 创建 session_abc123
claude --resume session_abc123 -p "评估你的输出"    # 在同一个 session 中继续
claude --resume session_abc123 -p "生成 commit"    # 继续追加
```

session 内的对话历史完整保留，后续调用可看到所有前置上下文。

### 3.3 `--fork-session` 补充

Evaluator 重试时如果直接 `--resume` 同一个 session，每次重试的 prompt/response 会叠加到对话历史中，造成**锚定效应**（LLM 看到先前格式错误的输出，倾向于复制类似错误）。`--fork-session` 基于主任务 session 创建**全新独立 session**（保留任务上下文，无评估历史）：

```
claude --resume session_abc123 --fork-session -p "评估..."  # 第 1 次，fork 干净分支
claude --resume session_abc123 --fork-session -p "评估..."  # 第 2 次，再次 fork 干净分支
```

### 3.4 调用方汇总

| 调用位置 | 实现 |
|----------|------|
| `WorkerWatcher.processMessage()` 主任务 | `run(prompt, logPath, { systemPrompt })` → 返回 `sessionId` |
| `SelfEvaluator.evaluate()` 自评估 | `run(prompt, evalLogPath, { systemPrompt, resumeSessionId, forkSession: true })` |
| `CommitChecker.generateCommitMessage()` | `run(prompt, logPath, { resumeSessionId })` |
| `ChainRouter.handleRequirement()` Leader decompose | `run(prompt, logPath, { systemPrompt })` |

### 3.5 边缘情况

| 场景 | 处理 |
|------|------|
| session_id 提取失败 | `sessionId` 为 `undefined`，`--resume` 不追加，行为退化到冷启动，不阻塞任务执行 |
| 主任务 session 被删除 | 由于评估和 commit checker 秒级跟随主任务，session 被删除的概率极低，不额外处理 |
| Evaluator 输出格式错误 | 加 `worker-evaluate-format-hint.md` 后再 fork-session 重试，最多 3 次 |

### 3.6 收益

| 维度 | 优化前 | 优化后 |
|------|--------|--------|
| Evaluator 可见信息 | 仅模板变量 + result file 路径 | 完整的任务执行对话历史 |
| Commit message 语义 | `chore: auto-commit plan task` | 基于实际变更内容生成 |
| Evaluator 重试 | 每次冷启动，锚定效应 | `--fork-session` 干净分支 |
| Evaluator 模板复杂度 | 需在 prompt 中重复 task 信息 | 可精简（上下文已有） |

## 4. TemplateEngine — 模板加载与渲染

[src/executor/template.ts](../../src/executor/template.ts) 仅做三件事：

### 4.1 接口

```typescript
export class TemplateEngine {
  constructor(private agentsDir: string) {}

  async loadAll(): Promise<void>;                          // 加载 agentsDir 下所有 .md 文件
  get(filename: string): string | undefined;                // 按文件名查找模板
  render(template: string, vars: Record<string, string>): string;  // 仅做 {{var}} 替换
  loadFile(relativePath: string): Promise<string>;         // 按需加载（不缓存）
}
```

### 4.2 render

```typescript
render(template: string, vars: Record<string, string>): string {
  let body = template;
  for (const [key, value] of Object.entries(vars)) {
    body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return body;
}
```

**仅做 `{{var}}` 替换**，不拼接身份卡片，不做 Markdown 处理。总代码量约 46 行。

身份信息由 `ClaudeRunner.buildIdentityPrompt()` 单独生成，作为 system prompt 注入。

### 4.3 模板查找路径

| 调用方 | agentsDir |
|--------|-----------|
| Leader | `<project>/.claude-orchestrator/agents/` |
| Worker（子进程） | `<worktree>/.claude-orchestrator/agents/` |

InitChecker step 4（skills）和 WorktreeInitializer 都会保证每个 worktree 的 agents 目录包含完整模板。

### 4.4 12 个模板

| 模板 | 调用方 |
|------|--------|
| `worker-plan.md` / `worker-build.md` / `worker-verify.md` / `worker-review.md` / `worker-accept.md` | Worker（5 link） |
| `worker-decompose.md` | Worker（Planner 接收 decompose 消息）或 Leader（ChainRouter 自处理） |
| `worker-evaluate.md` + `worker-evaluate-format-hint.md` | SelfEvaluator |
| `worker-commit-message.md` | CommitChecker |
| `worker-merge-decision.md` | MergeValidator |
| `worker-task-doc.md` | ChainRouter（生成任务文档骨架） |
| `worker-identity.md` | — (现仅作为 `buildIdentityPrompt()` 文本参考，不通过 TemplateEngine 渲染) |

## 5. HookEngine — 生命周期 Hook

[src/hooks/engine.ts](../../src/hooks/engine.ts) 提供生命周期 hook，允许用户在关键节点执行 shell 脚本。

### 5.1 接口

```typescript
export class HookEngine {
  async fire(
    event: HookEvent,
    env: Record<string, string>,
  ): Promise<void>;
}

type HookEvent =
  | "leader_message_start"
  | "leader_message_end"
  | "worker_message_start"
  | "worker_message_end";
```

### 5.2 触发时机

| Hook | 触发位置 | 用途 |
|------|---------|------|
| `leader_message_start` | LeaderWatcher 处理消息前 | 通知 / 监控 |
| `leader_message_end` | LeaderWatcher 处理消息后 | 清理 / 通知 |
| `worker_message_start` | WorkerWatcher 处理消息前 | 通知 / 监控 |
| `worker_message_end` | WorkerWatcher 处理消息后 | 清理 / 通知 |

### 5.3 环境变量

Hook shell 命令通过环境变量接收上下文：

| 变量 | 说明 |
|------|------|
| `CO_EVENT` | Hook 事件名 |
| `CO_WORKER_NAME` | 实例名（Leader 时为 "Leader"） |
| `CO_WORKER_ROLE` | 实例角色 |
| `CO_TASK_ID` | 当前任务 ID（可能为空） |
| `CO_MESSAGE_ID` | 当前消息 ID |
| `CO_LINK` | 当前 link |
| `CO_LOG_PATH` | 当前日志路径 |
| `CO_TIMESTAMP` | 触发时间戳 |

### 5.4 配置

全局配置 `~/.claude-orchestrator/config.json`：

```json
{
  "hooks": {
    "leader_message_start": null,
    "leader_message_end": null,
    "worker_message_start": "echo $CO_WORKER_NAME starting $CO_LINK >> ~/.claude-orchestrator/hooks.log",
    "worker_message_end": null
  }
}
```

`null` 表示不执行。值为 shell 命令字符串时，由 `child_process.exec` 在前台等待完成（不阻塞任务执行的关键路径，但会延迟 hook 后的操作）。

### 5.5 错误处理

Hook 失败不影响主流程：

```typescript
try {
  await execHook(command, env);
} catch (err) {
  logger.warn(`Hook ${event} failed:`, err);
}
```

## 6. 日志与 cache_dir

### 6.1 cache_dir 结构

```
<project>/.claude-orchestrator/sessions/{leader_instance_id}/
├── tasks/
│   ├── task-0000000001.md           # decompose 生成的任务文档（worker-task-doc.md 渲染）
│   └── task-0000000002.md
├── task-0000000001-{ts}.log         # 主任务执行日志（stream-json）
├── task-0000000001-{ts}-result.md   # Worker 产出（按 link 不同内容）
├── task-0000000001-eval-{ts}.log    # 自评估日志
├── task-0000000001-commit-{ts}.log  # 生成 commit message 日志
└── msg-{msgId}-{ts}.log             # Leader 处理消息日志
```

### 6.2 路径解析

`cache_dir` 配置项的默认值为 `.claude-orchestrator/sessions`（相对路径）。运行时由 `loadConfig()` 转换为绝对路径：

```typescript
function resolveCacheDir(cacheDir: string, projectRoot: string): string {
  if (path.isAbsolute(cacheDir)) return cacheDir;
  if (cacheDir.startsWith("~/")) return path.join(os.homedir(), cacheDir.slice(2));
  return path.join(projectRoot, cacheDir);
}
```

### 6.3 共享访问

- Leader 启动时创建 `{cache_dir}/{leader_instance_id}/` 子目录
- 所有 Worker 通过 ZK 获取 `leader_instance_id`，使用相同路径前缀
- 由于 Worker `chdir` 到 worktree（仍在主仓库内），共享主仓库的文件系统，可以直接读写 cache_dir
- Leader 和 Worker 必须使用相同的 `cache_dir` 配置

### 6.4 任务文档（task_doc）

`ChainRouter` 接收 ChainDef 后，为每个非空任务生成任务文档：

```
{cache_dir}/{leader_id}/tasks/task-{seq}.md
```

任务文档使用 `worker-task-doc.md` 模板渲染，内容包含：

- 任务标题、描述、完成标准、优先级
- chain_id 与 link
- 上游产出引用（如有，例：`Plan result: ./task-0000000001-result.md`）
- 任务的预期产出格式

任务消息中 `task_doc_path` 字段使用**相对路径**（相对 `{cache_dir}/{leader_id}/`），如 `./tasks/task-0000000002.md`。Worker 读取时拼接 `cache_dir/{leader_id}/` 前缀。

### 6.5 uniqueKey 命名

uniqueKey 是日志和结果文件的命名前缀：

```
任务主执行: task-{task_id}-{base36_ts}
评估: task-{task_id}-{base36_ts}-eval
commit: task-{task_id}-{base36_ts}-commit
Leader 消息处理: msg-{msg_id}-{base36_ts}
```

`base36_ts = Date.now().toString(36)`，毫秒级时间戳的 base36 编码（约 8 字符）。

## 7. 调用链汇总

完整的 Worker 任务执行调用链：

```
WorkerWatcher.processMessage(msg)
  │
  ├─ TemplateEngine.render(worker-{link}.md, taskVars)
  │     └─ 仅 {{var}} 替换，返回 prompt 字符串
  │
  ├─ HookEngine.fire("worker_message_start", env)
  │     └─ exec hooks.worker_message_start shell 命令
  │
  ├─ ClaudeRunner.run(prompt, logPath, {systemPrompt: buildIdentityPrompt()})
  │     └─ execWithStreaming(command, prompt, logPath, systemPrompt, ...)
  │           ├─ buildCommand → shell 命令拼接
  │           ├─ spawn 子进程，逐行解析 stdout
  │           ├─ 提取 session_id
  │           └─ return {code, sessionId}
  │
  ├─ CommitChecker.check({link, taskTitle, ...}, sessionId)
  │     ├─ git status / git add -A
  │     ├─ ClaudeRunner.run(commit-prompt, logPath, {resumeSessionId: sessionId})
  │     │     └─ execWithStreaming + --resume {sessionId}
  │     ├─ git commit -m "..."
  │     └─ return {sha, message, ...}
  │
  ├─ SelfEvaluator.evaluate(link, vars, resultPath, key, sessionId)
  │     └─ ClaudeRunner.run(eval-prompt, evalLogPath, {
  │           systemPrompt: buildIdentityPrompt(),
  │           resumeSessionId: sessionId,
  │           forkSession: true,
  │         })
  │           └─ execWithStreaming + --resume {sessionId} --fork-session
  │
  ├─ HookEngine.fire("worker_message_end", env)
  │
  └─ sendCompletionReport(link, msg, resultPath, key, commitResult, reportContent)
        └─ zk.createMessage(leader_id, {...})
```

## 8. 与其他文档的边界

| 关注点 | 所属文档 |
|--------|---------|
| ClaudeRunner / execWithStreaming / TemplateEngine / Hooks | `execution-runtime.md`（本文档） |
| `--resume` / `--fork-session` 会话续接 | `execution-runtime.md` |
| 身份注入实现细节、`--append-system-prompt` 命令格式 | `execution-runtime.md` + [`worktree-and-identity.md`](worktree-and-identity.md) §3 |
| Worker 任务执行 8 步管线 | [`worker-design.md`](worker-design.md) §3 |
| Leader ChainRouter / MergeValidator 调用 Runner | [`leader-design.md`](leader-design.md) §5–§6 |
| 模板清单与变量 | [`worker-design.md`](worker-design.md) §4 + [`worktree-and-identity.md`](worktree-and-identity.md) §5 |
| cache_dir 配置 | [`commands.md`](commands.md#配置系统) |
