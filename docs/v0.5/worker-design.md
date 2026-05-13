# Worker 工作流程与子系统设计

## 1. Worker 定位与子进程模型

Worker 是责任链的执行者，被动接收 Leader 分配的任务并完成。其核心工作是：**接收任务 → 按该环节的标准流程执行 → 产出可验证的结果 → 自评估 → 向 Leader 报告。**

```
┌───────────────────────────────────────────────────────────────────┐
│                            Worker                                  │
│                                                                   │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐      │
│   │ 接收任务  │──▶│ 理解任务  │──▶│ 执行任务  │──▶│ 自评估+   │      │
│   │ Leader   │   │ 读取任务  │   │ 按标准    │   │ 自动提交+ │      │
│   │ 分配     │   │ 文档+上下文│   │ 流程执行  │   │ 报告结果  │      │
│   └──────────┘   └──────────┘   └──────────┘   └──────────┘      │
│                                                                   │
│   当前角色由分配任务的 link 决定:                                    │
│   Plan → Planner    Build → Builder                               │
│   Verify → Verifier  Review → Reviewer                            │
│   Accept → Accepter                                               │
└───────────────────────────────────────────────────────────────────┘
```

Worker 在 4 个时机调用 claude-cli：

1. **任务执行**：根据 message 的 `link` 字段选择模板 → 渲染 → 执行
2. **commit message 生成**：任务后 `CommitChecker.check()` 调用 claude-cli 生成简洁的 commit 消息
3. **自评估**：任务后 `SelfEvaluator.evaluate()` 调用 claude-cli 输出 EvalDecision JSON
4. **任务拆解**：收到 `link=decompose` 的消息时执行 `worker-decompose.md` 拆解需求（仅 Planner 经常承担）

后三个步骤通过 `--resume <mainSessionId>` 共享主任务的对话上下文，避免冷启动；Evaluator 重试时叠加 `--fork-session` 创建干净分支消除锚定效应。详见 [`execution-runtime.md`](execution-runtime.md) §3。

### 1.1 子进程架构

Worker 在独立子进程中运行，由 `run` 主进程通过 `child_process.fork()` 启动。

| 需求 | child_process | worker_threads |
|------|--------------|----------------|
| 独立的 `process.cwd()` | 天然支持 | 共享 cwd |
| 独立的 git 操作 | 天然支持 | 需手动切换目录 |
| 独立的 ZK 连接 | 天然支持 | 支持但不隔离 |
| 独立的内存空间 | 是 | 共享堆 |
| 进程崩溃隔离 | 完全隔离 | 可能影响主进程 |

**结论**：`fork()` 是更合适的选择，每个 Worker 子进程独立 chdir 到自己的 worktree，与主进程完全隔离。

### 1.2 子进程入口

[src/worker/child.ts](../../src/worker/child.ts)：

```typescript
#!/usr/bin/env node
import { startWorkerChild } from "./child-runner.js";

const config = JSON.parse(process.argv[2]);
startWorkerChild(config).catch((err) => {
  console.error("Worker child fatal error:", err);
  process.exit(1);
});
```

主进程 `fork()` 时通过 `argv[2]` 传递 JSON 序列化的 `ChildConfig`，子进程接收后立即启动。

### 1.3 子进程核心装配

[src/worker/child-runner.ts](../../src/worker/child-runner.ts)：

```typescript
export interface ChildConfig {
  worktreePath: string;      // 绝对路径，子进程将 chdir 到此
  name: string;              // "Tom"
  role: string;              // "planner"
  instanceId: string;        // 预生成 UUID
  branch: string;            // "claude-orchestrator/Tom-workspace"
  zkHosts: string;
  debug: boolean;
  cliCommand: string;        // "claude --dangerously-skip-permissions ..."
  cacheDir: string;
}

export async function startWorkerChild(config: ChildConfig): Promise<void> {
  // 1. chdir 切换工作目录
  process.chdir(config.worktreePath);

  // 2. ZK 连接
  const zk = new ZkClient(config.zkHosts);
  await zk.connect();

  // 3. 注册 Instance（EPHEMERAL），携带 worktree 信息
  const registry = new InstanceRegistry(zk);
  const instance = await registry.register(
    config.name, config.role, config.instanceId,
    { worktreePath: config.worktreePath, worktreeBranch: config.branch, pid: process.pid },
  );

  // 4. 解析 Leader instance ID（用于 cache_dir 路径 + 完成报告目标）
  const leaderInstanceId = await resolveLeaderInstanceId(zk);

  // 5. 加载 TemplateEngine
  const agentsDir = path.join(config.worktreePath, ".claude-orchestrator", "agents");
  const templateEngine = new TemplateEngine(agentsDir);
  await templateEngine.loadAll();

  // 6. ClaudeRunner（含身份注入）
  const runner = new ClaudeRunner(
    config.cliCommand, config.cacheDir, leaderInstanceId, config.worktreePath,
    { name: config.name, role: config.role,
      worktreePath: config.worktreePath, worktreeBranch: config.branch,
      instanceId: config.instanceId },
  );

  // 7. 装配子模块
  const evaluator = new SelfEvaluator(templateEngine, runner, config.name, config.role);
  const commitChecker = new CommitChecker(config.worktreePath, runner);
  const hooks = new HookEngine();

  // 8. WorkerWatcher
  const watcher = new WorkerWatcher(
    zk, instance.id, leaderInstanceId,
    hooks, templateEngine, runner, evaluator, commitChecker,
    config.worktreePath, config.branch,
  );

  // 9. 父进程存活检测（每秒一次）
  const parentCheck = startParentAliveCheck(watcher, zk);

  // 10. 启动监听循环
  await watcher.start();

  // 11. 等待 SIGINT
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(parentCheck);
      watcher.stop();
      resolve();
    });
  });

  // 12. 清理
  await registry.unregister(instance.id);
  await zk.disconnect();
}
```

### 1.4 父进程存活检测

```typescript
function startParentAliveCheck(watcher: WorkerWatcher, zk: ZkClient) {
  const parentPid = process.ppid;
  return setInterval(() => {
    try {
      process.kill(parentPid, 0);  // 信号 0 只检查进程是否存在
    } catch {
      watcher.stop();
      zk.disconnect();
      process.exit(0);
    }
  }, 1000);
}
```

防止主进程被 `kill -9` 后产生孤儿 Worker。

## 2. 事件循环

```
                    ┌──────────────┐
                    │  ZK 事件触发  │
                    └──────┬───────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
    ┌───────────┐  ┌───────────┐  ┌───────────┐
    │ Leader    │  │ 消息到达   │  │ SIGINT    │
    │ 分配任务   │  │ (其他Worker│  │           │
    │           │  │  求助等)   │  │           │
    └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
          │              │              │
          └──────────────┼──────────────┘
                         │
                         ▼
              WorkerWatcher.processMessage()
                         │
                         ▼
              ┌─────────────────┐
              │ 解析消息 link    │
              │ 选择对应模板    │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ TemplateEngine  │
              │ .render()       │
              │ + identity      │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ ClaudeRunner    │
              │ .run(prompt,    │
              │  {systemPrompt})│
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ CommitChecker   │
              │ .check()        │
              │ (--resume)      │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ SelfEvaluator   │
              │ .evaluate()     │
              │ (--resume +     │
              │  --fork-session)│
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ 发送完成报告     │
              │ → Leader         │
              └─────────────────┘
```

[src/worker/watcher.ts](../../src/worker/watcher.ts) 持续 watch `/messages/{instance_id}`，每条新消息触发 `processMessage()`。

## 3. 任务执行管线

Worker 处理一条消息分 8 步：

### Step 1 — 解析消息

```typescript
const msg = MessageSchema.parse(await zk.getMessage(instanceId, msgId));
if (msg.read || this.inFlight.has(msgId)) return;
this.inFlight.add(msgId);

const link = msg.link || "_generic";
```

`link` 为空时使用 `_generic`，对应"无模板的直接 Claude 调用"路径。

### Step 2 — 选择模板

```typescript
const template = this.templateEngine.get(`worker-${link}.md`);
```

合法 link 与模板对应见 [§4](#4-五个-link-模板)。

### Step 3 — Hook: worker_message_start

```typescript
await this.hooks.fire("worker_message_start", {
  CO_EVENT: "worker_message_start",
  CO_WORKER_NAME: this.instance.name,
  CO_WORKER_ROLE: this.instance.role,
  CO_TASK_ID: msg.task_id ?? "",
  CO_MESSAGE_ID: msgId,
  CO_LINK: link,
});
```

### Step 4 — 渲染模板

```typescript
const uniqueKey = `task-${msg.task_id || msgId}-${Date.now().toString(36)}`;
const logPath = path.join(cacheDir, leaderInstanceId, `${uniqueKey}.log`);
const resultPath = path.join(cacheDir, leaderInstanceId, `${uniqueKey}-result.md`);

const vars = {
  task_title: msg.task_title ?? "",
  task_description: msg.task_description ?? msg.content,
  task_criteria: msg.task_criteria ?? "",
  task_doc_path: msg.task_doc_path ?? "",
  result_path: resultPath,
  work_dir: this.worktreePath,
  time: new Date().toISOString(),
  content: msg.content,
};

const prompt = this.templateEngine.render(template, vars);
```

身份字段（name / role / worktree_path / instance_id 等）**不通过模板变量传递**，由 `ClaudeRunner.buildIdentityPrompt()` 单独生成 system prompt，避免在 user prompt 中重复。

### Step 5 — 主任务执行

```typescript
const { code, sessionId } = await this.runner.run(prompt, logPath, {
  systemPrompt: this.runner.buildIdentityPrompt(),
});
```

`sessionId` 来自 claude-cli stream-json 输出的第一行 `system/init` 事件，后续步骤通过 `--resume <sessionId>` 共享对话上下文。

### Step 6 — 自动提交

```typescript
let commitResult: CommitResult | null = null;
if (link !== "_generic") {
  commitResult = await this.commitChecker.check(
    { link, taskTitle: msg.task_title ?? "", taskDescription: msg.task_description ?? "" },
    sessionId,
  );
}
```

详见 [§6](#6-commitchecker-自动提交)。

### Step 7 — 自评估

```typescript
const reportContent = await this.evaluator.evaluate(
  link, vars, resultPath, uniqueKey, sessionId,
);
```

`reportContent` 为 EvalDecision JSON 字符串。详见 [§5](#5-selfevaluator-自评估)。

### Step 8 — 发送完成报告 + 标记已读

```typescript
await this.hooks.fire("worker_message_end", { ... });

await this.sendCompletionReport(link, msg, resultPath, uniqueKey, commitResult, reportContent);

await this.zk.markMessageRead(this.instance.id, msgId);
this.inFlight.delete(msgId);
```

完成报告通过 `send-message` 等价的 ZK 操作发送给 Leader：

```json
{
  "type": "direct",
  "from_instance": "Tom_instance_id",
  "from_name": "Tom",
  "from_role": "planner",
  "to_instance": "leader_instance_id",
  "link": "plan",
  "task_id": "task-0000000001",
  "task_title": "...",
  "content": "<EvalDecision JSON, 含 commit 字段>",
  "result_path": "task-001-...-result.md"
}
```

## 4. 五个 link 模板

`templates/agents/` 提供 5 个 Worker per-link 模板，每个内置该 link 的标准执行流程并引用对应 Skill。

| 模板文件 | link | Skill 引用 | 核心关注点 |
|---------|------|----------|-----------|
| `worker-plan.md` | `plan` | `task-planning` + `task-traceability` + `task-acceptance` | 追溯需求 → 设计蓝图 → 映射任务 → 自检完整性 → 记录蓝图 |
| `worker-build.md` | `build` | `task-execution` + `task-traceability` | 追溯蓝图 → 逐项实现 → 映射实现 → 举证测试 → 记录 commit |
| `worker-verify.md` | `verify` | `task-verification` + `task-traceability` | 追溯蓝图+产出 → 逐项验证 → 映射验证 → 举证结果 → 记录报告 |
| `worker-review.md` | `review` | `task-review` + `task-traceability` | 追溯全链 → 逐项判定 → 映射判定 → 举证理据 → 记录审查 → 签发 Pass/Revise |
| `worker-accept.md` | `accept` | `task-acceptance` + `task-traceability` | 追溯全链产出 → 逐项核实验收标准 → 映射交付 → 举证核实 → 签署 Go/No-Go |

### 4.1 模板结构

每个 worker-{link}.md 遵循统一结构：

1. **角色声明**（1 行）— 说明当前链环节
2. **Step 0: Directory Memory**（3-4 行）— 指引读取 `CLAUDE.md` 三层 memory
3. **Task**（变量块）— `task_title` / `task_description` / `task_criteria` / `task_doc_path`
4. **Process**（2-5 行）— 引用对应 Skill 文件 + 关键输出路径
5. **Outputs**（2-3 行）— `result_path` 双写路径
6. **Completion Report**（格式块）— 完成报告模板

身份卡片（Business Card）由 `ClaudeRunner.buildIdentityPrompt()` 生成并通过 `--append-system-prompt` 注入到 system prompt 层，**模板不重复**身份信息。

### 4.2 模板变量

| 变量 | 来源 | 说明 |
|------|------|------|
| `{{task_title}}` | message.task_title | 任务简短标题 |
| `{{task_description}}` | message.task_description | 任务详细描述 |
| `{{task_criteria}}` | message.task_criteria | 任务完成标准 |
| `{{task_doc_path}}` | message.task_doc_path | 任务文档路径（`cache_dir/{leader_id}/tasks/`） |
| `{{result_path}}` | 系统生成 | Worker 结果产出路径 |
| `{{work_dir}}` | worktree 绝对路径 | Worker 当前工作目录（即 worktree）|
| `{{time}}` | `new Date().toISOString()` | 当前时间戳 |
| `{{content}}` | message.content | 消息原始内容 |

### 4.3 task-traceability 基础层

所有 link 的执行都建立在 `skills/task-traceability/SKILL.md` 之上，定义五步法：

```
1. 追溯 (Trace)       — 读取上游产出，提取所有要求项
2. 执行 (Execute)     — 按追溯到的要求逐项执行
3. 映射 (Map)         — 将执行结果与上游要求建立映射，记录偏离和遗漏
4. 举证 (Evidence)    — 提供执行证据，让下游或审计者可验证
5. 记录 (Record)      — 持久化追溯记录到 result_path，让下游可接续
```

### 4.4 task-acceptance 流程（Plan 与 Accept 专用）

`skills/task-acceptance/SKILL.md` 用于需要产出定义性文档的环节：

- **Plan 专用**：追溯需求 → 设计蓝图 → 自检（蓝图清晰度、可执行性、边界覆盖、可验证性） → 举证 → 记录
- **Accept 专用**：追溯全链 → 逐项核实验收标准 → 映射交付 → 独立举证（grep / git log / 运行测试） → 签署 Go/No-Go（零问题才能签 Go，不做"条件通过"）

### 4.5 跨环节协助

Worker 的预设 role 与当前任务的 link 可能不同。每个模板独立包含该 link 的完整执行流程，Worker 不需要依赖预设 role 的知识——模板本身告诉它在这个环节应该做什么。

```
示例：
  Lucy 注册 role=verifier（预设 Verifier）
  Build 环节积压，Leader 分配给她一个 Build 任务

  Watcher 检测到 message.link = "build"
  → 选择 worker-build.md 模板
  → 模板内置 task-traceability 流程 + Builder 职责指引
  → Lucy 以 Builder 身份执行，无需额外配置
  → TUI TEAM 面板 Current Role 列显示 "Builder ◀←"
```

## 5. SelfEvaluator 自评估

[src/worker/evaluator.ts](../../src/worker/evaluator.ts) 在主任务执行完成后立即运行：

```typescript
class SelfEvaluator {
  async evaluate(
    link: string,
    vars: Record<string, string>,
    resultPath: string,
    uniqueKey: string,
    mainSessionId: string | undefined,
  ): Promise<string> {
    const template = this.templateEngine.get("worker-evaluate.md");
    const prompt = this.templateEngine.render(template, {
      link, ...vars, result_path: resultPath,
    });
    const evalLogPath = path.join(cacheDir, leaderInstanceId, `${uniqueKey}-eval.log`);

    for (let attempt = 0; attempt < 3; attempt++) {
      const { code } = await this.runner.run(prompt, evalLogPath, {
        systemPrompt: this.runner.buildIdentityPrompt(),
        resumeSessionId: mainSessionId,
        forkSession: true,   // 每次重试 fork 干净分支，消除锚定效应
      });

      const output = await fs.promises.readFile(evalLogPath, "utf-8");
      const decision = extractJson(output);
      if (decision) return JSON.stringify(decision);

      // 格式错误 → 加 format-hint 再 fork-session 重试
      prompt = appendFormatHint(prompt, this.templateEngine.get("worker-evaluate-format-hint.md"));
    }

    // 3 次仍失败 → 默认 feedback 决策
    return JSON.stringify({
      decision: "feedback",
      reason: "Self-evaluation failed after 3 attempts",
      nextLink: null,
      feedback_to_worker: "Output format error; please re-attempt.",
    });
  }
}
```

### EvalDecision JSON 格式

```json
{
  "decision": "activate_next" | "feedback" | "reject" | "close_chain",
  "reason": "<one-line explanation>",
  "nextLink": "build" | "verify" | "review" | "accept" | null,
  "feedback_to_worker": "<only if decision is feedback or reject>"
}
```

| decision | Leader 处理 |
|----------|------------|
| `activate_next` | 激活 `nextLink` 对应任务，发送任务消息 |
| `feedback` | 回退给原 Worker（同链同 link）补充修正 |
| `reject` | 标记任务 failed，需重新拆解 |
| `close_chain` | accept 通过，链关闭 |

### `--fork-session` 的作用

Evaluator 重试时如果直接 `--resume` 同一个 session，每次重试的 prompt/response 会叠加在对话历史中，造成"格式错误锚定效应"。`--fork-session` 基于主任务 session 创建**全新独立 session**（保留任务上下文，无评估历史）：

```
claude --resume {mainSessionId} --fork-session -p "评估..."  # 第 1 次，fork 干净分支
claude --resume {mainSessionId} --fork-session -p "评估..."  # 第 2 次，再次 fork 干净分支
```

## 6. CommitChecker 自动提交

[src/worker/commit-checker.ts](../../src/worker/commit-checker.ts) 任务后检查 git 变更，生成 commit message 并提交：

```typescript
class CommitChecker {
  async check(
    taskContext: { link: string; taskTitle: string; taskDescription: string },
    mainSessionId: string | undefined,
  ): Promise<CommitResult | null> {
    // 1. git status --porcelain
    const statusOutput = await this.execGit("status --porcelain");
    if (!statusOutput.trim()) return null;

    // 2. 解析变更
    const { changed, untracked } = parseStatus(statusOutput);

    // 3. claude-cli 生成 commit message（--resume 继承主任务上下文）
    const prompt = this.templateEngine.render("worker-commit-message.md", {
      changed_files: changed.join("\n"),
      untracked_files: untracked.join("\n"),
      task_title: taskContext.taskTitle,
      link: taskContext.link,
    });

    const logPath = this.runner.logPath(`commit-${Date.now().toString(36)}`);
    await this.runner.run(prompt, logPath, { resumeSessionId: mainSessionId });
    const output = await fs.promises.readFile(logPath, "utf-8");
    const commitMsg = output.trim().split("\n")[0].slice(0, 72);

    // 4. git add -A && git commit
    await this.execGit("add -A");
    await this.execGit(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);

    // 5. 获取 commit SHA
    const sha = (await this.execGit("rev-parse HEAD")).trim();

    return { sha, message: commitMsg, changedFiles: changed, untrackedFiles: untracked };
  }
}
```

### 6.1 错误处理

| 场景 | 处理 |
|------|------|
| git status 失败 | 返回 null，不阻塞任务流程 |
| 无变更 | 返回 null（任务可能仅产出文档到 cache_dir）|
| claude-cli 生成失败 | 使用 fallback `"chore: auto-commit from {name}"` |
| git add 或 commit 失败 | 记录错误，返回 null |

### 6.2 完成报告中的 commit 段

`CommitResult` 嵌入完成报告 JSON：

```json
{
  "decision": "activate_next",
  "reason": "...",
  "nextLink": "verify",
  "commit": {
    "sha": "a1b2c3d",
    "message": "Implement user authentication",
    "branch": "claude-orchestrator/Jerry-workspace",
    "changed_files": ["src/auth/login.ts"],
    "untracked_files": []
  }
}
```

Leader `ChainRouter` 解析后调用 `MergeValidator.validate()` 决策 merge / skip / review_first。详见 [`leader-design.md`](leader-design.md) §6。

## 7. 完成报告协议

### 7.1 Worker → Leader（完成报告）

Worker 通过 `zk.sendMessage()` 直接写入 `/messages/{leader_id}/msg-{seq}`：

```typescript
await zk.sendMessage(
  this.instance.id, this.instance.name,
  reportContent,  // EvalDecision JSON 字符串（含 commit 段）
  this.leaderInstanceId,
  {
    link, task_id: msg.task_id, task_title: msg.task_title,
    result_path: resultPath,
  },
);
```

### 7.2 Leader → Worker（任务分配）

Leader 通过 `ChainRouter` 在 `activate_next` 决策后发送任务消息：

```json
{
  "type": "direct",
  "from_name": "Tom" (Leader),
  "to_instance": "Jerry_instance_id",
  "to_name": "Jerry",
  "link": "build",
  "task_id": "task-0000000002",
  "task_title": "实现用户认证模块",
  "task_description": "...",
  "task_criteria": "...",
  "task_doc_path": "./tasks/task-0000000002.md",
  "content": "Jerry, 请实现用户认证模块。任务文档: ./tasks/task-0000000002.md"
}
```

Worker `WorkerWatcher` 根据 `link` 字段选择对应模板。

### 7.3 Worker → Worker（协助请求）

Worker 可向其他 Worker 发送求助消息（非任务分配，不走模板）：

```json
{
  "type": "help",
  "from_name": "Jerry" (Builder),
  "to_name": "Lucy" (Verifier),
  "content": "我正在实现认证模块，有个关于测试策略的问题想请教..."
}
```

接收方 Worker `processMessage()` 中 `link=help` 走 `_generic` 模板分支或回退到直接 claude-cli。

## 8. 日志与缓存

### 8.1 日志结构

Worker 每次执行产生多类文件：

```
<cache_dir>/{leader_instance_id}/
├── task-{task_id}-{ts}.log           ← 主任务 claude-cli 执行日志（tee 双写）
├── task-{task_id}-{ts}-result.md     ← Worker 按 link 标准流程产出的结果
├── task-{task_id}-{ts}-eval.log      ← 自评估日志
└── task-{task_id}-{ts}-commit.log    ← 生成 commit message 日志
```

- `.log` 文件：`execWithStreaming` 内置 tee 双写，记录完整 stream-json 流
- `-result.md`：Worker 的最终产出，按 link 类型产出不同内容：
  - Planner → 蓝图文档 + 自检清单
  - Builder → 追溯映射表 + 实现证据
  - Verifier → 验证映射表 + 验证证据
  - Reviewer → 审查判定表 + 判定理据
  - Accepter → 验收报告 + Go/No-Go 决策

### 8.2 uniqueKey 生成

```
uniqueKey = task-{task_id}-{base36_timestamp}

示例:
  task-task-0000000001-lp8k2x
  task-msg-0000000042-m3n7ya
```

`base36_timestamp = Date.now().toString(36)`。

### 8.3 读取上游产出

Worker 在执行前需要读取上游环节的产出。任务文档 `task_doc_path` 由 Leader 的 ChainRouter 生成，其中嵌入上游任务的 `result_path`：

```markdown
## Upstream Outputs

### Plan (task-0000000001)
- Result: ./task-0000000001-result.md

### Build (task-0000000002)
- Result: ./task-0000000002-result.md
- Commit: a1b2c3d
```

Worker 通过模板的 `{{task_doc_path}}` 变量引导 claude-cli 自行 `Read` 这些文件。

## 9. Directory Memory

Worker 启动后会读取三层 directory memory 建立上下文：

| 层 | 路径 | 维护方 | 内容 |
|---|------|--------|------|
| 团队级 | `./CLAUDE.md` | InitChecker 复制 `team-claude.md` | 团队角色表、产出目录规范、Skill 索引、Git 规则 |
| 个人级 | `./.claude-orchestrator/docs/{Name}/CLAUDE.md` | WorktreeInitializer 复制 `personal-claude-{role}.md` | 角色规范、当前 link 的工作要点 |
| 每日级 | `./.claude-orchestrator/docs/{Name}/{YYYY-MM-DD}/CLAUDE.md` | Worker 自维护 | 当日会话记忆、决策摘要、待办 |

每个 worker-{link}.md 模板的 "Step 0" 都包含读取这三层 memory 的指引。详见 [`worktree-and-identity.md`](worktree-and-identity.md) §5。

## 10. 与其他文档的边界

| 关注点 | 所属文档 |
|--------|---------|
| Worker 子进程模型、事件循环、5 link 模板 | `worker-design.md`（本文档） |
| 自评估、自动提交、完成报告协议 | `worker-design.md` |
| git worktree 隔离、命名、身份注入、Directory Memory | [`worktree-and-identity.md`](worktree-and-identity.md) |
| ClaudeRunner / execWithStreaming / `--resume` / `--fork-session` | [`execution-runtime.md`](execution-runtime.md) |
| 责任链、角色即权重、认领规则 | [`role-design.md`](role-design.md) |
| Leader 启动、TUI、ChainRouter | [`leader-design.md`](leader-design.md) |
| 五阶段编排、InitChecker | [`orchestration.md`](orchestration.md) |
| ZK Schema、Message/Task 数据格式 | [`zookeeper-schema.md`](zookeeper-schema.md) |
