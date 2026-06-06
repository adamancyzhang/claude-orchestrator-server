# CLI Commands for Headless Orchestration

**日期：** 2026-06-07
**状态：** 实现中

---

## Context

当前 orchestrator 只有 `run`（启动 TUI）和 `config`（显示配置）两个命令。TUI 是唯一的交互方式，无法在无 TUI 环境下进行 E2E 测试或脚本化操作。

需要设计一套 CLI 命令，使所有功能在 headless 模式下可用。

## 设计方案

### 核心思路

1. **`run --headless`** — 启动 orchestrator 但不启动 TUI，改为将状态写入 JSON 文件
2. **状态文件** — orchestrator 周期性将 `LeaderState` 序列化到 `<co-root>/state.json`
3. **命令队列** — CLI 将用户输入写入 `<co-root>/commands.jsonl`，orchestrator 监听并处理
4. **查询命令** — CLI 读取 state.json 显示 workers/tasks/events/messages

### 命令清单

```
claude-orchestrator run --headless [--state-dir <dir>]    # 启动 headless 模式
claude-orchestrator send <message> [--state-dir <dir>]    # 发送需求/任务
claude-orchestrator status [--state-dir <dir>]            # 显示完整状态
claude-orchestrator workers [--state-dir <dir>]           # 列出 workers
claude-orchestrator tasks [--state-dir <dir>]             # 列出 pending/in-progress tasks
claude-orchestrator events [--state-dir <dir>] [--tail N] # 显示事件日志
claude-orchestrator messages <worker> [--state-dir <dir>] # 显示 worker 消息
claude-orchestrator wait [--task <id>] [--timeout <s>] [--state-dir <dir>]  # 等待完成
```

### 架构设计

```
┌─────────────┐     commands.jsonl     ┌──────────────────┐
│  CLI send   │ ──────────────────────>│                  │
└─────────────┘                        │   Orchestrator   │
┌─────────────┐     state.json         │   (headless)     │
│  CLI status │ <──────────────────────│                  │
│  CLI workers│                        │  StateWriter     │
│  CLI tasks  │                        │  CommandWatcher  │
│  CLI events │                        └──────────────────┘
└─────────────┘
```

#### 1. StateWriter（新模块）

在 `@co/leader` 包中新增 `StateWriter` 类：

```typescript
class StateWriter {
  constructor(state: LeaderState, stateDir: string, leaderId: string, intervalMs?: number);
  start(): void;   // 启动定时写入
  stop(): void;    // 停止
}
```

- 每 500ms 将 `LeaderState` 序列化为 JSON 写入 `<stateDir>/state.json`
- 包含：workers, pending_tasks, in_progress_tasks, events, magic_mode, leader_id
- 原子写入（先写 .tmp 再 rename）

#### 2. CommandWatcher（新模块）

在 `@co/leader` 包中新增 `CommandWatcher` 类：

```typescript
class CommandWatcher {
  constructor(messageRouter: IMessageRouter, leaderId: InstanceId, leaderName: string, stateDir: string);
  start(): void;
  stop(): void;
}
```

- 监听 `<stateDir>/commands.jsonl` 文件变化
- 解析命令（send 类型）
- 通过 `messageRouter.send()` 发送到 leader
- 使用 fs.watch + debounce 避免重复处理

#### 3. CLI 命令实现

在 `@co/cli` 包中新增命令：

- `send` — 向 commands.jsonl 追加 `{type: "send", content: "<message>"}` 
- `status` — 读取 state.json，格式化输出
- `workers` — 读取 state.json，只显示 workers 部分
- `tasks` — 读取 state.json，显示 pending + in_progress
- `events` — 读取 state.json，显示 events（支持 --tail N）
- `messages <worker>` — 读取 state.json，显示指定 worker 的消息历史
- `wait` — 轮询 state.json 直到条件满足（task completed）

#### 4. run --headless 修改

修改 `runOrchestrator()` 支持 headless 模式：

```typescript
interface RunInput {
  // ... existing fields
  headless?: boolean;    // 不启动 TUI
  state_dir?: string;    // state.json 输出目录，默认 .claude-orchestrator/state
}
```

- 当 `headless=true` 时：
  - 不启动 TUI（已有 `deps.headless` 支持）
  - 启动 StateWriter
  - 启动 CommandWatcher
  - 将 leaderId 写入 `<stateDir>/.leader-id` 供 CLI 读取

### state.json 格式

```json
{
  "version": 1,
  "updated_at": "2026-06-07T...",
  "leader_id": "...",
  "magic_mode": false,
  "magic_max_chains": null,
  "workers": [...],
  "pending_tasks": [...],
  "in_progress_tasks": [...],
  "events": [...]
}
```

### commands.jsonl 格式

每行一个 JSON 命令：
```json
{"type":"send","content":"Implement feature X","timestamp":"..."}
```

## 任务分解

| 任务 | 负责人 | 状态 | Commit |
|------|--------|------|--------|
| 架构审查 | architect | ✅ | - |
| StateWriter 实现 | dev-1 | ✅ | 51f40c4 |
| CommandWatcher 实现 | dev-2 | ✅ | afd53ef |
| CLI 命令 | dev-3 | ✅ | 3cb1ece |
| runOrchestrator 改造 | dev-1 | ✅ | a006acf |
| StateWriter 修复 | dev-1 | ✅ | fcd0476 |
| state-utils 修复 | dev-3 | ✅ | 7b7dfe6 |
| CLI 小修复 | dev-3 | ✅ | eb5afd5 |
| CLI 测试 | dev-2 | 🔄 | - |
| 最终验证 | verifier | 🔄 | - |

## 验证方式

1. `pnpm build` 编译通过 ✅
2. `cd packages/leader && npx vitest run` 单元测试通过 ✅ (102/102)
3. `npx depcruise --config .dependency-cruiser.cjs packages/` 零违规 ✅
4. `cd packages/cli && npx vitest run` CLI 测试通过 ⏳
5. 全量测试 `pnpm test` ⏳

## 关键文件

- `packages/leader/src/state-writer.ts` — StateWriter 实现
- `packages/leader/src/command-watcher.ts` — CommandWatcher 实现
- `packages/cli/src/index.ts` — CLI 命令
- `packages/cli/src/state-utils.ts` — 共享工具函数
- `packages/orchestrator/src/run.ts` — headless 模式集成
