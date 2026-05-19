# Eval 01 — `run --worker 6` 启动场景

> **场景**：用户在已 init 的项目根目录执行 `./bin/claude-orchestrator run --worker 6`，不带任何其他 flag。
>
> **目的**：把启动行为分解为可观察的中间态与最终态，逐项核对 `CLAUDE.md` / `docs/v0.7/` 中的"预期"和 `packages/*/src/` 中的"实际"，差异处给出判定与修复方案。
>
> **本文是纸面静态推导验证**。真机运行的截图、PID、耗时等留待后续 `01-startup-worker-6-runtime.md` 回填（§7）。

---

## 1. 范围与判定基准

### 1.1 用户行为
```bash
./bin/claude-orchestrator run --worker 6
```

### 1.2 前置条件
- ZooKeeper 在 `127.0.0.1:2181` 可达。
- 项目根的 git 工作区**干净**（`git status --porcelain` 为空，否则 `ensureCleanWorkspace` 抛错）。
- 首次启动假设：`.claude-orchestrator/worktree/` 尚不存在；6 个内置 name 全部可用。

### 1.3 不覆盖
- `--magic` / `--magic-max-chains`（留待 02-magic-mode eval）。
- `/init` 与用户输入路由（留待 03-input-routing eval）。
- 决策链、合并、shutdown 路径。

### 1.4 判定基准
| 来源 | 权威性 |
|------|--------|
| `packages/*/src/`（代码） | **事实**（实际行为） |
| `docs/v0.7/dd/` + `docs/v0.7/prd/` | **设计预期**（v0.7 现行有效） |
| 根 `CLAUDE.md` | **运行手册**（漂移最严重的一份） |

差异处取**逐条判断**：以代码为准（回写文档）／以文档为准（改代码）／两边都对（仅补遗）。

---

## 2. 输入解析（命令行）

**实际**：`packages/cli/src/index.ts:16-65`

| 选项 | 默认 | 解析路径 | 备注 |
|------|------|----------|------|
| `--worker <n>` | `6` | `index.ts:20-29` | 必须为整数且 `>= 6`，否则 `throw` |
| `--magic` | `false` | `index.ts:31-35` | 本场景未传 → `magic_mode=false` |
| `--magic-max-chains <m>` | `null` | `index.ts:36-46` | 本场景未传 → `magic_max_chains=null` |
| `-z/--zookeeper <hosts>` | `process.env.ZK_HOSTS ?? "127.0.0.1:2181"` | `index.ts:56-58` | 未传走 env 或 fallback |
| `-y/--yes` | `false` | `index.ts:47` | 本场景未传 |
| `-d/--debug` | `false` | `index.ts:14` | 本场景未传 → logger level `info` |

**调用**：`runOrchestrator({ zk_hosts, worker_count: 6, debug: false, y_flag: false, magic: false, magic_max_chains: null })`（`index.ts:57-64`）。

---

## 3. 输出对照（按 5 个 Phase 拆分）

> **预期文档锚**：`docs/v0.7/dd/01-architecture.md` §6 "启动 5 阶段（FR-01）"；CLAUDE.md "Architecture > Orchestrator" 段。
> **实际代码锚**：`packages/orchestrator/src/run.ts:93-351`。

### 3.1 Phase 1 — 环境自检与 init

**实际**（`run.ts:102-122`）：

| # | 观察点 | 代码位置 | 行为 |
|---|--------|----------|------|
| 1 | 工作区干净检查 | `run.ts:104` → `:353-365` | `git status --porcelain` 非空时 `throw` |
| 2 | `InitChecker.runAll` 4 步 | `run.ts:105-111` | global config / user CLAUDE.md / team CLAUDE.md / skills |
| 3 | `loadConfig` | `run.ts:114-117` | 五层合并：CLI > env > project > global > default |
| 4 | `commitInitFiles` | `run.ts:118-121` → `:373-406` | `auto_commit_init_files=true` 时自动 `git commit -m "chore: init orchestrator workspace files"` |

**预期对照**：

| 观察点 | docs/v0.7 | CLAUDE.md | 一致？ |
|--------|-----------|-----------|--------|
| 工作区干净 | DD `01-architecture.md` §6 隐含 | 未提 | ✗（CLAUDE.md 漏） |
| InitChecker 4 步 | DD `01-architecture.md` §6 Phase 1 | 未提 | ✗（CLAUDE.md 漏） |
| 五层配置合并 | DD `01-architecture.md` §8 完整覆盖 | 仅"两层合并（global + project）" | ✗（CLAUDE.md 简化失真） |
| auto_commit_init_files | DD `01-architecture.md` §8 表格 | 未提 | ✗（CLAUDE.md 漏） |

### 3.2 Phase 2 — Worktree 初始化 + Leader ZK 临时节点

**实际**（`run.ts:123-189`）：

1. 解析 magic 配置：`magicMode=false`、`magicMaxChains=null`（`run.ts:125-134`）。
2. `initializeWorktrees({ worker_count: 6, magic_mode: false })` 返回 6 个 `WorktreeConfig`（`packages/orchestrator/src/worktree-initializer.ts:173-289`）。

   **6 个 worker 的命名与角色**（首次启动、6 个内置名都可用）：

   | # | name | role | branch | worktree_path（相对项目根）|
   |---|------|------|--------|------|
   | 1 | Tom    | planner   | `claude-orchestrator/Tom-workspace`    | `.claude-orchestrator/worktree/Tom`    |
   | 2 | Jerry  | executor  | `claude-orchestrator/Jerry-workspace`  | `.claude-orchestrator/worktree/Jerry`  |
   | 3 | Lucy   | verifier  | `claude-orchestrator/Lucy-workspace`   | `.claude-orchestrator/worktree/Lucy`   |
   | 4 | Thomas | reviewer  | `claude-orchestrator/Thomas-workspace` | `.claude-orchestrator/worktree/Thomas` |
   | 5 | Jack   | accepter  | `claude-orchestrator/Jack-workspace`   | `.claude-orchestrator/worktree/Jack`   |
   | 6 | Lisa   | executor  | `claude-orchestrator/Lisa-workspace`   | `.claude-orchestrator/worktree/Lisa`   |

   来源：`BUILTIN_NAMES`（`worktree-initializer.ts:26-31`）+ `ROLE_PRIORITY`（`:33-39`）+ 第 6 个落到 `executor`（`:60`）。

3. 每个 worktree 内 seed 的内容（`seedWorktreeAssets`，`worktree-initializer.ts:292-330`）：
   - `CLAUDE.md` ← `templates/claude-memory/team-claude.md`（worktree 根，仅首次）
   - `.claude/skills/{skill}/SKILL.md` — 10 个 skill（强制覆盖：先 `rm` 旧目录再 copy）
   - `.claude-orchestrator/agents/*.md` — 20 个模板（全量复制）。TemplateEngine 在 worker boot 时把此目录作为 `primary_dir`，回落到 `<project_root>/templates/agents/`（见 `packages/orchestrator/src/child-boot.ts:74-82`）。

   > **历史修复（D17）**：曾经此处还会额外写入 `<worktree>/.claude-orchestrator/config.json`（仅 seed、无消费者）和 `<worktree>/.claude-orchestrator/docs/{name}/CLAUDE.md`（路径与 `DocsCommitter` 期望的 `<co_root>/docs/{name}/` 错位且无消费者）。已通过提交 [TBD] 删除（详见 §6 D17）。

4. ZK connect + ensure_paths 创建 7 条路径（`zkPaths.allEnsurePaths()`，`packages/contracts/src/paths/zkPaths.ts:55-65`）：
   `/claude-orchestrator`、`/instances`、`/tasks`、`/tasks/pending`、`/tasks/claimed`、`/tasks/completed`、`/messages`。

5. `/claude-orchestrator/leader` EPHEMERAL 节点（`run.ts:153-169`）payload：
   ```json
   {
     "protocol_version": "0.7.0",
     "leader_id": "<32-char-hex>",
     "pid": <int>,
     "host": "<os.hostname()>",
     "started_at": "<ISO-8601>",
     "magic_mode": false,
     "magic_max_chains": null
   }
   ```

**预期对照**：

| 观察点 | docs/v0.7 | CLAUDE.md | 一致？ |
|--------|-----------|-----------|--------|
| 6 个 worker 命名 | DD `03-identity-and-roles.md` §1 BUILTIN_NAMES | 未列举 | ✗（CLAUDE.md 漏） |
| 6 个 worker 角色顺序 | DD `03-identity-and-roles.md` §2 `planner>executor>verifier>reviewer>accepter` + 第 6 默认 executor | "1 planner + 1 builder + 1 verifier + 1 reviewer + 1 acceptor" | ✗（CLAUDE.md：术语错 + 第 6 角色未提；详见 §6 D2/D3/D5） |
| branch 命名 | DD `03-identity-and-roles.md` §3 `claude-orchestrator/{name}-workspace` | 未提 | ✗ |
| 模板 seed 数量 | DD `03-identity-and-roles.md` §4 + `templates/agents/` 实际 20 个 | "5 + 5 + identity/decompose/evaluate/commit/merge/task-doc" | ✗（CLAUDE.md 计数错，详见 §6 D7） |
| skills seed 数量 | DD `09-audit-and-cache.md` 隐含；`skills/` 实际 10 个 | "6 + CLI ref + developer ref" | ✗（CLAUDE.md 计数错，详见 §6 D9） |
| `/leader` payload 字段 | DD `02-contracts-and-protocol.md` §11.1 完整字段 | "Leader metadata"（含糊） | ✗（CLAUDE.md 模糊，详见 §6 D13） |
| 7 条 ensure_paths | DD `01-architecture.md` §3 ZK 节点全景 | ZK 树缺 `/messages` 注释、未提 ensure 时机 | △（部分一致） |

### 3.3 Phase 3 — Leader 子系统装配

**实际**（`run.ts:171-316`）：装配完成后内存中的对象与初始态：

| 顺序 | 对象 | 代码位置 | 初始态 |
|------|------|----------|--------|
| 1 | `InstanceRegistry`（leader 注册） | `run.ts:171-178` | `/claude-orchestrator/instances/{leaderId}` EPHEMERAL；payload schema 见 `packages/coordination/src/instance-registry.ts:50-71` |
| 2 | `ensureCoRoot` | `run.ts:181-187` | `<projects_root>/{leaderId}/` 与 `merges/`、`audit.jsonl` 就绪 |
| 3 | `captureConsoleToFile` | `run.ts:188` | console.* 被重定向到 `<projects_root>/{leaderId}/console.log`，TUI 独占终端 |
| 4 | `MessageRouter` / `TaskQueue` | `run.ts:190-191` | ZK 路径 wrapper，无内存状态 |
| 5 | `LeaderEventBus` + `LeaderState` | `run.ts:193-195` | `bus.onAny → state.apply` 已挂载 |
| 6 | `TemplateEngine` / `ClaudeRunner` / `HookEngine` | `run.ts:197-207` | 模板从 `templates/agents/` 加载，runner 注入 `claude_cli` 命令 |
| 7 | `MergeValidator` / `ChainAudit` / `MemoryBootstrap` / `ChainRouter` | `run.ts:214-272` | `magic_mode=false`、`magic_max_chains=null` 注入 ChainRouter |
| 8 | **`bus.emit({type:"magic_mode_configured", magic_mode:false, magic_max_chains:null})`** | `run.ts:277-281` | 这是 LeaderState 收到的第一个事件 |
| 9 | `LeaderWatcher.start()` | `run.ts:283-290` | 监听 `/messages/{leaderId}` |
| 10 | `WorkerMonitor.start()` | `run.ts:292-293` | 监听 `/instances` 子节点 |
| 11 | `TaskOrchestrator.start()` | `run.ts:295-296` | 监听 `/tasks/pending` 与 `/tasks/claimed` |
| 12 | `TaskRecovery.start() + scanOrphans()` | `run.ts:298-300` | 首次启动无孤儿任务 |
| 13 | `TuiController.start()` | `run.ts:305-316` | TUI 渲染开启 |

**LeaderState 内存核心状态（Phase 3 结束时）**：
```
_workers          = []         // 待 Phase 4 worker 注册后填充
_pending          = []
_in_progress     = []
_events          = [{ type: "magic_mode_configured", magic_mode: false, magic_max_chains: null }]
_selected        = 0
_magic_mode      = false
_magic_max_chains = null
```
来源：`packages/leader/src/state.ts:38-202`。

**预期对照**：

| 观察点 | docs/v0.7 | CLAUDE.md | 一致？ |
|--------|-----------|-----------|--------|
| 13 个装配步骤 | DD `01-architecture.md` §6 + 各子系统专章 | 列出 5 个子系统名（WorkerMonitor、TaskOrchestrator、TaskRecovery、LeaderWatcher、ChainRouter），未提 magic_mode_configured 事件 | △（CLAUDE.md 不完整） |
| LeaderState 17 个事件类型 | DD `01-architecture.md` §5 EventBus | 列出 "17 event types" 但未枚举 | △ |
| 首帧 `magic_mode=false` | DD `04-tui-and-input.md` `[MAGIC]` 徽标 | 未提 | ✗（CLAUDE.md 漏 magic 整段，详见 §6 D6） |

### 3.4 Phase 4 — Worker 子进程 fork

**实际**（`run.ts:318-333` → `packages/orchestrator/src/child-supervisor.ts`）：

1. `ChildSupervisor.start(6 个 WorktreeConfig)` 触发 6 次 `fork(child_module, [JSON.stringify(config)])`。
2. 每个子进程的 boot 序列（`packages/worker/src/child-runner.ts` + `child-boot.ts`）：
   1. `process.chdir(worktree_path)` —— 切换到自己的 worktree。
   2. ZK `connect` + ensure_paths（与 Leader 共享 7 条路径，幂等）。
   3. `InstanceRegistry.register({ id, name, role, pid, worktree_*, ... })` → `/claude-orchestrator/instances/{worker_instance_id}` EPHEMERAL，payload：
      ```json
      {
        "id": "<32-char-hex>",
        "name": "Tom",                    // 或 Jerry/Lucy/...
        "role": "planner",                // 见 §3.2 表
        "status": "idle",
        "current_task_id": null,
        "connected_since": "<ISO-8601>",
        "work_dir": null,
        "worktree_name": "Tom",
        "worktree_path": "<abs-path>/.claude-orchestrator/worktree/Tom",
        "worktree_branch": "claude-orchestrator/Tom-workspace",
        "pid": <int>,
        "protocol_version": "0.7.0"
      }
      ```
      schema：`packages/coordination/src/instance-registry.ts:50-71`。
   4. 装配 `TemplateEngine` / `SelfEvaluator` / `CommitChecker` / `DocsCommitter` / `HookEngine`。
   5. `WorkerWatcher.waitForMessage(instance_id, ...)` 进入阻塞循环。
3. `WorkerMonitor` 的 ZK 子节点 watch 收到 6 次新增 → 6 个 `worker_joined` 事件 → `LeaderState._workers` 从 `[]` → `[6 items]`。

**LeaderState 内存核心状态（Phase 4 结束时）**：
```
_workers.length                = 6
_workers.every(w => w.status === "idle")          = true
_workers.every(w => w.pid > 0)                    = true
_workers.every(w => w.current_task_id === null)   = true
_workers.map(w => w.name)        = ["Tom","Jerry","Lucy","Thomas","Jack","Lisa"]  // 顺序取决于 ZK watch 触发顺序，但应一致
_workers.map(w => w.preset_role) = ["planner","executor","verifier","reviewer","accepter","executor"]
_pending                         = []
_in_progress                     = []
_events.length                   = 7   // magic_mode_configured + 6 × worker_joined
```

**预期对照**：

| 观察点 | docs/v0.7 | CLAUDE.md | 一致？ |
|--------|-----------|-----------|--------|
| Worker 子进程 fork 模型 | DD `01-architecture.md` §1 + `06-tasks-and-workers.md` §3 | "Workers run as child processes (forked by the orchestrator)" | ✓ |
| Worker ZK ephemeral payload | DD `02-contracts-and-protocol.md` §11.2 Instance schema | 未列字段 | △（CLAUDE.md 简化） |
| `worker_joined` 触发链路 | DD `01-architecture.md` §5 EventBus | "WorkerMonitor watches /instances children → emits worker_joined / worker_left" | ✓ |

### 3.5 Phase 5 — 等待 shutdown

**实际**（`run.ts:335-350`）：仅注册 SIGINT / SIGTERM cleanup handler；运行期无可观察的进程级输出，所有状态变化由 TUI 反映。

**预期对照**：与 DD `01-architecture.md` §7 "关键交互行为表"中 `Ctrl+C in TUI` 行为一致。CLAUDE.md 未独立描述 Phase 5。

### 3.6 TUI 首帧渲染

**实际**（`packages/leader/src/tui/renderer.ts` + `state.ts`）：

- **TEAM 面板**：6 行，列顺序 `Name | Role | Worktree | Branch | PID | Status`。每行 `Status="idle"`（GREEN）。`_selected=0` → 第一行（Tom）高亮。
- **PENDING 面板**：`No pending tasks`（dim）。
- **IN_PROGRESS 面板**：空。
- **EVENT LOG 面板**：含 7 条事件（顺序：`magic_mode_configured` + `worker_joined × 6`）。
- **INPUT 行**：空，光标就绪。
- **顶栏徽标**：`[MAGIC]` **不显示**（`_magic_mode=false`）。

**预期对照**：

| 观察点 | docs/v0.7 | CLAUDE.md | 一致？ |
|--------|-----------|-----------|--------|
| 六面板布局 | DD `04-tui-and-input.md` §2 / §3 | "ANSI escape-code rendering" + 简单结构描述 | △（CLAUDE.md 简化） |
| `[MAGIC]` 徽标不显示 | DD `04-tui-and-input.md` §9 | 未提 | ✗（CLAUDE.md 漏） |

### 3.7 ZK 节点最终态

```
/claude-orchestrator
├── leader                                 [EPHEMERAL]   payload 见 §3.2
├── instances/
│   ├── {leaderId}                         [EPHEMERAL]   role="leader"
│   └── {workerId × 6}                     [EPHEMERAL]   role 见 §3.2 表
├── tasks/
│   ├── pending/                                         （空目录）
│   ├── claimed/                                         （空目录）
│   └── completed/                                       （空目录）
└── messages/                                            （空目录，发首条消息时按 instance_id 建子目录）
```

### 3.8 文件系统最终态

> **设计意图**（来自 `co-root-initializer.ts:30-31, :60-67`）：
> - **项目根**只放"用户项目相关"：worktree 目录树 + 工作区级 worktree 注册表 + worker 自身运行 claude-cli 时需要读取的模板（`<worktree>/.claude-orchestrator/agents/`，由 TemplateEngine 作 `primary_dir`）。
> - **用户目录下的 CO root**（独立 git repo）放"CO 运行时状态"：`chains/`、`tasks/`、`messages/`、`docs/{name}/`、`merges/`、`audit.jsonl`、`console.log`。

#### 3.8.1 项目根
```
<project_root>/
└── .claude-orchestrator/
    ├── config.json                  # workspace 级 worktree 注册表（saveProjectWorktreeConfig）
    └── worktree/
        ├── Tom/      (planner)
        ├── Jerry/    (executor)
        ├── Lucy/     (verifier)
        ├── Thomas/   (reviewer)
        ├── Jack/     (accepter)
        └── Lisa/     (executor)
            ├── .git                          # git worktree pointer
            ├── CLAUDE.md                     ← templates/claude-memory/team-claude.md
            ├── .claude/skills/{10 skills}/SKILL.md
            └── .claude-orchestrator/
                └── agents/*.md               # 20 个模板（TemplateEngine 的 primary_dir）
```

#### 3.8.2 用户目录下的 CO root
```
~/.claude-orchestrator/projects/{leaderId}/        # ensureCoRoot 初始化
├── .git/                            # 与项目 git 隔离的独立仓库
├── .gitignore                       # tasks/*/exec-*.log 等模式
├── README.md                        # ensureCoRoot 写入的说明
├── chains/                          # 链 audit 数据（按 chain_id 分目录）
├── tasks/                           # 每任务的 exec/eval/commit 日志
├── messages/                        # 每实例的 inbound.log
├── docs/                            # 每 worker 的 docs（DocsCommitter scope）
│   └── {Tom,Jerry,...}/             # 启动时为空；由 worker 在执行任务时写入
├── merges/                          # MergeValidator 日志（按 chain_id）
├── audit.jsonl                      # ChainAudit manifest 日志
└── console.log                      # captureConsoleToFile 写入
```

> 注：DocsCommitter 仅在 `<co_root>/docs/{name}/` 存在时才会提交（`docs-committer.ts:53-58`），因此首次启动时该目录为空，直到 Worker 在执行任务时写入文件。个人 CLAUDE.md（`templates/claude-memory/personal-claude-{role}.md`）目前**未被任何代码 seed 到 CO root** —— claude-cli 读取的是 `<worktree>/CLAUDE.md`（team-claude.md）作为内存上下文。如果未来要启用个人内存，需要新增 seed 逻辑写入 `<co_root>/docs/{name}/CLAUDE.md`，并把它纳入 claude-cli 的内存路径。

---

## 4. LeaderState 完成态（一处汇总）

启动稳定后 LeaderState 应满足（用作验证锚点）：

```ts
state.workers.length === 6
state.workers.every(w => w.status === "idle")
state.workers.every(w => w.pid !== null && w.pid > 0)
state.workers.every(w => w.current_task_id === null)
state.workers.every(w => w.current_role === null)
state.workers.every(w => w.worktree_branch?.startsWith("claude-orchestrator/"))
state.workers.map(w => w.name)        // ["Tom","Jerry","Lucy","Thomas","Jack","Lisa"]
state.workers.map(w => w.preset_role) // ["planner","executor","verifier","reviewer","accepter","executor"]

state.pending_tasks.length === 0
state.in_progress_tasks.length === 0

state.magic_mode === false
state.magic_max_chains === null

state.events.length === 7
state.events[0].type === "magic_mode_configured"
state.events.slice(1).every(e => e.type === "worker_joined")
```

---

## 5. 一致性总结

| 维度 | 与 `docs/v0.7/` | 与根 `CLAUDE.md` | 代码本身 |
|------|-----------------|-------------------|----------|
| 命令行解析 | ✓ 一致 | △ 未明示默认值 | ✓ |
| Phase 1 环境/init | ✓ 一致 | ✗ 多处漏（D10/D11/D12） | ✓ |
| Phase 2 worktree（命名/角色/branch） | ✓ 一致 | ✗ 角色术语错（D2/D3）+ 第 6 角色漏（D5）+ 计数错（D7/D9） | ✓ |
| Phase 2 worktree 内 seed | ✓ 一致（D17 已修复） | — | ✓（D17 已修复） |
| Phase 2 `/leader` payload | ✓ 一致 | ✗ 字段含糊（D13） | ✓ |
| Phase 3 子系统装配 | ✓ 一致 | △ 不完整 | ✓ |
| Phase 4 worker fork | ✓ 一致 | ✓ 一致 | ✓ |
| Phase 5 shutdown | ✓ 一致 | △ 未独立描述 | ✓ |
| TUI 首帧 | ✓ 一致 | △ 简化 | ✓ |
| 代码路径前缀 | — | ✗ 全部错位（D1） | — |
| Magic mode | ✓ 一致 | ✗ 完全未提（D6） | ✓ |
| 配置层数 | ✓ 一致 | ✗ 5 层简化为 2 层（D16） | ✓ |
| 文件系统最终态 | ✓ 一致（D17 已修复） | ✗ CLAUDE.md 未提（D14） | ✓（D17 已修复） |

**结论**：根 `CLAUDE.md` 是文档漂移的主体，需要按 §6 逐条回写。`docs/v0.7/` 与代码的"设计意图"高度一致；启动相关的代码 bug（**D17**：worktree 内冗余 seed）已修复，使代码完整匹配设计。

---

## 6. 差异清单（CLAUDE.md vs. 代码 / docs/v0.7）

| ID | 主题 | CLAUDE.md 原文 / 状态 | 代码 / DD 实际 | 判定 | 修复方案 |
|----|------|----------------------|----------------|------|----------|
| **D1** | 源码路径前缀 | `src/leader/`、`src/worker/`、`src/orchestrator/`、... | 实际 `packages/{cli,orchestrator,leader,worker,coordination,contracts,infra,runtime}/src/`（pnpm monorepo） | 代码为准 | CLAUDE.md "Architecture" 全段路径回写 `src/X` → `packages/X/src/`，更新 "Key Files" 表 |
| **D2** | 角色名 builder | `1 planner + 1 builder + ...`、`build` link | `executor`（contracts 强类型枚举 + `LINK_TO_ROLE`） | 代码为准 | CLAUDE.md 全文 `builder` → `executor`、`build` link → `execute` |
| **D3** | 角色名 acceptor | `acceptor` | `accepter`（注意拼写） | 代码为准 | CLAUDE.md 全文 `acceptor` → `accepter` |
| **D4** | 责任链 link 名 | `plan → build → verify → review → accept` | `plan → execute → verify → review → accept`（`state.ts:29-36` LINK_TO_ROLE） | 代码为准 | 同 D2 修复同时覆盖此处 |
| **D5** | 第 6 worker 默认角色 | 未提及 | 非 magic = `executor`（`worktree-initializer.ts:60`）；magic = `explorer`（MAGIC_ROLE_PRIORITY） | 代码合理 | CLAUDE.md 补：standard 模式第 6 默认 executor，magic 模式才是 explorer |
| **D6** | magic 模式整段 | 完全未提 | `--magic` / `--magic-max-chains` / `CO_MAGIC_MAX_CHAINS` / `explorer` 角色 / `spawn_chain` / `chain_forest` / `[MAGIC]` 徽标 / chain_audit `magic_mode_configured` 事件 | 代码合理（v0.7 NEW） | CLAUDE.md 新增 "v0.7 Magic Mode" 一节，指向 `docs/v0.7/dd/10-magic-loop.md` |
| **D7** | 模板数量 | "5 role-named system prompts + 5 task wrappers + identity/decompose/evaluate/commit/merge/task-doc" | 实际 `templates/agents/` 共 **20 个**：6 × `worker-{role}.md`（含 explorer）+ 6 × `worker-{role}-task.md` + worker-identity.md + worker-decompose.md + worker-evaluate.md + worker-evaluate-format-hint.md + worker-commit-message.md + worker-merge-decision.md + worker-memorize-dir.md + worker-memorize-file.md | 代码为准 | CLAUDE.md 更新 "templates/" 一行：角色数 5→6（含 explorer）；任务 wrapper 5→6；增列 format-hint / commit-message / memorize-{dir,file} |
| **D8** | claude-memory 角色配置数 | "6 role configs" | 实际 6 × `personal-claude-{role}.md` + 1 × `team-claude.md` | 一致 | — |
| **D9** | skills 数量 | "6 responsibility chain skills + CLI ref + developer ref" | 实际 10 个：`task-{planning,execution,verification,review,acceptance,exploration,traceability}` + `test-driven-development` + `claude-orchestrator` + `claude-code-developer` | 代码为准 | CLAUDE.md 更新 "skills/" 一行：扩到 10 个，列出新增的 exploration / traceability / tdd |
| **D10** | 工作区干净检查 | 未提 | `ensureCleanWorkspace`（`run.ts:353-365`）强制 `git status --porcelain` 为空，否则 throw | 代码合理 | CLAUDE.md "Development Commands" 段补：启动前置条件 "工作区无未提交变更" |
| **D11** | InitChecker 4 步 | 未提 | `InitChecker.runAll` 4 步（global config / user CLAUDE.md / team CLAUDE.md / skills），见 `run.ts:105-111` | 代码合理 | CLAUDE.md "Architecture > Orchestrator" 段补 Phase 1 实际工作 |
| **D12** | auto_commit_init_files | 未提 | 默认 true，启动时自动 `git commit -m "chore: init orchestrator workspace files"`（`run.ts:373-406`） | 代码合理 | CLAUDE.md "Configuration Layering" 段补 git 配置项 |
| **D13** | `/leader` 节点字段 | "Leader metadata"（含糊一行） | `{protocol_version, leader_id, pid, host, started_at, magic_mode, magic_max_chains}` | 代码为准 | CLAUDE.md "ZK Node Tree" 段把 `/leader` 注释展开为字段表 |
| **D14** | personal CLAUDE.md 路径 | 未提 | seed 目标曾错置于 `<worktree>/.claude-orchestrator/docs/{name}/CLAUDE.md`，但代码库各处对其均无读取（含 claude-cli 标准内存路径）。D17 修复时已一并删除整段 seed 代码 | 代码为准 | 已通过 D17 修复一并解决；CLAUDE.md 无需新增此条目录 |
| **D15** | 测试体系 | "All test files have been removed in v0.7" + `tests/CLAUDE.md` 仍是 ground truth | 已确认（`pnpm test` 报 "no test files found"） | 一致 | — |
| **D16** | 配置层数 | "merges two config files: Global + Project" | 实际五层：CLI args → env vars → project config → global config → defaults（`packages/infra/src/config/config-loader.ts`） | 代码为准 | CLAUDE.md "Configuration Layering" 段改写为 5 层 |
| **D17** | worktree 内多写一层 `.claude-orchestrator/`（已修复） | 未提 | 原 `initializeWorktrees:254-260` 在 worktree 内写 `.claude-orchestrator/config.json`（无消费者）；原 `seedWorktreeAssets:331-345` 写 `.claude-orchestrator/docs/{name}/CLAUDE.md`（无消费者）。审计确认 `.claude-orchestrator/agents/*.md` 被 `child-boot.ts:74-82` 用作 TemplateEngine `primary_dir`，**必须保留**。设计意图（`co-root-initializer.ts:30-31, :60-67`）允许 worktree 内放置运行时模板，仅禁止把 CO 运行时状态（docs/、tasks/、chains/）写入 worktree | 已修复 | ✅ 已在 `worktree-initializer.ts` 删除 config.json 与 personal CLAUDE.md 写入；agents 复制保留（TemplateEngine 依赖） |

> **优先级建议**：
> - **高优先级**（影响读者立刻找错文件或叫错术语）：D1/D2/D3/D4/D7/D9/D16
> - **中优先级**（补遗）：D5/D6/D11/D12/D13
> - **已修复**：D14（随 D17 一并解决）、D17
> - **已一致**：D8/D15

---

## 7. 后续真机验证项（留待 `01-startup-worker-6-runtime.md`）

本份纸面验证无法 100% 闭环，下一份 evals 文档需要真机跑一次 `--worker 6` 并回填：

- [ ] 6 个 worker 的实际 PID 列表（应与 ZK `instances` 节点内的 `pid` 一致）。
- [ ] TUI 首帧 ASCII 截图（验证 §3.6 描述）。
- [ ] 启动总耗时（预期 ~5s 内：6 个 worktree 创建 + ZK ensure_paths + 6 个 fork）。
- [ ] 6 个 `worker_joined` 事件的实际出现顺序（不影响 LeaderState 一致性，但便于诊断 fork 速度）。
- [ ] `~/.claude-orchestrator/projects/{leaderId}/console.log` 是否被实际写入。
- [ ] 复现 `ensureCleanWorkspace` 抛错路径（人为留一个未提交修改后启动，验证报错信息）。

---

## 8. 维护

- 任何改动 `packages/orchestrator/src/run.ts`、`worktree-initializer.ts`、`packages/leader/src/state.ts` 的 PR 都应回看 §3 / §4 是否仍然成立。
- §6 差异清单中任一项被实际修复（PR 合入后），把该行标记为 `~~已修~~` 并附 PR 号，保留历史。
- 与本场景不相关的新行为变更（如 `--magic` 内部细节）不应混入本文，请新建编号 02+ 的 evals 文档。
