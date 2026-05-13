# 编排启动设计 — `run` 命令五阶段流程

## 1. 统一入口

`run` 是 Claude Orchestrator 的**唯一长期运行命令**。它在单次调用中完成：

1. 环境自检（含交互式确认或基于历史记忆自动决策）
2. Worker 名称 + 角色分配 + git worktree 初始化
3. Leader 主进程启动（TUI、5 个子系统）
4. fork N 个 Worker 子进程
5. 阻塞等待 SIGINT，触发优雅关停

```bash
claude-orchestrator run --worker <n> [-y] [-z <hosts>] [-d]
```

参数详见 [`commands.md`](commands.md#run--一键启动编排)。

源码入口：

- [src/orchestrator/run.ts](../../src/orchestrator/run.ts) — 五阶段编排
- [src/orchestrator/init-checker.ts](../../src/orchestrator/init-checker.ts) — Phase 1 交互式初始化
- [src/worker/worktree-initializer.ts](../../src/worker/worktree-initializer.ts) — Phase 2 worktree 创建
- [src/leader/index.ts](../../src/leader/index.ts) — Phase 3 Leader 启动
- [src/worker/child.ts](../../src/worker/child.ts) — Phase 4 子进程入口

## 2. 五阶段流程

```
claude-orchestrator run --worker 5
  │
  ├─ Phase 1: 环境自检（InitChecker 6 步骤）
  │     ├─ Step 1: global_config        ~/.claude-orchestrator/config.json
  │     ├─ Step 2: user_claude_md       ~/.claude/CLAUDE.md
  │     ├─ Step 3: team_claude_md       ./CLAUDE.md
  │     ├─ Step 4: skills               ./.claude/skills/{name}/SKILL.md  (×8)
  │     ├─ Step 5: worktrees            ./.claude-orchestrator/worktree/{name}/
  │     └─ Step 6: npm_install          各 worktree 内执行
  │
  ├─ Phase 2: Worker 名称 + 角色分配（WorktreeInitializer）
  │     ├─ generateWorkerAssignment(5):
  │     │   → [Tom(planner), Jerry(builder), Lucy(verifier), Thomas(reviewer), Jack(accepter)]
  │     ├─ 扫描已有 worktree + 分支 + config.json 名称（三级唯一性检查）
  │     ├─ 不足则 claude-cli 生成补充
  │     └─ 持久化到 <project>/.claude-orchestrator/config.json 的 worktree 段
  │
  ├─ Phase 3: 启动 Leader 主进程
  │     ├─ ZK 连接 + /leader EPHEMERAL 节点（声明领导权）
  │     ├─ InstanceRegistry.register(role=leader)
  │     ├─ 装配 LeaderEventBus / LeaderState / 5 个子系统
  │     ├─ Recovery.scanOrphans() — 启动孤儿扫描
  │     └─ LeaderTui.render() + onInput 回调
  │
  ├─ Phase 4: fork N 个 Worker 子进程
  │     ├─ 对每个 WorktreeConfig:
  │     │   child = fork(dist/worker/child.js, [JSON.stringify(childConfig)])
  │     ├─ 注册主进程 SIGINT/SIGTERM/exit 处理器
  │     └─ child.on("exit") 自动重启（最多 3 次）
  │
  └─ Phase 5: 阻塞等待 SIGINT
        └─ SIGINT → kill 所有子进程 → 注销 → 断开 ZK
```

## 3. Phase 1: InitChecker 环境自检

[src/orchestrator/init-checker.ts](../../src/orchestrator/init-checker.ts) 把初始化拆为 6 个独立步骤，每步有明确的操作类型、危险级别、状态持久化。

### 3.1 6 个步骤

| Step | 操作 | 目标路径 | 危险级别 | 备注 |
|------|------|---------|---------|------|
| 1. global_config | 创建/补全 | `~/.claude-orchestrator/config.json` | Caution | 仅新增缺失字段，不覆盖已有值 |
| 2. user_claude_md | 复制 | `~/.claude/CLAUDE.md` | Danger | 目标已存在且内容不同时显示 diff |
| 3. team_claude_md | 复制 | `./CLAUDE.md` | Danger | 目标已存在且内容不同时显示 diff |
| 4. skills | 逐 skill 复制 | `./.claude/skills/{name}/SKILL.md` | Danger | 已存在的 skill 单独确认 |
| 5. worktrees | 创建/复用 | `./.claude-orchestrator/worktree/{name}/` | Safe | 幂等（与 Phase 2 协同）|
| 6. npm_install | 安装依赖 | 各 worktree | Caution | 耗时操作 |

### 3.2 危险级别

```
Safe      (绿色) — 创建新文件/目录，不覆盖任何内容
Caution   (黄色) — 修改配置但保留用户数据，或耗时操作
Danger    (红色) — 覆盖/替换已有文件，不可逆
```

### 3.3 交互模式行为

每一步执行前：

1. **打印步骤标题与描述**（带颜色标记）
2. **显示操作详情**：源 → 目标，内容变更预览
3. **判断是否需要确认**：
   - Safe → 自动执行，仅打印结果
   - Caution → 打印警告，简要确认
   - Danger → **必须征求用户同意**，显示 diff

示例输出（Step 2）：

```
╭─ Step 2/6: User Global CLAUDE.md ──────────────────────────────╮
│                                                                  │
│  Copy: templates/user-global-claude.md                           │
│    → ~/.claude/CLAUDE.md                                         │
│                                                                  │
│  ⚠ DANGER: Target already exists and content differs.            │
│                                                                  │
│  --- existing                                                     │
│  +++ new                                                          │
│  @@ -1,3 +1,7 @@                                                  │
│   # CLAUDE.md                                                     │
│  +Behavioral guidelines to reduce common LLM coding mistakes...   │
│                                                                   │
│  Proceed with overwrite? [y/N/skip/diff]                          │
╰──────────────────────────────────────────────────────────────────╯
```

### 3.4 `-y` 自动模式

不显示交互提示，基于 `init_status` 历史决策自动处理：

| 历史状态 | `-y` 行为 |
|----------|----------|
| 无记录（首次） | 自动批准，记录 `action: "created"` |
| 曾批准（`created` / `updated` / `replaced`） | 自动批准 |
| 曾拒绝（`rejected`） | **仍然跳过**，尊重历史决策 |
| 曾跳过（`skipped`） | 仍然跳过 |

### 3.5 init_status 持久化

每个步骤执行后，结果写入 `~/.claude-orchestrator/config.json` 的 `init_status` 段：

```json
{
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
      "task-planning":      { "action": "replaced", "timestamp": "..." },
      "task-execution":     { "action": "created",  "timestamp": "..." },
      "task-verification":  { "action": "skipped",  "timestamp": "..." },
      "task-review":        { "action": "skipped",  "timestamp": "..." },
      "task-acceptance":    { "action": "replaced", "timestamp": "..." },
      "task-traceability":  { "action": "skipped",  "timestamp": "..." },
      "claude-orchestrator":{ "action": "created",  "timestamp": "..." },
      "claude-code-developer":{ "action": "created","timestamp": "..." }
    },
    "worktrees": {
      "Tom":    { "action": "created", "timestamp": "..." },
      "Jerry":  { "action": "reused",  "timestamp": "..." },
      "Lucy":   { "action": "created", "timestamp": "..." }
    },
    "npm_install": {
      "Tom":   { "action": "completed", "timestamp": "..." },
      "Jerry": { "action": "failed",    "timestamp": "...", "reason": "exit code 1" }
    }
  }
}
```

### 3.6 核心数据类型

```typescript
export type DangerLevel = "safe" | "caution" | "danger";
export type StepAction =
  | "created" | "updated" | "replaced"
  | "skipped" | "rejected"
  | "completed" | "failed";

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
  check: () => Promise<{ needsConfirm: boolean; details: StepDetails }>;
  execute: () => Promise<void>;
}
```

`InitChecker` 类提供 `runAll(steps)` 串行执行；每步包装在 `try/catch` 中，失败时仍持久化状态（`action: "failed"`），不中断其他步骤。

## 4. Phase 2: Worker 名称 + 角色 + worktree 初始化

`WorktreeInitializer` 完成名称与角色的分配，并创建 git worktree。详细命名算法、唯一性检查、worktree 创建流程见 [`worktree-and-identity.md`](worktree-and-identity.md)。

本阶段产物：

```typescript
interface WorktreeConfig {
  name: string;              // "Tom"
  role: string;              // "planner"
  worktreePath: string;      // 绝对路径
  relativePath: string;      // ".claude-orchestrator/worktree/Tom"
  branch: string;            // "claude-orchestrator/Tom-workspace"
  instanceId: string;        // 预生成 UUID
}
```

返回 `WorktreeConfig[]` 数组，传递给 Phase 3 和 Phase 4。

## 5. Phase 3: 启动 Leader 主进程

主进程调用 `startLeader(config, worktreeConfigs)`，详细启动时序见 [`leader-design.md`](leader-design.md) §2.1 与 [`architecture.md`](architecture.md) §2.11。要点：

```
startLeader(config, worktreeConfigs)
  ├─ ZkClient.connect() + 路径 mkdirp
  ├─ create /leader EPHEMERAL（失败 → 退出："Another leader is already running"）
  ├─ InstanceRegistry.register(role=leader)
  ├─ 确保 cache_dir/{leader_instance_id}/ 存在
  ├─ TemplateEngine.loadAll(.claude-orchestrator/agents/)
  ├─ LeaderEventBus + LeaderState（注入 worktreeConfigs 用于 TUI 展示）
  ├─ WorkerMonitor / TaskOrchestrator / LeaderWatcher / ChainRouter / MergeValidator
  ├─ Recovery.scanOrphans() 一次性孤儿扫描
  ├─ LeaderTui.render() + tui.onInput(...)
  └─ 返回 leaderHandle（用于 Phase 5 优雅关停）
```

Leader 启动后即可接收 ZK 事件并在 TUI 上展示。

## 6. Phase 4: fork N 个 Worker 子进程

主进程在 Leader 启动完成后 fork 子进程：

```typescript
async function startAllWorkers(opts: {
  zkHosts: string;
  configs: WorktreeConfig[];
  debug: boolean;
}): Promise<ChildProcess[]> {
  const resolvedConfig = loadConfig({ zookeeper: opts.zkHosts });
  const children: ChildProcess[] = [];
  const restartCount = new Map<string, number>();

  for (const cfg of opts.configs) {
    const childConfig = {
      worktreePath: cfg.worktreePath,
      name: cfg.name,
      role: cfg.role,
      instanceId: cfg.instanceId,
      branch: cfg.branch,
      zkHosts: opts.zkHosts,
      debug: opts.debug,
      cliCommand: resolvedConfig.cliCommand,
      cacheDir: resolvedConfig.cacheDir,
    };

    const child = fork(
      path.join(__dirname, "..", "worker", "child.js"),
      [JSON.stringify(childConfig)],
      { stdio: "inherit" }
    );

    // 自动重启
    child.on("exit", (code) => {
      if (code !== 0 && code !== null && !shuttingDown) {
        const retries = restartCount.get(cfg.name) ?? 0;
        if (retries < 3) {
          logger.warn(`Worker ${cfg.name} 异常退出 (code=${code}), 第 ${retries + 1} 次重启`);
          restartCount.set(cfg.name, retries + 1);
          spawnChild(cfg);
        } else {
          logger.error(`Worker ${cfg.name} 已达最大重启次数，放弃`);
        }
      }
    });

    children.push(child);
  }

  return children;
}
```

子进程在自己的 worktree 中独立运行，通过 ZK 与 Leader 通信。子进程内部时序见 [`worker-design.md`](worker-design.md) §1.3。

## 7. Phase 5: 阻塞等待与优雅关停

```typescript
async function handleShutdown(
  children: ChildProcess[],
  leaderHandle: LeaderHandle,
): Promise<void> {
  let shuttingDown = false;

  const onShutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);

    // 1. kill 所有子进程
    for (const child of children) {
      try { child.kill("SIGINT"); } catch { /* 已退出 */ }
    }

    // 2. 等待子进程退出（最多 5s）
    await waitForChildren(children, 5000);

    // 3. 关停 Leader 子系统
    await leaderHandle.shutdown();

    process.exit(0);
  };

  process.on("SIGINT", () => onShutdown("SIGINT"));
  process.on("SIGTERM", () => onShutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception:", err);
    onShutdown("SIGTERM");
  });

  // 主进程阻塞，等待信号触发上面的 onShutdown
  await new Promise(() => {});
}
```

### 7.1 关停顺序

1. 主进程收到 SIGINT/SIGTERM
2. 向所有子进程发送 SIGINT
3. 子进程 `process.on("SIGINT")` 回调：`watcher.stop()` → ZK `unregister` → `zk.disconnect()` → `process.exit(0)`
4. 主进程最多等待 5 秒 → 强制 kill 残留子进程
5. Leader 子系统关停：所有 Watcher 停止、ZK 断开 → `/leader` EPHEMERAL 自动删除
6. 主进程 exit 0

### 7.2 父进程异常崩溃

子进程通过 `startParentAliveCheck()` 每秒检测父进程存在性。父进程被 `kill -9` 后子进程会自动发现并主动退出，避免孤儿进程残留：

```typescript
function startParentAliveCheck(watcher: WorkerWatcher, zk: ZkClient) {
  const parentPid = process.ppid;
  return setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      watcher.stop();
      zk.disconnect();
      process.exit(0);
    }
  }, 1000);
}
```

## 8. 启动数据流

```
用户执行: claude-orchestrator run --worker 5
  │
  ├─ src/index.ts Commander 解析 → runOrchestrator(config)
  │
  ├─ Phase 1: ensureEnvironment(yFlag)
  │     ├─ new InitChecker({yFlag})
  │     ├─ createGlobalConfigStep / createUserClaudeMdStep / ...
  │     └─ checker.runAll(steps) — 串行执行 6 步
  │
  ├─ Phase 2: initializeWorktrees(projectRoot, 5)
  │     ├─ generateWorkerAssignment(5) → [Tom..., Jerry..., ...]
  │     ├─ 加载已有 worktreeConfig（幂等检查）
  │     ├─ git worktree add / npm install
  │     └─ saveProjectWorktreeConfig() → 持久化到 config.json
  │
  ├─ Phase 3: startLeader({zkHosts, worktreeConfigs, debug})
  │     ├─ ZK + /leader + Instance
  │     ├─ 5 子系统启动
  │     ├─ TUI 渲染（显示 worktree 信息）
  │     └─ 返回 leaderHandle
  │
  ├─ Phase 4: startAllWorkers({zkHosts, configs, debug})
  │     ├─ 对每个 WorktreeConfig:
  │     │   ├─ fork child.js 子进程
  │     │   ├─ child.on("exit") 自动重启监听
  │     │   └─ 子进程: chdir → ZK → register → watcher.start()
  │     └─ 返回 ChildProcess[]
  │
  └─ Phase 5: handleShutdown(children, leaderHandle)
        └─ 阻塞等待 SIGINT → kill 子进程 → leader.shutdown()
```

## 9. 幂等性保证

`run` 命令可重复执行而不破坏现有状态：

| 资源 | 幂等行为 |
|------|---------|
| 全局配置 | InitChecker step 1 仅补全缺失字段，已有值保留 |
| user_claude_md / team_claude_md | 已存在且内容相同 → skip；不同 → Danger 确认 |
| skills | 逐 skill 检查内容差异 |
| worktree 目录 | 已存在 → 跳过 `git worktree add`，复用 |
| git 分支 | 已存在 → 跳过 `-b`，checkout 已有分支 |
| Worker 名称 | 三级唯一性检查（已有目录 + 已有分支 + config.json）|
| instance_id | 已有则复用，保证 ZK Instance 节点稳定 |
| npm install | `init_status.npm_install` 历史决策遵循 |

```
run --worker 5  (首次)   → 创建 5 个 worktree
run --worker 5  (重复)   → 检测到 worktree 已存在，跳过创建，直接启动
run --worker 3  (缩减)   → 只启动前 3 个 (Tom, Jerry, Lucy)，其他保留磁盘不启动
run --worker 7  (扩张)   → 复用前 5 个，新建 2 个 (Lisa, Alice)
```

## 10. 错误处理矩阵

| 场景 | 位置 | 处理 |
|------|------|------|
| 全局配置缺失 | InitChecker step 1 | 自动写入默认值（Caution） |
| user_claude_md 已存在但内容不同 | InitChecker step 2 | Danger 显示 diff，等待确认或遵循 `init_status` |
| skill 已存在但内容不同 | InitChecker step 4 | Danger 逐个确认 |
| worktree 目录已存在 | WorktreeInitializer | 复用，记录 `action: "reused"` |
| branch 已存在 | WorktreeInitializer | 跳过 `-b`，checkout 已有分支 |
| Worker 名称冲突 | WorktreeInitializer | 三级唯一性检查兜底，最坏情况调用 claude-cli 生成 |
| git worktree add 失败 | WorktreeInitializer | 跳过该 Worker，记录错误日志，继续其他 Worker |
| npm install 失败 | InitChecker step 6 | 记录 `action: "failed"`，继续 Phase 3（Worker 仍可启动）|
| `/leader` 节点冲突 | startLeader | 退出："Another leader is already running" |
| ZK 注册 ID 冲突 | InstanceRegistry | 重新生成 instance ID 重试 |
| 子进程异常退出 | run.ts Phase 4 | `child.on("exit")` 自动重启，最多 3 次 |
| 主进程被 kill -9 | child-runner | 子进程检测父进程不存在，主动退出 |
| 主进程未捕获异常崩溃 | run.ts | `uncaughtException` handler kill 所有子进程 |
| SIGINT 时子进程未在 5s 内退出 | run.ts Phase 5 | 强制 SIGTERM/SIGKILL |

## 11. 与其他文档的边界

| 关注点 | 所属文档 |
|--------|---------|
| 五阶段编排、InitChecker、子进程管理 | `orchestration.md`（本文档） |
| 名称分配算法、git worktree 创建、Directory Memory | [`worktree-and-identity.md`](worktree-and-identity.md) |
| Leader 启动时序、TUI、ChainRouter | [`leader-design.md`](leader-design.md) |
| Worker 子进程模型、消息处理管线 | [`worker-design.md`](worker-design.md) |
| `run` 命令 CLI 参数详解 | [`commands.md`](commands.md#run--一键启动编排) |
| 配置文件结构 | [`commands.md`](commands.md#配置系统) |
| 孤儿任务回收、错误恢复 | [`architecture.md`](architecture.md) §5 |
