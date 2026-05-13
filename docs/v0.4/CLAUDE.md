# v0.4 变更摘要

## 核心变更

v0.4 将 `setup`、`leader`、`register` 三个命令合并为单一 `run` 命令，一步完成环境配置、TUI 启动和多 Worker 自动注册。Worker 使用拟人化名称（Tom, Jerry, Lucy 等），在独立的 git worktree 中运行。TemplateEngine 统一注入 Worker 名片到每条 prompt。TUI 新增 Worker Messages 面板，实时展示每个 Worker 当前处理的消息。

## 命令对比

| v0.3 | v0.4 |
|------|------|
| `claude-orchestrator setup --name Tom --role planner` | 自动检测 |
| `claude-orchestrator leader --name Tom` | 合并在 |
| `claude-orchestrator register` | 同一命令 |
| 三个命令分别执行 | `claude-orchestrator run --worker 5` |

## v0.3 → v0.4 关键差异

| 维度 | v0.3 | v0.4 |
|------|------|------|
| 启动命令 | setup + leader + register | `run --worker 5` |
| Worker 命名 | 手动配置，任意格式 | 拟人化名称：Tom, Jerry, Lucy, Thomas, Jack...（内置 20 个，不够则 claude-cli 生成） |
| 角色分配 | 手动指定 | 自动按优先级分配，名称与角色独立 |
| 工作目录 | `process.cwd()` | `./.claude-orchestrator/worktree/${name}` |
| 分支名 | 无 | `claude-orchestrator/${name}-workspace` |
| Worktree 目录名 | — | 直接使用 Worker 名称（Tom → worktree/Tom） |
| 配置持久化 | 仅项目级 name/role | worktree 段落记录所有 Worker 的 name/role/path/branch/instance_id |
| 幂等性 | 无 | 扫描已有 worktree 和分支，避免名称/路径/分支冲突 |
| Prompt 名片 | 无 | TemplateEngine 统一注入 "You are Tom, a planner..." |
| Git 提交 | 手动 | claude-cli 生成 commit message 自动提交 |
| Leader 合并 | 无 | 交叉验证并自动合并 worker 分支 |
| TUI 工作区 | 无 worktree 信息 | 展示 Name/Role/Worktree/Branch/PID |
| TUI 消息 | 仅事件日志 | Worker Messages 面板，Tab 切换选中 Worker，展示当前任务全文 + 历史消息 |

## 新 CLI

```bash
claude-orchestrator run --worker 5 [-z <zkHosts>] [-d]
```

## 启动流程

```
run --worker 5
  → 阶段 1: 环境自检 (缺失则自动补全)
  → 阶段 2: generateWorkerAssignment(5) → 名称+角色配对 + worktree 创建 + 配置持久化
            (5个: Tom(planner), Jerry(builder), Lucy(verifier), Thomas(reviewer), Jack(accepter))
  → 阶段 3: 启动 Leader TUI (含 Worker Messages 面板)
  → 阶段 4: fork 5 个子进程 (各自 chdir 到 worktree)
  → 阶段 5: 阻塞等待 SIGINT
```

## Worker Messages 面板（可切换）

TUI 新增面板，每次展示**一个选中 Worker** 的详细消息。通过 `Tab` / `Shift+Tab` / `1-9` 数字键切换选中的 Worker。TEAM 面板中被选中的 Worker 以 `>` 高亮标记。

```
WORKER MESSAGES — Tom (planner)           [Tab/Shift+Tab 切换 Worker]
─────────────────────────────────────────────────────────────────────
◆ 当前任务 (12:03:45)  [decompose]
  "Decompose user authentication module into actionable chain
   tasks. The requirements include login, registration,..."

历史消息:
  12:01:22 [decompose]  "Analyze project structure and identify..."
  11:58:05 [decompose]  "Review initial requirements for the..."
```

- **当前任务段**：消息全文（自动换行），link 标签，时间戳
- **历史消息段**：最近 5 条消息，每条一行摘要
- **固定高度 ~12 行**：不随 Worker 数量增长，Worker 数量多时不会挤占其他面板空间

## 新增模块（6 个文件）

- `src/orchestrator/run.ts` — 统一入口，串联五个阶段
- `src/worker/worktree-initializer.ts` — 拟人化名称生成（+ claude-cli 补充）、角色分配、worktree 创建、唯一性检查、配置持久化
- `src/worker/child.ts` — 子进程入口
- `src/worker/child-runner.ts` — 子进程核心逻辑（chdir → ZK → WorkerWatcher）
- `src/worker/commit-checker.ts` — git status 检查 + claude-cli 生成 commit message + 自动提交
- `src/leader/merge-validator.ts` — 交叉验证 + claude-cli 决策 merge/skip/review_first

## 修改模块（11 个文件）

- `src/index.ts` — 移除 setup/leader/register，新增 run 命令
- `src/cli/commands.ts` — 移除 cmdSetup/cmdRegister 导出
- `src/executor/template.ts` — render() 统一注入 Worker 名片
- `src/worker/watcher.ts` — 构造参数增加 worktreePath/worktreeBranch，集成 CommitChecker
- `src/leader/event-bus.ts` — 新增 `worker_message_received` 事件类型
- `src/leader/state.ts` — WorkerInfo 增加 worktree + message 字段；apply() 处理新事件
- `src/leader/tui.ts` — Team 面板增加 Worktree/Branch/PID 列；新增 Worker Messages 面板
- `src/leader/watcher.ts` — 处理消息时发出 worker_message_received 事件
- `src/leader/chain-router.ts` — 集成 MergeValidator
- `src/leader/index.ts` — 接受 worktreeConfigs，初始化 MergeValidator
- `src/models/schemas.ts` — InstanceSchema/MessageSchema 增加 worktree/commit/pid 字段

## 关键设计决策

1. **三合一命令**：`run --worker N` 替代 setup + leader + register

2. **拟人化命名**：内置 20 个人名（Tom, Jerry, Lucy...），不够则 claude-cli 生成；名称与角色解耦

3. **名称唯一性三级检查**：扫描已有 worktree 目录 + 已有分支 + config.json 记录，确保不冲突

4. **名片统一注入**：TemplateEngine.render() 自动插入 Worker 身份信息，所有 prompt 都携带名片

5. **可切换 Worker Messages 面板**：Tab/Shift+Tab 切换选中 Worker，面板展示选中 Worker 的消息全文 + 历史。固定高度 12 行，Worker 数量多时不会挤占其他面板

6. **Leader 驱动合并**：Worker 只做本地 commit，Leader 通过 claude-cli 决策 merge/skip/review_first

## 实现顺序

1. `run.ts` — 顶层编排框架
2. `worktree-initializer.ts` — 拟人化名称 + worktree 创建
3. `template.ts` — 名片注入
4. `child.ts` + `child-runner.ts` — 子进程框架
5. `index.ts` — 命令合并
6. TUI — worktree 信息 + 可切换 Worker Messages 面板（键盘交互）
7. `commit-checker.ts` — 自动提交
8. `merge-validator.ts` — 交叉验证合并
9. 集成测试
