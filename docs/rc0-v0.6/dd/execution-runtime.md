# Execution Runtime — v0.6 Runner / Template / Hooks

> **文档定位**：Claude Orchestrator 调用 claude-cli 的统一执行层设计。
> 身份注入细节见 `prd/product-requirements.md` §6.2；Worker 执行管线见 `core/02-task-claim-and-execute.md`。

## 1. ClaudeRunner — 身份注入入口

Leader 与 Worker 调用 claude-cli 的统一封装。

### 1.1 构造

```typescript
class ClaudeRunner {
  constructor(
    private command: string,              // "claude --dangerously-skip-permissions ..."
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
    private onChunk?: (line: string) => void,
    private quiet?: boolean,
  ) {}
}
```

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

返回的字符串通过 `--append-system-prompt` 注入 system prompt 层。

### 1.3 run 方法 — 四种调用模式

```typescript
async run(
  prompt: string,
  logPath: string,
  opts?: {
    systemPrompt?: string;
    resumeSessionId?: string;
    forkSession?: boolean;
  },
): Promise<{ code: number; sessionId?: string }>
```

| 场景 | 参数 |
|------|------|
| 主任务执行 | `run(prompt, logPath, { systemPrompt })` |
| 生成 commit message | `run(prompt, logPath, { resumeSessionId })` |
| 自评估 | `run(prompt, logPath, { systemPrompt, resumeSessionId, forkSession: true })` |
| Leader decompose | `run(prompt, logPath, { systemPrompt })` |

## 2. execWithStreaming — 唯一执行入口

所有 claude-cli 调用最终都流经此函数。

### 2.1 签名

```typescript
async function execWithStreaming(
  command: string,
  message: string,
  logPath: string,
  systemPrompt?: string,
  onChunk?: (line: string) => void,
  cwd?: string,
  quiet?: boolean,
): Promise<{ code: number; sessionId?: string }>;
```

### 2.2 命令组装

```typescript
function buildCommand(baseCommand: string, prompt: string, systemPrompt?: string): string {
  const escapedPrompt = escapeShell(prompt);
  const flags = "--output-format stream-json --verbose";
  let cmd = `${baseCommand} ${flags} -p ${escapedPrompt}`;
  if (systemPrompt) {
    cmd = `${baseCommand} ${flags} --append-system-prompt ${escapeShell(systemPrompt)} -p ${escapedPrompt}`;
  }
  return cmd;
}
```

最终 claude-cli 看到的命令结构：

```bash
claude --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  --append-system-prompt '## Worker Identity
You are **Tom**, a **planner**...
- Name: Tom
- Role: planner
- Worktree: /path/to/worktree/Tom
- Branch: claude-orchestrator/Tom-workspace
- Instance: a1b2c3d4...' \
  -p '## Task
Title: Plan auth module
Description: ...'
```

### 2.3 执行流程

```
execWithStreaming(command, prompt, logPath, systemPrompt, onChunk, cwd, quiet)
  ├─ fs.mkdirSync(path.dirname(logPath), {recursive: true})
  ├─ 打开 logPath append-only 写入流
  ├─ spawn("sh", ["-c", buildCommand(...)], {cwd})
  │     ├─ stdout 逐行解析 → 提取 session_id → tee 写入 logPath
  │     │   → onChunk?.(line)
  │     │   → quiet? : process.stdout.write
  │     ├─ stderr 写入 logPath
  │     └─ exit → resolve({code, sessionId})
  └─ return Promise<{code, sessionId}>
```

### 2.4 session_id 提取

```typescript
function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    return obj.session_id || null;
  } catch { return null; }
}
```

提取失败时 `sessionId` 为 `undefined`，`--resume` 不追加，行为退化到冷启动。

## 3. `--resume` + `--fork-session` 会话续接

### 3.1 问题

Worker 执行一个 chain-link 任务时需要多次调用 `claude -p`：
1. `claude -p "执行任务"` → 创建 session
2. `claude -p "评估输出"` → 如果冷启动，看不到步骤 1 的上下文
3. `claude -p "生成 commit message"` → 同上

### 3.2 `--resume` 机制

```
claude -p "执行任务"                              → session_abc123
claude --resume session_abc123 -p "评估你的输出"    → 同一 session 继续
claude --resume session_abc123 -p "生成 commit"    → 继续追加
```

### 3.3 `--fork-session`

Evaluator 重试时使用，避免锚定效应（LLM 看到先前格式错误的输出后倾向于复制类似错误）：

```
claude --resume session_abc123 --fork-session -p "评估..."  # 第 1 次
claude --resume session_abc123 --fork-session -p "评估..."  # 第 2 次（干净分支）
```

### 3.4 调用方汇总

| 调用位置 | 参数 |
|----------|------|
| WorkerWatcher 主任务 | `run(prompt, logPath, { systemPrompt })` → 返回 sessionId |
| SelfEvaluator 自评估 | `run(prompt, logPath, { systemPrompt, resumeSessionId, forkSession: true })` |
| CommitChecker 生成 commit | `run(prompt, logPath, { resumeSessionId })` |
| ChainRouter Leader decompose | `run(prompt, logPath, { systemPrompt })` |

## 4. TemplateEngine — 模板加载与渲染

仅做三件事：

```typescript
class TemplateEngine {
  constructor(private agentsDir: string) {}

  async loadAll(): Promise<void>;                            // 加载 .md 文件
  get(filename: string): string | undefined;                  // 按文件名查找
  render(template: string, vars: Record<string, string>): string;  // {{var}} 替换
  loadFile(relativePath: string): Promise<string>;           // 按需加载
}
```

**仅做 `{{var}}` 替换**，不拼接身份卡片。身份信息由 `ClaudeRunner.buildIdentityPrompt()` 单独生成。

### 12 个模板

| 模板 | 调用方 |
|------|--------|
| `worker-plan.md` / `worker-build.md` / `worker-verify.md` / `worker-review.md` / `worker-accept.md` | Worker（5 link） |
| `worker-decompose.md` | Worker（Planner）或 Leader（ChainRouter 自处理） |
| `worker-evaluate.md` + `worker-evaluate-format-hint.md` | SelfEvaluator |
| `worker-commit-message.md` | CommitChecker |
| `worker-merge-decision.md` | MergeValidator |
| `worker-task-doc.md` | ChainRouter（生成任务文档） |
| `worker-identity.md` | —（文本参考） |

### 模板变量

| 变量 | 来源 | 说明 |
|------|------|------|
| `{{task_title}}` | message.task_title | 任务标题 |
| `{{task_description}}` | message.task_description | 任务描述 |
| `{{task_criteria}}` | message.task_criteria | 完成标准 |
| `{{task_doc_path}}` | message.task_doc_path | 任务文档路径 |
| `{{result_path}}` | 系统生成 | Worker 产出路径 |
| `{{work_dir}}` | worktree 路径 | Worker 工作目录 |
| `{{time}}` | `new Date().toISOString()` | 时间戳 |
| `{{content}}` | message.content | 原始内容 |

## 5. HookEngine — 生命周期 Hook

```typescript
class HookEngine {
  async fire(event: HookEvent, env: Record<string, string>): Promise<void>;
}

type HookEvent =
  | "leader_message_start" | "leader_message_end"
  | "worker_message_start" | "worker_message_end";
```

环境变量：`CO_EVENT` / `CO_WORKER_NAME` / `CO_WORKER_ROLE` / `CO_TASK_ID` / `CO_MESSAGE_ID` / `CO_LINK` / `CO_LOG_PATH` / `CO_TIMESTAMP`

Hook 失败不影响主流程（try-catch 吞错 + warn 日志），最多 5s 超时。

## 6. 日志与 cache_dir

```
{cache_dir}/{leader_instance_id}/
├── tasks/task-{seq}.md           # 任务文档
├── task-{id}-{ts}.log            # 主任务日志（stream-json）
├── task-{id}-{ts}-result.md      # Worker 产出
├── task-{id}-eval-{ts}.log       # 自评估日志
├── task-{id}-commit-{ts}.log     # commit message 日志
└── msg-{msgId}-{ts}.log          # Leader 消息处理日志
```

### uniqueKey 命名

```
任务主执行: task-{task_id}-{base36_ts}
评估:       task-{task_id}-{base36_ts}-eval
commit:     task-{task_id}-{base36_ts}-commit
Leader:     msg-{msg_id}-{base36_ts}
```

`base36_ts = Date.now().toString(36)`（毫秒级 base36 编码，约 8 字符）。

## 7. 调用链汇总

```
WorkerWatcher.processMessage(msg)
  ├─ TemplateEngine.render(worker-{link}.md, taskVars)
  ├─ HookEngine.fire("worker_message_start")
  ├─ ClaudeRunner.run(prompt, logPath, {systemPrompt})
  │     └─ execWithStreaming → spawn claude -p → {code, sessionId}
  ├─ CommitChecker.check({link, ...}, sessionId)
  │     ├─ git status --porcelain
  │     ├─ ClaudeRunner.run(commit-prompt, logPath, {resumeSessionId})
  │     ├─ git add -A && git commit
  │     └─ return {sha, message, ...} | null
  ├─ SelfEvaluator.evaluate(link, vars, resultPath, key, sessionId)
  │     └─ ClaudeRunner.run(eval-prompt, logPath, {systemPrompt, resumeSessionId, forkSession: true})
  ├─ HookEngine.fire("worker_message_end")
  └─ sendCompletionReport → zk.createMessage(leader_id, EvalDecision + commit)
```
