# Package Layout — v0.5 多包工程分层规范

> **文档定位**：本文是 v0.5 的"代码归属权威"。回答的唯一问题是：**新代码该放在哪个包？**
> 其他三篇横切文档对应关系：[`contracts.md`](contracts.md) 定义类型契约；[`protocol.md`](protocol.md) 定义 wire-format；[`error-and-recovery.md`](error-and-recovery.md) 定义错误与恢复模型。

---

## 1. 分层哲学

v0.5 采用 **pnpm workspaces** + **7 层严格单向依赖**。第 N 层只能 `import` 严格低层；同层互不引用；上层注入接口，下层提供实现。

设计目标按优先级：

1. **协议优先**（Contracts first）—— 类型、Schema、接口先于实现。每个包都从 `@co/contracts` 取约束。
2. **横向解耦** —— Leader 与 Worker 同层，互不感知，只通过 ZK 与共享类型对话。
3. **可替换实现** —— ZK、Runner、Hook 都先以接口注入，再由具体包实现，便于未来切换 etcd / Bedrock-cli 等。
4. **可读路径** —— 任何模块的依赖只指向"下面"，阅读代码时不会在同层反复跳。

> 反模式："`@co/leader` 直接 `import { ZooKeeperClient } from 'node-zookeeper-client'`" —— Leader 不应感知 ZK 实现细节，只应依赖 `ITaskQueue / IMessageRouter / IInstanceRegistry`。

---

## 2. 包清单与依赖矩阵

| 包 | 层 | 职责 | 允许依赖 |
|----|----|------|----------|
| `@co/contracts` | 0 | 纯类型、Zod schema、接口声明、纯路径函数、错误类、角色权重表 | `zod`（peer） |
| `@co/infra` | 1 | `IZkClient` 实现、Logger、exec 工具、fs 助手、Config loader | `contracts`、`node-zookeeper-client` |
| `@co/runtime` | 2 | `IClaudeRunner` / `ITemplateEngine` / `IHookEngine` 实现 | `contracts`、`infra` |
| `@co/coordination` | 3 | `ITaskQueue` / `IMessageRouter` / `IInstanceRegistry` 实现 | `contracts`、`infra` |
| `@co/leader` | 4a | EventBus、State、ChainRouter、MergeValidator、Recovery、Monitor、TaskOrchestrator、Watcher、StreamTailer、TUI | `contracts`、`runtime`、`coordination` |
| `@co/worker` | 4b | WorkerWatcher、SelfEvaluator、CommitChecker | `contracts`、`runtime`、`coordination` |
| `@co/orchestrator` | 5 | `run.ts`（5 阶段）、InitChecker、WorktreeInitializer、子进程监督 | `contracts`、`infra`、`runtime`、`coordination`、`leader`、`worker` |
| `@co/cli` | 6 | commander 入口 + 13 个子命令 | `contracts`、`infra`、`coordination`、`orchestrator` |

**矩阵补充规则**：

- 第 4a (`leader`) 与 第 4b (`worker`) 同层，**互不依赖**。任何"Leader 想知道 Worker 当前进度"的需求都必须经由 ZK 投递（`/instances`、`/messages`、`/tasks/claimed`）。
- 第 5 `orchestrator` 是唯一可以同时引用 `leader` 与 `worker` 的包，因为它负责进程启动、子进程 fork、关停。
- 第 6 `cli` 不直接引用 `leader` / `worker`，所有运行时启动都通过 `orchestrator` 暴露的入口完成。

---

## 3. 各包职责与禁区

### `@co/contracts`（Layer 0）

**职责**：

- 全部 Branded ID 类型（`InstanceId / TaskId / MessageId / ChainId / SessionId / WorktreeName / ProjectId / ZkPath`）。
- 全部 Zod schema 与对应 TypeScript 类型（见 [`contracts.md`](contracts.md) §3）。
- 全部跨层接口（`IZkClient / ITaskQueue / IMessageRouter / IInstanceRegistry / IClaudeRunner / ITemplateEngine / IHookEngine / IEventBus / ILogger / ILeaderStateView`）。
- 纯路径函数（`zkPaths` / `cachePaths`），**不读盘、不连接 ZK**。
- 错误类层级（`CoError` + 10 个 typed subclass）。
- 角色权重表 `ROLE_WEIGHTS`、Hook 事件枚举、协议版本常量 `PROTOCOL_VERSION`。

**禁区**：

- 禁止 `import fs / path / child_process / node-zookeeper-client`。
- 禁止包含任何运行时副作用（顶层语句仅声明、无 `mkdirSync` / `console.log`）。
- 禁止使用 `console.*`。
- `package.json` 的 `dependencies` 必须为空，只允许 `peerDependencies: { zod: "^3.x" }`。

### `@co/infra`（Layer 1）

**职责**：

- `ZkClient` —— `IZkClient` 的具体实现（基于 `node-zookeeper-client`），含自动重连、`mkdirp`、`persistentChildWatch` 等。
- `Logger` —— `ILogger` 的具体实现，支持 `--debug` 模式与 `child(name)` 命名空间。
- `exec` 工具 —— `execWithTee` / `execWithStreaming` / `execAndCapture`。
- `fs` 助手 —— `readJson` / `writeJsonAtomic` / `ensureDir`。
- `ConfigLoader` —— 实现 `@co/contracts` 中声明的层级合并语义（global → project → worktree → env → CLI flags）。

**禁区**：

- 禁止 `import` 任何 Layer ≥2 的包。
- 禁止持有领域状态（Task / Message / Chain），它们都从更上层穿入。

### `@co/runtime`（Layer 2）

**职责**：

- `TemplateEngine` —— 仅 `{{var}}` 变量替换；身份卡片注入由 `ClaudeRunner` 完成，**不混入**模板渲染。
- `ClaudeRunner` —— 封装 `claude -p` 执行；含 `--append-system-prompt` 身份注入、`--resume` 会话续接、`--fork-session` 评估重试、`--output-format stream-json --verbose` 流式日志、session id 提取。
- `HookEngine` —— 实现闭合 `HookEvent` 枚举触发；以 fire-and-forget 子进程方式运行 shell；Hook 失败不影响主流程（见 [`error-and-recovery.md`](error-and-recovery.md) §5）。

**禁区**：

- 禁止读 ZK；所有 ZK 操作位于 `@co/coordination`。
- 禁止知晓 `TaskLink / ChainDef / EvalDecision` 等业务语义；这些通过参数传入。

### `@co/coordination`（Layer 3）

**职责**：

- `TaskQueue` —— `push / claim / complete / block / fail / retry / list`；`claim` 内部使用 `ROLE_WEIGHTS` 排序候选；提供 `watchPending / watchClaimed / getPending` 给 Leader 的 TaskOrchestrator。
- `MessageRouter` —— `send / poll / wait / dismiss`；含单播与广播。
- `InstanceRegistry` —— `register / unregister / heartbeat / listInstances / watchInstances`，对应 `/instances/{id}` EPHEMERAL 节点。

**禁区**：

- 不解释 EvalDecision、不调用 claude-cli。它只负责"任务 / 消息 / 注册"三种 ZK 原语的封装。
- 不直接构造路径字符串；所有路径都从 `@co/contracts/paths/zkPaths` 取。

### `@co/leader`（Layer 4a）

**职责**：

- `LeaderEventBus` —— 实现 `IEventBus<LeaderEvent>`。
- `LeaderState` —— 实现 `ILeaderStateView` 的可变内部版本；通过 `.apply(event)` 归并事件。
- `ChainRouter` —— 机械路由：EvalDecision / ChainDef / 用户输入 三类分支。
- `MergeValidator` —— 调用 claude-cli `worker-merge-decision.md` 模板做合并裁决；冲突自动 `git merge --abort` 并返回 `review_first`。
- `Recovery` —— 启动时一次性扫描 `/tasks/claimed` 中"无对应 instance"的孤儿，按 `retry_count` 重新入队或归档。
- `WorkerMonitor` —— 监听 `/instances`，发出 `worker_joined / worker_left / worker_status_changed`。
- `TaskOrchestrator` —— 监听 `/tasks/pending` 与 `/tasks/claimed`，发出 `task_created / task_claimed / task_completed`。
- `LeaderWatcher` —— 监听 `/messages/{leader_id}`，调用 `ChainRouter.route`。
- `StreamTailer` —— 轮询 Worker 日志文件，发出 `stream_chunk` 事件。
- `tui/` —— 三段拆分：`renderer.ts`（纯函数）+ `input.ts`（键盘事件源）+ `controller.ts`（状态订阅 + 输出分发）+ `index.ts`（barrel）。

**禁区**：

- 禁止 `import '@co/worker'`。
- 禁止直接 `import` `node-zookeeper-client`；所有 ZK 操作走 `@co/coordination` 或 `@co/contracts/interfaces`。
- TUI `renderer.ts` 内禁止任何副作用（包括 `process.stdout.write`），输出由 `controller.ts` 注入的 `sink` 完成。

### `@co/worker`（Layer 4b）

**职责**：

- `WorkerWatcher` —— 监听 `/messages/{instance_id}`，按 8 步流水线处理（解析 → 模板 → 渲染 → 执行 → 提交 → 评估 → 上报）。
- `SelfEvaluator` —— 调用 `worker-evaluate.md` + `--fork-session`，输出 `EvalDecision` JSON；格式错误重试最多 3 次。
- `CommitChecker` —— 调用 `worker-commit-message.md` + `--resume` 生成 commit message 并 `git commit`；失败回退到固定文案。

**禁区**：

- 禁止 `import '@co/leader'`。
- 禁止构造 `WorktreeInitializer`；Worker 子进程只消费 `ChildConfig`。
- 禁止读 `/leader` 节点的内容；Worker 不需要感知 Leader 实例 id。

### `@co/orchestrator`（Layer 5）

**职责**：

- `run.ts` —— 5 阶段：(1) `InitChecker` → (2) `WorktreeInitializer` → (3) `Leader.start()` → (4) `fork` N Workers → (5) `handleShutdown`。
- `InitChecker` —— 6 步交互式初始化，含 `init_status` 历史记忆与 `-y` 自动模式。
- `WorktreeInitializer` —— 名称池分配、git worktree 创建、role 分配、模板与 skill 播种。**v0.5 关键迁移**：从 `src/worker/` 迁入此包。
- `ChildSupervisor` —— `fork(child.js)`、`on('exit', restart)`（最多 3 次）、`process.kill(ppid, 0)` 父进程存活检测。

**禁区**：

- `orchestrator` 是唯一可以同时 `import` `@co/leader` 与 `@co/worker` 的包，但任何在 `leader` 或 `worker` 内部应该做的事都不应该回流到这里。

### `@co/cli`（Layer 6）

**职责**：

- commander 入口、13 个子命令实现（`run / unregister / config / send-message / poll-message / delete-message / push-task / poll-task / claim-task / complete-task / task-block / task-fail / task-retry`）。
- CLI 输入校验通过 `@co/contracts` 的 Zod schema 完成；错误统一捕获并按 `error-and-recovery.md` §1 的错误码格式输出。

**禁区**：

- 禁止直接调用 `@co/leader` / `@co/worker`；所有运行时启动通过 `@co/orchestrator` 暴露的入口（`runOrchestrator` 等）。

---

## 4. 禁止的 import 示例

| 反例 | 原因 |
|------|------|
| `// @co/leader/chain-router.ts`<br>`import { Client } from 'node-zookeeper-client';` | `@co/leader` 不应感知 ZK 实现；应从 `@co/coordination` 注入 `ITaskQueue` |
| `// @co/contracts/instance.ts`<br>`import fs from 'fs';` | `@co/contracts` 必须零副作用 |
| `// @co/worker/watcher.ts`<br>`import { ChainRouter } from '@co/leader';` | 同层禁止互相 import；Worker 通过 ZK 与 Leader 通信 |
| `// @co/runtime/runner.ts`<br>`import { TaskQueue } from '@co/coordination';` | 上层依赖下层规则；runtime 不应知道 TaskQueue |
| `// @co/cli/index.ts`<br>`import { LeaderTui } from '@co/leader';` | CLI 通过 orchestrator 启动 Leader |
| `// @co/orchestrator/run.ts`<br>`import { createTui } from '../../leader/tui/renderer';` | 跨包必须走 package 名 + barrel export，不允许深路径相对 import |

---

## 5. `dependency-cruiser` 规则草案

`.dependency-cruiser.cjs`（每个规则违反即 CI 失败）：

```js
module.exports = {
  forbidden: [
    {
      name: 'contracts-must-be-pure',
      from: { path: '^packages/contracts/' },
      to: { path: '^node_modules/(?!zod/)' },
      severity: 'error',
    },
    {
      name: 'infra-only-zk-and-contracts',
      from: { path: '^packages/infra/' },
      to: { path: '^packages/(runtime|coordination|leader|worker|orchestrator|cli)/' },
      severity: 'error',
    },
    {
      name: 'runtime-no-zk',
      from: { path: '^packages/runtime/' },
      to: { path: 'node-zookeeper-client' },
      severity: 'error',
    },
    {
      name: 'coordination-must-not-touch-business',
      from: { path: '^packages/coordination/' },
      to: { path: '^packages/(runtime|leader|worker|orchestrator|cli)/' },
      severity: 'error',
    },
    {
      name: 'leader-worker-isolation',
      from: { path: '^packages/leader/' },
      to: { path: '^packages/worker/' },
      severity: 'error',
    },
    {
      name: 'worker-leader-isolation',
      from: { path: '^packages/worker/' },
      to: { path: '^packages/leader/' },
      severity: 'error',
    },
    {
      name: 'cli-must-not-bypass-orchestrator',
      from: { path: '^packages/cli/' },
      to: { path: '^packages/(leader|worker)/' },
      severity: 'error',
    },
    {
      name: 'no-deep-cross-package-import',
      from: { path: '^packages/' },
      to: {
        path: '^packages/[^/]+/(src|dist)/[^/]+/',
        pathNot: '^packages/([^/]+)/(src|dist)/index\\.(ts|js)$',
      },
      severity: 'error',
      comment: '跨包必须 import 自 package barrel；禁止深路径相对 import',
    },
  ],
};
```

---

## 6. 构建与 CI 校验

每次 PR 必须通过以下三项：

1. **类型检查**：`pnpm -r tsc --noEmit`（项目 references 模式，按拓扑顺序检查）。
2. **依赖规则**：`pnpm depcruise --config .dependency-cruiser.cjs packages/`。
3. **package.json 依赖白名单**：`pnpm -r exec node scripts/check-pkg-deps.mjs` —— 校验每个 `package.json` 的 `dependencies` 不含本包"允许依赖"白名单之外的条目（白名单与本文表 §2 一一对应）。

不要求 vitest 通过，因为 v0.5 文档阶段不强制运行时测试（详见用户在规划阶段的选择"不考虑测试便捷性，合理设计入参和出参，保证协议质量和代码质量"）。

---

## 7. 关键切分理由

### 7.1 `TaskQueue` 收纳任务监视（而不是把 `IZkClient` 透给 Leader）

旧设计中 `TaskOrchestrator`（Leader 子模块）直接调用 `zk.watchPendingTasks / watchClaimedTasks`，让 Leader 间接依赖 ZK 实现细节。v0.5 改为 `ITaskQueue.watchPending(cb) / watchClaimed(cb) / getPending(id)`，让 Leader 完全脱离 ZK 原语。好处：

- 未来切换 etcd / consul 时，只需要新建一个 `EtcdTaskQueue` 实现 `ITaskQueue`，Leader 不动。
- 协议合并：Watch 重新挂载、序列号解析、JSON 反序列化都收敛到 `@co/coordination` 一处。

### 7.2 `WorktreeInitializer` 归 orchestrator

`worktree-initializer.ts` 在 v0.4 位于 `src/worker/`，但它只在启动 Phase 2 被调用，**Worker 子进程从不调用它**。逻辑上属于 orchestrator 责任：

- 名称池分配（全局视角，跨 Worker 协调）。
- git worktree 创建（一次性、不可重入失败后的修复逻辑）。
- 模板与 skill 播种（仅启动时）。

Worker 子进程只读取 `ChildConfig` 中的 `name / role / worktreePath / branch / instanceId`，从不再调用任何 worktree 创建代码。

### 7.3 TUI 三段拆分

`tui.ts` 在 v0.4 是一个集渲染、键盘、订阅、分发于一身的大文件。v0.5 按"纯函数 → 事件源 → 状态接线"三段拆：

- `tui/renderer.ts`：导出 `renderTeam(state): string` / `renderEventLog(state): string` / `renderInput(state): string` / `composeFrame(state): string`。**纯函数**，给定 state 必返回相同字符串。
- `tui/input.ts`：raw-mode 键盘读取，向上发 `TuiInput`（discriminated union：`char / enter / tab / shift-tab / escape / backspace / digit`）。
- `tui/controller.ts`：唯一持有可变 `selectedWorkerIndex` 与 stdin sink 的部件。订阅 `IEventBus<LeaderEvent>` + `TuiInput`，调用 `IMessageRouter.send` 发出消息。**唯一**与 `@co/coordination` 交互的 TUI 部件。

好处：

- 渲染层可独立审视（输入 state，输出字符串）；视觉调整不再触碰订阅与 IO。
- 键盘层可在不启动 Leader 的情况下回放。
- 控制层是唯一带副作用的小片段，把"何时发消息、何时切换 Worker"集中在一处。

---

## 8. 从单包 → 多包迁移 Checklist

为后续 v0.5 代码落地准备。本次文档阶段不执行；列出供下一迭代直接对照：

1. **新增 `pnpm-workspace.yaml`**：
   ```yaml
   packages:
     - "packages/*"
   ```
2. **建立 `packages/contracts/`**：
   - 从 `src/models/schemas.ts`、`src/types/*.ts`、`src/zk/paths.ts` 抽取类型与 Zod schema；
   - 新增 `ids.ts`（branded IDs）、`enums.ts`、`errors.ts`、`logging.ts`、`hooks.ts`、`roleWeights.ts`、`protocol.ts`、`paths/zkPaths.ts`、`paths/cachePaths.ts`、`interfaces/*.ts`；
   - `package.json` 中只声明 `peerDependencies: { zod }`。
3. **建立 `packages/infra/`**：
   - 实现 `IZkClient`（封装 `node-zookeeper-client`）；
   - 迁入 `src/utils/exec.ts` / `logger.ts` / `console-capture.ts` / `output.ts`；
   - 实现 `ConfigLoader`（按 contracts 中声明的合并语义）。
4. **建立 `packages/runtime/`**：
   - 迁入 `src/executor/runner.ts` / `template.ts`、`src/hooks/engine.ts`。
5. **建立 `packages/coordination/`**：
   - 迁入 `src/modules/task-queue.ts` / `message-router.ts` / `registry.ts`；
   - **新增**：`ITaskQueue.watchPending / watchClaimed / getPending`，把这些方法从 `ZkClient` 上挪到 `TaskQueue`。
6. **建立 `packages/leader/`**：
   - 迁入 `src/leader/*`，调整 `TaskOrchestrator` 改用 `ITaskQueue.watch*`；
   - 把 `tui.ts` 拆为 `tui/renderer.ts / input.ts / controller.ts / index.ts`。
7. **建立 `packages/worker/`**：
   - 迁入 `src/worker/{child,child-runner,watcher,evaluator,commit-checker}.ts`；
   - **不**迁入 `worktree-initializer.ts`（去 orchestrator）。
8. **建立 `packages/orchestrator/`**：
   - 迁入 `src/orchestrator/{run,init-checker}.ts`；
   - 从 worker 迁入 `worktree-initializer.ts`；
   - 新增 `ChildSupervisor`。
9. **建立 `packages/cli/`**：
   - 迁入 `src/index.ts` 与 `bin/`；
   - 所有命令调用走 `@co/orchestrator` 或 `@co/coordination` 暴露的入口。
10. **`tsconfig` references**：根目录 `tsconfig.base.json` 设公共选项；每个 `packages/*/tsconfig.json` 声明 `references` 指向其允许依赖。
11. **CI**：
    - `pnpm install` → `pnpm -r tsc --noEmit` → `pnpm depcruise --config .dependency-cruiser.cjs packages/` → `pnpm -r exec node scripts/check-pkg-deps.mjs`。
12. **`bin/claude-orchestrator`**：脚本入口指向 `packages/cli/dist/index.js`；其余包通过 `pnpm exec` 间接构建。

迁移完成的标志：**`packages/contracts/package.json` 的 `dependencies` 段为空，且 `pnpm depcruise` 0 警告 0 错误。**

---

## 9. 与其他文档的关系

| 文档 | 关系 |
|------|------|
| [`contracts.md`](contracts.md) | 本文是包结构；`contracts.md` 是类型 / Schema / 接口细节。 |
| [`protocol.md`](protocol.md) | 本文不写 wire-format；`protocol.md` 写 wire-format。 |
| [`error-and-recovery.md`](error-and-recovery.md) | 本文不写错误处理；本文只规定错误类生在哪个包。 |
| [`architecture.md`](architecture.md) | 本文给"分层"，`architecture.md` 给"组件交互"。 |
| [`orchestration.md`](orchestration.md) | 本文给"包归属"，`orchestration.md` 给"启动时序"。 |
