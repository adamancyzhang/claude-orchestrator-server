# Configuration & CLI — v0.6

> **文档定位**：配置分层、CLI 命令参考、启动流程。
> 类型定义见 `contracts.md`；启动编排细节见 `core/` 目录。

## 1. 配置系统

### 1.1 文件位置

| 层级 | 路径 | 用途 |
|------|------|------|
| 全局 | `~/.claude-orchestrator/config.json` | ZK、cache_dir、claude-cli 命令、hooks、init_status |
| 项目根 | `<cwd>/.claude-orchestrator/config.json` | worktree 段落（所有 Worker 的 name/role/path/branch/instance_id） |
| worktree | `<worktree>/.claude-orchestrator/config.json` | 单 Worker 的 name / role / instance_id |

### 1.2 合并优先级

```
CLI 参数 / 环境变量          ← 最高
    ↑
Worktree 配置
    ↑
项目根配置
    ↑
全局配置 (~/.claude-orchestrator/config.json)
    ↑
默认值                       ← 最低
```

ZK 连接地址解析顺序：`-z` CLI flag → `ZK_HOSTS` 环境变量 → 全局配置 → `127.0.0.1:2181`

### 1.3 全局配置

```json
{
  "zookeeper": {
    "url": "127.0.0.1:2181",
    "root_path": "/claude-orchestrator",
    "auth": null
  },
  "cache_dir": ".claude-orchestrator/sessions",
  "commands": {
    "claude-cli": "claude --dangerously-skip-permissions --permission-mode dontAsk"
  },
  "hooks": {
    "leader_message_start": null,
    "leader_message_end": null,
    "worker_message_start": null,
    "worker_message_end": null
  },
  "init_status": {}
}
```

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `zookeeper.url` | string | `"127.0.0.1:2181"` | ZK 连接地址 |
| `zookeeper.root_path` | string | `"/claude-orchestrator"` | ZK 根节点 |
| `zookeeper.auth` | string\|null | `null` | ZK 认证 |
| `cache_dir` | string | `".claude-orchestrator/sessions"` | 共享日志目录 |
| `commands.claude-cli` | string | `"claude --dangerously-skip-permissions --permission-mode dontAsk"` | claude CLI 命令 |
| `hooks.*` | string\|null | `null` | 生命周期 shell 脚本 |
| `init_status` | object | `{}` | InitChecker 历史决策 |

### 1.4 项目根配置

```json
{
  "worktree": {
    "Tom":    { "name": "Tom",    "role": "planner",  "path": "...", "branch": "claude-orchestrator/Tom-workspace",    "instance_id": "..." },
    "Jerry":  { "name": "Jerry",  "role": "builder",  "path": "...", "branch": "claude-orchestrator/Jerry-workspace",  "instance_id": "..." },
    "Lucy":   { "name": "Lucy",   "role": "verifier", "path": "...", "branch": "claude-orchestrator/Lucy-workspace",   "instance_id": "..." },
    "Thomas": { "name": "Thomas", "role": "reviewer", "path": "...", "branch": "claude-orchestrator/Thomas-workspace", "instance_id": "..." },
    "Jack":   { "name": "Jack",   "role": "accepter", "path": "...", "branch": "claude-orchestrator/Jack-workspace",   "instance_id": "..." }
  }
}
```

### 1.5 Worktree 配置

```json
{
  "name": "Tom",
  "role": "planner",
  "instance_id": "a1b2c3d4e5f6..."
}
```

### 1.6 角色枚举

合法值：`planner` | `builder` | `verifier` | `reviewer` | `accepter` | `leader`

## 2. 命令总览

共 13 个命令：

| 分类 | 命令 | 说明 |
|------|------|------|
| 控制 | `run` | 一键启动：环境自检 + worktree + TUI + N 个 Worker |
| 控制 | `unregister` | 注销实例 |
| 控制 | `config` | 查看合并后的配置 |
| 消息 | `send-message` | 发送消息（直发/广播） |
| 消息 | `poll-message` | 检查新消息 |
| 消息 | `delete-message` | 删除消息 |
| 任务 | `push-task` | 创建新任务 |
| 任务 | `poll-task` | 查看任务列表 |
| 任务 | `claim-task` | 认领任务 |
| 任务 | `complete-task` | 完成任务 |
| 任务 | `task-block` | 标记阻塞 |
| 任务 | `task-fail` | 标记失败 |
| 任务 | `task-retry` | 重试失败任务 |

通用约定：
- 所有命令输出 JSON；错误时 `{"error": "..."}` + exit 1
- 全局选项 `-z, --zookeeper <hosts>` / `-d, --debug`

## 3. `run` 命令 — 一键启动

```bash
claude-orchestrator run --worker <n> [-y] [-z <hosts>] [-d]
```

| 选项 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--worker <n>` | **是** | — | Worker 数量 |
| `-y, --yes` | 否 | `false` | 跳过 InitChecker 交互 |
| `-z, --zookeeper <hosts>` | 否 | 配置值 | ZK 连接地址 |
| `-d, --debug` | 否 | `false` | 调试模式 |

### 五阶段流程

```
Phase 1: 环境自检（InitChecker 6 步骤）
  ├─ global_config / user_claude_md / team_claude_md
  ├─ skills / worktrees / npm_install
  └─ 每步记录 init_status

Phase 2: Worker 名称 + 角色分配 + worktree 创建
  ├─ generateWorkerAssignment(n) → [Tom(planner), Jerry(builder), ...]
  └─ git worktree add + 模板播种 + npm install

Phase 3: 启动 Leader
  ├─ ZK 连接 + /leader EPHEMERAL
  ├─ 5 个子系统启动
  └─ TUI 渲染

Phase 4: fork N 个 Worker 子进程
  └─ child.on("exit") 自动重启（最多 3 次）

Phase 5: 阻塞等待 SIGINT
  └─ kill 子进程 → 注销 → ZK disconnect
```

### 幂等性

`run` 可重复执行：
- `run --worker 5`（首次）→ 创建 5 个 worktree
- `run --worker 5`（重复）→ 检测 worktree 已存在，跳过创建，直接启动
- `run --worker 3`（缩减）→ 只启动前 3 个
- `run --worker 7`（扩张）→ 复用前 5 个，新建 2 个

## 4. 其他命令

### `send-message`

```bash
claude-orchestrator send-message --content <text> (--to <id> | --to-name <name> | --broadcast)
```

### `push-task`

```bash
claude-orchestrator push-task --title <title> [--description <text>] [--priority <n>]
  [--assignee <id>] [--link <link>] [--chain-id <id>]
  [--depends-on <ids>] [--blocked-by <ids>]
```

### `claim-task`

按角色权重排序认领优先级最高的 pending 任务。ZK EPHEMERAL create 保证并发认领时只有一个 Worker 成功。

### `complete-task`

```bash
claude-orchestrator complete-task --task-id <id> --result <text>
```

校验 claimed 节点归属。

### 任务状态流转

```
pending → claimed → completed
                 → blocked
                 → failed → pending (retry_count++)
                          → failed (retry_count >= 3, 归档)

外加: Worker 断开 → EPHEMERAL 删除 → Recovery 回收 → pending (max 3 次)
```

## 5. InitChecker

6 个独立步骤，每步有危险级别：

| Step | 操作 | 危险级别 |
|------|------|---------|
| 1. global_config | 创建/补全配置 | Caution |
| 2. user_claude_md | 复制 ~/.claude/CLAUDE.md | Danger |
| 3. team_claude_md | 复制 ./CLAUDE.md | Danger |
| 4. skills | 逐 skill 复制 | Danger |
| 5. worktrees | 创建/复用 | Safe |
| 6. npm_install | 安装依赖 | Caution |

`-y` 模式基于 `init_status` 历史决策自动处理：曾批准 → 自动批准；曾拒绝/跳过 → 仍跳过。

## 6. Worker 命名与角色分配

内置 20 个名称池：Tom, Jerry, Lucy, Thomas, Jack, Lisa, Alice, Bob, Charlie, Diana, Edward, Fiona, George, Helen, Ivan, Julia, Kevin, Linda, Mike, Nancy

角色分配优先级：planner > builder > verifier > reviewer > accepter

| Worker 数 | 角色分配 |
|-----------|---------|
| 1 | builder |
| 2 | planner, builder |
| 3 | planner, builder, verifier |
| 4 | planner, builder, verifier, reviewer |
| 5 | planner, builder, verifier, reviewer, accepter |
| 6+ | 五种角色各至少 1 个，其余优先扩充 builder |
