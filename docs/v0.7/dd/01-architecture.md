# 01 — 系统架构与进程模型

> **DD 定位**：v0.7 的进程拓扑、模块切分、ZK 节点全景、Cache 目录布局、启动时序。本文回答"系统由什么组成、谁调谁、状态存在哪里"。
>
> **PRD 锚**：`docs/v0.7/prd/01-overview.md` §4.2 零中心化；`docs/v0.7/prd/04-functional-requirements.md` FR-01 / FR-07 / FR-23~25 / FR-32（`--magic` 启动）；`docs/v0.7/prd/05-non-functional.md` §1 / §4.
>
> **依赖**：所有 schema 与字段名以 `02-contracts-and-protocol.md` 为准。

---

## 1. 进程拓扑

```mermaid
graph TD
  subgraph User["操作员（人）"]
    OP[(键盘 TUI)]
  end

  subgraph Host["单台主机（无 HTTP / 无 MCP Server）"]
    L["<b>Leader 进程</b><br/>claude-orchestrator run<br/>TUI + ZK 客户端"]
    W1["Worker 子进程 #1<br/>name=Tom role=planner"]
    W2["Worker 子进程 #2<br/>name=Jerry role=executor"]
    Wn["Worker 子进程 #N<br/>..."]
  end

  ZK[("ZooKeeper<br/>(EPHEMERAL + SEQUENTIAL)")]
  CL[("claude CLI<br/>(子进程, 每次 -p 调用 fork)")]

  OP -->|stdin| L
  L -->|fork(child.js)| W1
  L -->|fork(child.js)| W2
  L -->|fork(child.js)| Wn
  L <-->|Watch / Read / Write| ZK
  W1 <-->|Watch / Read / Write| ZK
  W2 <-->|Watch / Read / Write| ZK
  Wn <-->|Watch / Read / Write| ZK
  L -.->|claude -p（decompose, merge-decision）| CL
  W1 -.->|claude -p（task + self-eval）| CL
  W2 -.->|claude -p（task + self-eval）| CL
  Wn -.->|claude -p（task + self-eval）| CL
```

不变量：
1. **单 Leader**：`/leader` 是 ZK EPHEMERAL 节点，互斥抢占。第二个 Leader 启动遇 `ZK_NODE_EXISTS` 立即退出（FR-01 + 05 §1）。
2. **Worker 是 Leader fork 的子进程**，受父进程进程组管理；Ctrl+C 杀 Leader → SIGTERM 全部 Worker；Worker 1Hz 主动探活父进程（FR-25）。
3. **跨进程通信仅经 ZK**：Leader 与 Worker 之间不开任何 socket 或管道；唯一例外是 `fork()` 时 IPC channel 仅作为子进程启动信道，运行期不依赖。
4. **claude CLI 是无状态外部子进程**：每次 `claude -p` 调用一次性 fork，结果通过 stdout 回收（`execWithTee` / `execWithStreaming`）。

---

## 2. 模块切分

### 2.1 Leader 子系统

| 子系统 | 职责 | 主文件 |
|---|---|---|
| **TUI**            | 渲染 6 面板 + 接收键盘输入 + 写 `user_input` Message | `04-tui-and-input.md` |
| **LeaderWatcher**  | Watch `/messages/{leader_id}/msg-*`，按 type 分发到 ChainRouter 或 MemoryBootstrap | `05-chain-router-and-decisions.md` §1 |
| **ChainRouter**    | 需求拆解（decompose）；EvalDecision 五态路由；feedback target 解析；spawn_chain 派生 | `05-chain-router-and-decisions.md` |
| **TaskOrchestrator** | Watch `/tasks/pending` 与 `/tasks/claimed`，发射 `task_created` / `task_claimed` / `task_completed` 事件 | `06-tasks-and-workers.md` §2 |
| **WorkerMonitor**  | Watch `/instances`，发射 `worker_joined` / `worker_left` | `06-tasks-and-workers.md` §6 |
| **Recovery**       | 孤儿任务回收 + 子进程重启计数 | `06-tasks-and-workers.md` §6 |
| **MergeValidator** | close_chain / spawn_chain 时把链内所有 commit merge 到 main | `07-merge-validator-and-closure.md` |
| **ChainAudit**     | manifest / audit.jsonl / requirement.md 读写；openChain / closeChain / incrementRetry | `09-audit-and-cache.md` |
| **MemoryBootstrap** | `/init` slash 触发；memory 卡片生成；`memory_refresh` 增量 | `08-memory-and-bootstrap.md` |
| **HookEngine**     | 4 类 lifecycle hook 触发 + `CO_*` env 注入 | `09-audit-and-cache.md` §6 |
| **LeaderEventBus** | 类型化 EventEmitter，串联所有子系统事件 | 本文 §5 |

### 2.2 Worker 子系统

| 子系统 | 职责 | 主文件 |
|---|---|---|
| **MessageListener** | Watch `/messages/{instance_id}/msg-*`，按 type 派发 | `06-tasks-and-workers.md` §3 |
| **TaskExecutor**    | 渲染 task prompt → 调用 ClaudeRunner | `06-tasks-and-workers.md` §3 |
| **TemplateEngine**  | 加载 `worker-{role}-task.md` + 身份卡三段拼接 + 变量替换 | `03-identity-and-roles.md` §4 |
| **ClaudeRunner**    | 包装 `claude -p` 子进程 (`execWithTee` / `execWithStreaming`) | `06-tasks-and-workers.md` §3 |
| **CommitChecker**   | 任务完成后 `git add -A && git commit`；失败抛 CommitFailedError | `06-tasks-and-workers.md` §4 |
| **SelfEvaluator**   | 渲染 `worker-evaluate.md` 解析 EvalDecision；3 次重试 + format-hint + fallback reject | `06-tasks-and-workers.md` §5 |
| **CompletionReporter** | 把 EvalDecision JSON 包装为 `completion_report` Message 发回 Leader | `06-tasks-and-workers.md` §3 |
| **ParentLiveness**  | 1Hz `process.kill(ppid, 0)` 探活；父死自杀 | `06-tasks-and-workers.md` §6 |

### 2.3 Leader ↔ Worker 数据流

```mermaid
sequenceDiagram
  autonumber
  participant OP as 操作员
  participant TUI as Leader TUI
  participant LW as LeaderWatcher
  participant CR as ChainRouter
  participant TQ as TaskQueue（ZK /tasks）
  participant W as Worker（Tom / planner）
  participant CA as ChainAudit

  OP->>TUI: 输入需求 + Enter
  TUI->>LW: 写 /messages/{leader_id}/msg-NNNNN (type=user_input)
  LW->>CR: handleRequirement(content)
  CR->>CA: openChain(chain_id, requirement)
  CR->>CR: decompose → ChainDef
  CR->>TQ: push 5(或 6) 个 Task 到 /tasks/pending
  TQ-->>W: zk watch 触发
  W->>TQ: claim(task) → 创建 /tasks/claimed/<self>-task-NNNNN (EPHEMERAL)
  W->>W: 渲染 prompt → claude -p → CommitChecker → SelfEvaluator
  W->>LW: 写 /messages/{leader_id}/msg-MMMMM (type=completion_report, content=EvalDecision JSON)
  LW->>CR: handleCompletionReport(decision)
  CR->>TQ: push next link task / push retry task / runMergeValidation
  Note over CR,CA: closeChain / chain_spawned 等终态触发参见 05 §3 与 10 §4
```

---

## 3. ZK 节点全景

### 3.1 节点树

```
/claude-orchestrator
├── leader                                  [EPHEMERAL]    01 §3.2
├── instances/
│   ├── Tom                                 [EPHEMERAL]    01 §3.2
│   ├── Jerry                               [EPHEMERAL]
│   └── ...
├── tasks/
│   ├── pending/
│   │   ├── task-00001                      [PERSISTENT_SEQUENTIAL]
│   │   ├── task-00002                      [PERSISTENT_SEQUENTIAL]
│   │   └── ...
│   ├── claimed/
│   │   ├── Tom-task-00001                  [EPHEMERAL]   ← claim lock
│   │   └── ...
│   └── completed/
│       └── task-NNNNN                      [PERSISTENT]
└── messages/
    ├── <leader_id>/
    │   ├── msg-00000                       [PERSISTENT_SEQUENTIAL]
    │   └── ...
    ├── Tom/
    │   ├── msg-00000
    │   └── ...
    └── ...
```

> `protocol_version`、`magic_mode`、`magic_max_chains` 写入 `/leader` 节点 payload（详见 `02-contracts-and-protocol.md` §11.1）。Worker 启动时读 `/leader` 校验 PROTOCOL，并感知 magic 上下文。

### 3.2 节点语义

| 节点 | 类型 | 创建者 | 删除时机 |
|---|---|---|---|
| `/leader` | EPHEMERAL | Leader 启动 | Leader 进程退出 / ZK session 失效 |
| `/instances/{id}` | EPHEMERAL | Worker child-runner | Worker 子进程退出 / ZK session 失效 |
| `/tasks/pending/task-NNNNN` | PERSISTENT_SEQUENTIAL | ChainRouter.push / Recovery.reclaim | 任务被 claim 后由 TaskQueue 删除 |
| `/tasks/claimed/{instance_id}-task-NNNNN` | EPHEMERAL | TaskQueue.claim（atomic create） | 任务完成（move to completed） / Worker 失联（自动删） |
| `/tasks/completed/task-NNNNN` | PERSISTENT | TaskQueue.complete | 无 TTL，长跑后累积（PRD §6 已知边界） |
| `/messages/{instance_id}/msg-NNNNN` | PERSISTENT_SEQUENTIAL | 发送方 | Receiver dismiss 后 delete |

### 3.3 关键原子性

1. **Atomic claim**：Worker 调用 `zk.create('/tasks/claimed/<self>-task-NNNNN', EPHEMERAL)`，ZK 保证只有第一个 create 成功的 Worker 拿到任务（其它 Worker 收 `NODE_EXISTS`）。详见 `06-tasks-and-workers.md` §2。
2. **Atomic leader election**：Leader 抢 `/leader` 节点同理。
3. **SEQUENTIAL 顺序**：消息按 ZK 内部计数器递增，跨 Watch 触发后按 `msg-NNNNN` 字符串顺序处理可保证因果序。

### 3.4 ZK 容量

- 单节点 payload 上限 1 MiB（ZK 原生）。Task / Message JSON 通常 < 16 KiB；超 64 KiB 的 `result` 落盘并以 `file://<path>` 引用（详见 `09-audit-and-cache.md` §5）。
- Watch 不是持久订阅：每次触发后必须重新 set watch。ZK 客户端封装在 `zk/client.ts` 自动重置（PRD §1 ZK 自动重连）。

### 3.5 ZkNodeSpec 草案

```ts
export type ZkNodeKind =
  | 'PERSISTENT'
  | 'PERSISTENT_SEQUENTIAL'
  | 'EPHEMERAL'
  | 'EPHEMERAL_SEQUENTIAL';

export interface ZkNodeSpec<TPayload> {
  path:        string;               // 含 {} 占位（如 '/instances/{instance_id}'）
  kind:        ZkNodeKind;
  payloadSchema: z.ZodType<TPayload>;
  createdBy:   'leader' | 'worker' | 'task-queue' | 'message-router';
}
```

> 实际 schema 见 `02-contracts-and-protocol.md` §11。

---

## 4. Cache 目录布局

Leader 启动时根据 `<cache_dir>` 与 `<leader_id>` 构造根路径，默认 `~/.claude-orchestrator/projects/<leader_id>/`。

```
~/.claude-orchestrator/projects/<leader_id>/
├── chains/
│   └── <chain_id>/
│       ├── manifest.json              # 完整 ChainManifest（02 §6）
│       ├── audit.jsonl                # 一行一 AuditEvent（02 §13）
│       └── requirement.md             # 用户原始需求文本
├── tasks/
│   └── <task_id>/
│       ├── result.md                  # 任务产出（chain 内共享）
│       ├── exec-<ts>.log              # claude -p 执行日志
│       └── eval-<N>.log               # SelfEvaluator 第 N 次重试日志（N=1..3）
├── merges/
│   └── merge-<ts>.log                 # MergeValidator 每次决策的完整日志
├── docs/
│   └── <worker_name>/
│       └── <YYYY-MM-DD>/
│           └── <prefix>-<chain_id>.md # Worker 个人备份（不与 result.md 冲突）
└── memory/
    ├── CLAUDE.md                      # 顶层 memory 索引（FR-28）
    └── packages/
        └── <path>.md                  # 单文件 memory 卡片（front-matter 含 source_hash）
```

> 各路径的写入 owner 与文件生命周期详见 `09-audit-and-cache.md` §5 与 `08-memory-and-bootstrap.md` §3。

---

## 5. Leader 事件总线（LeaderEventBus）

Leader 所有子系统通过类型化 EventEmitter 通信，避免直接相互依赖：

```ts
export type LeaderEventMap = {
  // —— 进程
  worker_joined:      { instance_id: InstanceId; name: string; role: WorkerRole };
  worker_left:        { instance_id: InstanceId; reason: string };
  worker_restarted:   { instance_id: InstanceId; restart_count: number };

  // —— 任务
  task_created:       { task: Task };
  task_claimed:       { task_id: TaskId; claimed_by: InstanceId };
  task_completed:     { task_id: TaskId; decision: EvalDecision };
  task_recovered:     { task_id: TaskId; retry_count: number };
  task_failed:        { task_id: TaskId; reason: string };

  // —— 链
  chain_opened:       { chain_id: ChainId; magic_mode: boolean; chain_depth: number };
  chain_closed:       { chain_id: ChainId; status: ChainStatus };
  chain_merge_failed: { chain_id: ChainId; failures: ChainManifest['merge_failures'] };
  chain_spawned:      { parent: ChainId; child: ChainId };   //
  magic_depth_exhausted: { chain_id: ChainId; max_chains: number }; //

  // —— 调试
  debug_info:         { message: string; payload?: unknown };
};
```

> 渲染策略详见 `04-tui-and-input.md` §4（EVENT LOG 100 条滚动 + 红字着色规则）。

---

## 6. 启动 5 阶段（FR-01）

```mermaid
sequenceDiagram
  autonumber
  participant OP as 操作员
  participant CLI as claude-orchestrator run
  participant IC as InitChecker
  participant WI as WorktreeInitializer
  participant L as Leader
  participant ZK as ZooKeeper
  participant WC as Worker children

  OP->>CLI: run --worker N [--magic [--magic-max-chains M]]
  CLI->>IC: validate(N>=6, claude-cli 可用, ZK 可连接)
  IC-->>CLI: ok
  CLI->>WI: initialize(N, magicMode)
  WI->>WI: 按优先级填充 role；创建 worktree 与分支；写 config.json
  WI-->>CLI: { worktree map, instance_ids }
  CLI->>L: start(leader_id, magicMode, magicMaxChains)
  L->>ZK: create /leader EPHEMERAL（含 protocol_version=0.7.0, magic_mode）
  L->>L: 启动 TUI、LeaderWatcher、TaskOrchestrator、WorkerMonitor、Recovery、ChainAudit、MemoryBootstrap、HookEngine
  L->>WC: fork(child.js × N, env={instance_id, name, role, worktree, ...})
  WC->>ZK: 校验 /leader.protocol_version；create /instances/{id} EPHEMERAL
  WC->>ZK: setWatch /messages/{id}
  WC-->>L: ready（通过 worker_joined 事件）
  L-->>OP: TUI 渲染完成（5 阶段结束）
```

> 5 阶段：(1) 环境自检；(2) Worktree 初始化；(3) Leader 启动 + TUI；(4) Worker fork；(5) 等待事件。
>
> `--magic` 时 (2) 阶段的 role 填充顺序变为 `planner > executor > verifier > reviewer > accepter > explorer`（详见 `03-identity-and-roles.md` §2.2）；(3) 阶段 `/leader.magic_mode=true`；(4) 阶段所有 Worker 在校验 protocol 之外额外读取 `magic_mode` 用于决定是否启用 spawn_chain 决策合法性。

---

## 7. 关停（Ctrl+C / Leader 崩溃）

| 触发 | 行为 |
|---|---|
| **Ctrl+C** in TUI | TUI 捕获 SIGINT → emit `shutdown_requested` → LeaderEventBus 通知所有子系统 → SIGTERM 子进程 → 等 5s grace → SIGKILL；最后 `zk.close()` 主动释放 `/leader` |
| **Leader 崩溃** | Worker 1Hz 探活 ppid 检测父死 → 子进程立即 `process.exit(1)` → `/instances/*` EPHEMERAL 节点自动消失（FR-25） |
| **Worker 崩溃** | 父进程 `child.on('exit')` → restart_count++；≤3 次内 refork；> 3 次 emit `worker_left` 永久下线（FR-24） |
| **ZK 断连** | ZkClient 指数退避重连 10 次；超限进程退出（PRD §1） |

> Leader 不做热备；崩溃后操作员需手动 `run --worker N`（PRD §6 已知边界 - 单 Leader、无热备）。

---

## 8. 配置层叠（PRD §5 §6 配置四级合并）

```
CLI 参数 / 环境变量
        > Worktree 配置（.claude-orchestrator/worktree/<name>/config.json，可选）
            > 项目根配置（.claude-orchestrator/config.json）
                > 全局配置（~/.claude-orchestrator/config.json）
                    > 内置默认值
```

关键键：

| 键 | 默认 | 覆写方式 |
|---|---|---|
| `zookeeper.hosts` | `127.0.0.1:2181` | CLI `-z` / env `ZK_HOSTS` / 全局 |
| `zookeeper.root_path` | `/claude-orchestrator` | 全局 |
| `cache_dir` | `~/.claude-orchestrator` | 全局 |
| `commands.claude-cli` | `claude --dangerously-skip-permissions --permission-mode dontAsk` | 全局 |
| `commands.git` | `git` | 全局 |
| `hooks.worker_message_start` 等 | `null` | 全局 |
| `--worker N` | `6`(最小 6) | CLI |
| `max_total_retries` (`CO_CHAIN_MAX_RETRIES`) | `9` | env |
| **`git.merge_target_branch`** | `null`（回退到 Leader HEAD） | 全局 / 项目 |
| **`git.remote`** | `"origin"`（`null` 关闭 fetch / pre-task remote 同步） | 全局 / 项目 |
| **`git.auto_commit_init_files`** | `true` | 全局 / 项目 |
| **`git.auto_commit_init_files_branch`** | `null`（不另起分支） | 全局 / 项目 |
| **`worktree.reset_on_reuse`** | `true`（worktree 复用时 `git reset --hard <leader_head>`） | orchestrator 内部参数（非用户配置层；详见 `06-tasks-and-workers.md` §1） |
| **`--magic`** | 关 | CLI |
| **`--magic-max-chains M`** | unlimited | CLI / env `CO_MAGIC_MAX_CHAINS` |

> **rc1 worktree 工作流相关键**：
> - `git.merge_target_branch=null` 时 MergeValidator 在 `validate()` 现场 `git rev-parse --abbrev-ref HEAD` 取 Leader 进程当前分支；显式设 `"main"` 适用于"在 feature 分支启动 orchestrator 但要合并回 main"的工作流。
> - `git.remote=null` 既禁 MergeValidator 的 `git fetch <remote> <main>` 也禁 Worker pre-task rebase 的 `git fetch <remote> <sha>`；适合无远程仓 / 离线开发。
> - `worktree.reset_on_reuse` 在 orchestrator 复用既存 worktree 时执行 `git reset --hard <leader_head>`：**有损清理**，丢弃 worktree 中未 commit 的工作。代码归属：`packages/orchestrator/src/worktree-initializer.ts:166`。
>
> 详见 `10-magic-loop.md` §1（magic 配置传播）；`06-tasks-and-workers.md` §3.5（pre-task rebase）；`07-merge-validator-and-closure.md` §3.2 / §6.5（merge target / remote 应用、`isCommitMerged`）；代码 `packages/orchestrator/src/worktree-initializer.ts:166`（worktree 复用 + `reset_on_reuse`）。

---

## 9. 模块依赖图

```mermaid
graph LR
  subgraph Contracts["02 协议契约（schema 真相源）"]
    SCH[Zod Schemas + Errors + roleWeights]
  end

  subgraph LeaderSide["Leader 侧"]
    TUI[04 TUI]
    LW[05 ChainRouter / LeaderWatcher]
    CA[09 ChainAudit]
    MV[07 MergeValidator]
    MB[08 MemoryBootstrap]
    TQ[06 TaskOrchestrator]
    REC[06 Recovery]
    MON[06 WorkerMonitor]
    HE[09 HookEngine]
    EB[01 §5 EventBus]
  end

  subgraph WorkerSide["Worker 侧"]
    ML[06 MessageListener]
    TE[06 TaskExecutor + TemplateEngine]
    CR_W[06 ClaudeRunner]
    CC[06 CommitChecker]
    SE[06 SelfEvaluator]
    PL[06 ParentLiveness]
  end

  SCH --> TUI & LW & CA & MV & MB & TQ & REC & MON & HE
  SCH --> ML & TE & CR_W & CC & SE
  LW --> CA & MV & TQ & EB
  TUI --> EB
  TQ --> EB
  MON --> EB
  REC --> TQ
  ML --> TE --> CR_W
  CR_W --> CC --> SE
  SE -.->|completion_report| LW
  MB --> CA
  HE -.->|task_claimed / task_completed| EB
```

> 箭头方向 = 调用 / 写入 / 派发依赖。EventBus 是 Leader 内的 fan-out 中枢；跨进程通信仅通过 ZK（图中以虚线表示 ZK 中转）。

---

## 10. 与其它 DD 的交叉引用入口

| 主题 | 主文件 |
|---|---|
| schema 完整定义 | `02-contracts-and-protocol.md` |
| 角色/身份/worktree 分配 | `03-identity-and-roles.md` |
| TUI 渲染与键盘 | `04-tui-and-input.md` |
| EvalDecision 路由细节 | `05-chain-router-and-decisions.md` |
| Worker 执行流与恢复 | `06-tasks-and-workers.md` |
| Merge 与链关闭 | `07-merge-validator-and-closure.md` |
| Memory bootstrap | `08-memory-and-bootstrap.md` |
| ChainAudit / Cache / Hook | `09-audit-and-cache.md` |
| `--magic` 端到端 | `10-magic-loop.md` |

---

## 11. 包结构与依赖（monorepo 物理布局）

代码组织为 8 个 npm 包，按依赖单向流动：

```
packages/
├── infra/           # 基础设施层：zk client, fs paths, logger, config-loader
├── contracts/       # 协议契约层：所有 Zod schemas、错误类、enum、接口（IClaudeRunner / IEventBus / ...）
├── runtime/         # 运行时层：ClaudeRunner、TemplateEngine、HookEngine（执行 + 渲染 + hook）
├── coordination/    # 协调层：TaskQueue、MessageRouter、Registry（基于 zk client 包装的高级原语）
├── leader/          # Leader 侧业务：ChainAudit、ChainRouter、MergeValidator、WorkerMonitor、Recovery、TUI 状态机
├── worker/          # Worker 侧业务：Watcher、CommitChecker、DocsCommitter、SelfEvaluator、ParentLiveness
├── orchestrator/    # 进程编排：5-phase 启动、worktree-initializer、fork 子进程
└── cli/             # 用户入口：commander 命令注册、参数解析
```

### 11.1 依赖单向流（7 层）

```mermaid
graph TD
  CLI[cli]
  ORCH[orchestrator]
  LEAD[leader]
  WORK[worker]
  COORD[coordination]
  RUNT[runtime]
  CON[contracts]
  INF[infra]

  CLI --> ORCH
  ORCH --> LEAD & WORK
  LEAD --> COORD & RUNT & CON & INF
  WORK --> COORD & RUNT & CON & INF
  COORD --> CON & INF
  RUNT --> CON & INF
  CON --> INF
```

> **不变量**：
> - **零循环依赖**：上层依赖下层，反之不允许。`contracts` 仅依赖 `infra`（类型 / logger 接口），不依赖任何业务包。
> - **跨 Leader/Worker 共享**：所有跨进程协议（schemas / errors / enums / 接口）只放 `contracts`；`leader` 与 `worker` 互不依赖。
> - **`runtime` 不感知 ZK**：ClaudeRunner / TemplateEngine / HookEngine 是纯执行层，不直接调用 zk client；coordination 层负责 ZK 桥接。

### 11.2 与 v0.6 的差异

- v0.6 仅 7 个包（`worker` 拆出 `coordination` 是 ��把"Worker 与 ZK 的消息读写"从 worker 业务剥离）。
- `contracts` 在 增 `LinkCommitRecord` / `UpstreamCommitsSchema` / 4 个 git 错误类 / `MagicDepthExhaustedError`（详见 `02-contracts-and-protocol.md` §6.0 / §9 / §12）。
- `worker` 在 增 `DocsCommitter` 子模块（双轨 commit，详见 `06-tasks-and-workers.md` §4.5）。
