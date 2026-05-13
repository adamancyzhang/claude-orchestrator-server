# CLI Optimization Plan: `--append-system-prompt` + `--resume`

> **Status**:  Phase 0  ✅  |  Phase 1  ✅  |  Phase 2  🚧
>
> ✅ = Done &nbsp; 🚧 = Partial &nbsp; ❌ = Not started

相关文档：
- [`resume-session.md`](./resume-session.md) — `--resume` 优化方案：保持对话上下文传递 ✅
- [`init-checker.md`](./init-checker.md) — 交互式初始化检查器：步骤确认 + 危险操作拦截 + `-y` 记忆 ❌
- [`review-report.md`](./review-report.md) — 风险评估报告

## Scope

优化 Leader 和 Worker 中所有 Claude Code CLI 调用，利用两个原生 CLI flag 替代当前的 Node.js 端模板渲染。

---

## 设计原则 0: `execWithStreaming` 作为唯一执行入口 ✅

**已实现。** `src/utils/exec.ts` 当前仅导出 `execWithStreaming` 一个函数。`execWithTee` 和 `execAndCapture` 已移除。

实际签名 (`src/utils/exec.ts:18-26`)：

```typescript
export async function execWithStreaming(
  command: string,
  message: string,
  logPath: string,
  systemPrompt?: string,
  onChunk?: (line: string) => void,
  cwd?: string,
  quiet?: boolean,
): Promise<{ code: number; sessionId?: string }>
```

关键设计：
- 始终逐行解析 JSON stdout，提取 `session_id`
- 始终同步写日志（内置 `tee -a`）
- `systemPrompt` 可选，传入时通过 `--append-system-prompt` 注入
- `onChunk` 可选，TUI streaming 时传入

---

## 前置条件：`--output-format stream-json --verbose` 强制追加 ✅

**已实现。** `src/utils/exec.ts:31` 在所有 shell 命令中强制追加 `--output-format stream-json --verbose`。`config.ts` 的默认 `cliCommand` 已清理，不再包含重复 flag。

---

## 当前痛点

### 1. 模板渲染在 Node.js 侧做纯字符串操作 ✅ 已解决

`TemplateEngine.render()` 曾经做了两件不相关的事：Business card 注入 + 任务变量替换。Business card 属于 system prompt 层，不恰当地混在 user prompt 中。

**当前实现已分离：**
- **身份信息** → `ClaudeRunner.buildIdentityPrompt()` 生成 system prompt 文本 → `execWithStreaming` 通过 `--append-system-prompt` 注入
- **任务变量** → `TemplateEngine.render()` 仅做 `{{var}}` 替换 → 作为 `-p` 内容传入

详见下方"方案 A"。

### 2. CLI 命令拼接脆弱 ✅ 已缓解

System prompt 分离后，`-p` 内容大幅缩短（仅含任务变量，不再包含完整身份信息），shell 转义风险降低。`escapeShell()` 函数同时对 `-p` 和 `--append-system-prompt` 的值做单引号转义。

### 3. `.gitignore` 忽略规则过于宽泛 ❌ 待修复

当前 `.gitignore` 包含 `.claude-orchestrator/` 全局忽略规则。Worker 在 `.claude-orchestrator/docs/{name}/YYYY-MM-DD/` 下生成的工作产物会被 `git add -A` 跳过，`CommitChecker` 无法提交。

详见下方"约束: `.gitignore`"。

---

## 优化方案

### 方案 A: `--append-system-prompt` — 身份注入分离 ✅

**已实现。** 身份信息（name, role, instance_id 等）通过 `--append-system-prompt` 注入 system prompt，任务内容通过 `-p` 注入 user prompt。

**当前 prompt 结构**：

```
--append-system-prompt:
  ## Worker Identity
  You are **Tom**, a **planner** in the multi-agent orchestration system.
  - Name: Tom
  - Role: planner
  - Worktree: /path/to/worktree
  - Branch: claude-orchestrator/Tom-workspace
  - Instance: abc123

-p:
  [模板内容 with {{var}} 替换]
```

**实际实现涉及文件**：

| 文件 | 实现 |
|------|------|
| `src/executor/runner.ts:69-79` | `buildIdentityPrompt()` 从 `this.identity` 构建 system prompt |
| `src/executor/runner.ts:81-102` | `run()` 接受 `opts.systemPrompt`，传入 `execWithStreaming` |
| `src/utils/exec.ts:32-34` | 将 `systemPrompt` 拼入 `--append-system-prompt` flag |
| `src/executor/template.ts:39-44` | `render()` 仅做 `{{var}}` 替换，不拼接 business card |
| `src/worker/watcher.ts:110-111` | 分离 identity 和 task vars，分别传入 |
| `src/leader/chain-router.ts:94-96` | 同上 |

### 方案 B: 模板职责简化 ✅

**已实现。** `TemplateEngine` 仅负责：
1. 加载模板文件 (`loadAll()`) — 从 `templates/agents/` 加载
2. 渲染变量 (`render()`) — `{{key}}` 替换
3. 按需加载文件 (`loadFile()`) — 用于 `worker-evaluate.md`

当前 `TemplateEngine` 约 46 行 (`src/executor/template.ts`)，已删除 `BUSINESS_CARD` 常量和拼接逻辑。

---

### 约束: `.gitignore` 不得忽略 Worker 工作产物 ✅

**已实现。** `.gitignore` 使用 negation 规则精确控制：

**方案**：使用 negation 规则，只忽略运行时子目录：

```diff
- .claude-orchestrator/
+ .claude-orchestrator/*
+ !.claude-orchestrator/docs/
```

| 路径 | 是否忽略 | 原因 |
|------|----------|------|
| `.claude-orchestrator/config.json` | 忽略 | 含 instance_id 等敏感信息 |
| `.claude-orchestrator/docs/` | 不忽略 | Worker 工作产物，需要 commit |
| `.claude-orchestrator/sessions/` | 忽略 | Leader 运行时日志，临时数据 |
| `.claude-orchestrator/worktree/` | 忽略 | git worktree 各自独立仓库，主仓库不应跟踪 |

---

## 实施步骤

### Phase 0: 统一执行入口 + 强制 flag ✅

1. ✅ **合并 `exec.ts` 为一个函数**：`execWithTee` 和 `execAndCapture` 已删除
2. ✅ **强制追加 flag**：`--output-format stream-json --verbose` 在 `execWithStreaming` 中强制追加
3. ✅ **修改 `runner.ts`**：`ClaudeRunner.run()` 始终调用 `execWithStreaming`，`onChunk` 为可选参数
4. ✅ **修改 `config.ts`**：从默认 `cliCommand` 中移除 `--output-format stream-json`

### Phase 1: `--append-system-prompt` ✅

1. ✅ **扩展 `execWithStreaming`** (`src/utils/exec.ts`)：`systemPrompt` 参数 + shell 转义
2. ✅ **扩展 `ClaudeRunner`** (`src/executor/runner.ts`)：`buildIdentityPrompt()` + `run()` 接受 `systemPrompt`
3. ✅ **简化 `TemplateEngine.render()`** (`src/executor/template.ts`)：删除 business card 拼接，只做 `{{var}}` 替换
4. ✅ **更新调用方** (`watcher.ts`, `chain-router.ts`)：分离 identity vars 和 task vars

### Phase 2: 清理 + `.gitignore` ✅

1. ✅ **`.gitignore` negation 规则**：替换 `.claude-orchestrator/` 为 `.claude-orchestrator/*` + `!.claude-orchestrator/docs/`
2. ✅ **`TemplateEngine` 简化**：已从 ~70 行简化为 ~46 行
3. ✅ **模板角色指令迁移**：identity 已移至 system prompt，模板仅含任务指令

---

## 待办项汇总

| 项目 | 优先级 | 状态 |
|------|--------|------|
| `config.ts` 默认 `cliCommand` 移除 `--output-format stream-json` | 低 | ✅ |
| `.gitignore` negation 规则 | 中 | ✅ |
| `extractJson` 去重（ChainRouter 私有方法 vs evaluator 内联逻辑） | 低 | ✅ (see `src/utils/json.ts`) |
| InitChecker + `-y` 交互式初始化 | 中 | ✅ (see `src/orchestrator/init-checker.ts`) |

---

## 收益总结

| 指标 | 优化前 | 优化后 | 状态 |
|------|--------|--------|------|
| 身份注入方式 | 拼入用户 prompt (`-p`) | System prompt (`--append-system-prompt`) | ✅ |
| System/User prompt 分离 | 不分离，全部在 `-p` | 分离，支持 system prompt 缓存 | ✅ |
| `TemplateEngine` 代码量 | ~70 行 | ~46 行 | ✅ |
| Worker 工作产物 git 追踪 | 被 `.gitignore` 阻止 | 正常追踪和 commit | ❌ |
| Shell 转义风险 | 整个 prompt 在单引号中 | `-p` 内容缩短，风险降低 | ✅ |
| Evaluator 会话连续性 | 每次冷启动 | `--resume` 传递完整上下文 | ✅ |
| 统一执行入口 | 3 个函数 (`execWithTee`, `execWithStreaming`, `execAndCapture`) | 1 个函数 (`execWithStreaming`) | ✅ |
