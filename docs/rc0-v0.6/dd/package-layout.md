# Package Layout — v0.6 多包工程分层规范

> **文档定位**：代码归属权威。回答的唯一问题是：**新代码该放在哪个包？**
> 相关文档：`contracts.md`（类型契约）、`protocol.md`（wire-format）、`error-and-recovery.md`（错误与恢复）。

## 1. 分层哲学

v0.6 采用 pnpm workspaces + 7 层严格单向依赖。上层只能 import 下层；同层互不引用。

设计目标：
1. **协议优先**（Contracts first）—— 类型、Schema、接口先于实现
2. **横向解耦** —— Leader 与 Worker 同层，互不感知，只通过 ZK 与共享类型对话
3. **可替换实现** —— ZK、Runner、Hook 先以接口注入，再由具体包实现
4. **可读路径** —— 依赖只指向"下面"

## 2. 包清单与依赖矩阵

| 包 | 层 | 职责 | 允许依赖 |
|----|----|------|----------|
| `@co/contracts` | 0 | 纯类型、Zod schema、接口声明、路径函数、错误类、权重表 | `zod`（peer） |
| `@co/infra` | 1 | `IZkClient` 实现、Logger、exec、fs 助手、Config loader | `contracts`、`node-zookeeper-client` |
| `@co/runtime` | 2 | `IClaudeRunner` / `ITemplateEngine` / `IHookEngine` 实现 | `contracts`、`infra` |
| `@co/coordination` | 3 | `ITaskQueue` / `IMessageRouter` / `IInstanceRegistry` 实现 | `contracts`、`infra` |
| `@co/leader` | 4a | EventBus、State、ChainRouter、MergeValidator、Recovery、Monitor、TUI | `contracts`、`runtime`、`coordination` |
| `@co/worker` | 4b | WorkerWatcher、SelfEvaluator、CommitChecker | `contracts`、`runtime`、`coordination` |
| `@co/orchestrator` | 5 | `run.ts`（5 阶段）、InitChecker、WorktreeInitializer、ChildSupervisor | `contracts`、`infra`、`runtime`、`coordination`、`leader`、`worker` |
| `@co/cli` | 6 | commander 入口 + 13 个子命令 | `contracts`、`infra`、`coordination`、`orchestrator` |

**关键规则**：
- 4a (`leader`) 与 4b (`worker`) 互不依赖
- 5 (`orchestrator`) 是唯一可同时引用 `leader` 与 `worker` 的包
- 6 (`cli`) 不直接引用 `leader` / `worker`，通过 `orchestrator` 入口

## 3. 各包职责与禁区

### `@co/contracts`（Layer 0）

**职责**：全部 Branded ID、Zod schema、跨层接口、纯路径函数（不读盘、不连 ZK）、错误类、角色权重表、协议版本常量。

**禁区**：禁止 `import fs / path / child_process / node-zookeeper-client`；禁止运行时副作用；`dependencies` 必须为空。

### `@co/infra`（Layer 1）

**职责**：`ZkClient` 实现（含自动重连、mkdirp、persistentChildWatch）、Logger（支持 `--debug` 与 `child(name)`）、exec 工具（execWithStreaming / execWithTee）、ConfigLoader（层级合并语义）。

**禁区**：禁止 import 任何 Layer ≥2 的包；禁止持有领域状态（Task / Message / Chain）。

### `@co/runtime`（Layer 2）

**职责**：`TemplateEngine`（仅 `{{var}}` 替换）、`ClaudeRunner`（封装 claude -p、`--append-system-prompt` 身份注入、`--resume`、`--fork-session`）、`HookEngine`（fire-and-forget shell 子进程）。

**禁区**：禁止读 ZK；禁止知晓 TaskLink / ChainDef / EvalDecision 业务语义。

### `@co/coordination`（Layer 3）

**职责**：`TaskQueue`（push / claim / complete / block / fail / retry / list + ROLE_WEIGHTS 排序）、`MessageRouter`（send / poll / wait / dismiss）、`InstanceRegistry`（register / unregister / heartbeat / list / watch）。

**禁区**：不解释 EvalDecision；不调用 claude-cli；路径从 `@co/contracts/paths/zkPaths` 取。

### `@co/leader`（Layer 4a）

**职责**：EventBus、LeaderState、ChainRouter（机械路由三类分支）、MergeValidator（合并裁决）、Recovery（孤儿扫描）、WorkerMonitor + TaskOrchestrator + LeaderWatcher + StreamTailer、TUI（renderer / input / controller 三段拆分）。

**禁区**：禁止 `import '@co/worker'`；禁止直接依赖 `node-zookeeper-client`。

### `@co/worker`（Layer 4b）

**职责**：WorkerWatcher（消息处理 8 步管线）、SelfEvaluator（3 次重试 + `--fork-session`）、CommitChecker（自动 commit + 回退文案）。

**禁区**：禁止 `import '@co/leader'`；禁止构造 WorktreeInitializer。

### `@co/orchestrator`（Layer 5）

**职责**：`run.ts` 5 阶段编排、InitChecker（6 步 + 交互 + `-y` 模式）、WorktreeInitializer（名称池 + worktree 创建 + 模板播种）、ChildSupervisor（fork + 自动重启）。

### `@co/cli`（Layer 6）

**职责**：commander 入口、13 个子命令实现。CLI 输入校验通过 `@co/contracts` Zod schema 完成。

## 4. 禁止的 import 示例

| 反例 | 原因 |
|------|------|
| `@co/leader` 直接 import `node-zookeeper-client` | 应从 `@co/coordination` 注入 `ITaskQueue` |
| `@co/contracts` import `fs` | contracts 必须零副作用 |
| `@co/worker` import `@co/leader` | 同层禁止互相 import |
| `@co/runtime` import `@co/coordination` | runtime 不应知道 TaskQueue |
| `@co/cli` import `@co/leader` | CLI 通过 orchestrator 启动 Leader |

## 5. 构建与 CI 校验

每次 PR 必须通过：
1. `pnpm -r tsc --noEmit`（类型检查）
2. `pnpm depcruise`（依赖规则，`.dependency-cruiser.cjs`）
3. `check-pkg-deps.mjs`（package.json 依赖白名单）

## 6. 关键切分理由

### TaskQueue 收纳任务监视

Leader 不直接调用 ZK watch，而是通过 `ITaskQueue.watchPending(cb) / watchClaimed(cb)`。未来切换 etcd 时只需新建实现，Leader 不动。

### WorktreeInitializer 归 orchestrator

旧设计中位于 `src/worker/`，但它只在启动 Phase 2 被调用，Worker 子进程从不调用它。逻辑上属于 orchestrator。

### TUI 三段拆分

`renderer.ts`（纯函数）+ `input.ts`（键盘事件源）+ `controller.ts`（状态订阅 + 输出分发）。渲染层可独立审视，键盘层可回放测试，控制层集中副作用。
