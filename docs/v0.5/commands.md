# CLI 命令与配置参考

## 设计原则

- **一键启动** — `run --worker N` 替代分散的 setup / leader / register，承担环境自检、worktree 初始化、Leader TUI 启动、Worker 子进程 fork
- **配置分层** — 全局 + 项目 + CLI 参数 + 环境变量 四级合并
- **JSON 输出** — 所有命令统一输出 JSON，错误时 `{"error": "..."}` + exit 1
- **实例身份绑定项目** — `instance_id`、`name`、`role` 持久化在项目（含 worktree）的 `.claude-orchestrator/config.json`

## 配置系统

### 文件位置

| 层级 | 路径 | 用途 |
|------|------|------|
| 全局 | `~/.claude-orchestrator/config.json` | ZK 连接、缓存目录、claude-cli 命令、hooks、init_status |
| 项目（根） | `<cwd>/.claude-orchestrator/config.json` | worktree 段落（所有 Worker 的 name/role/path/branch/instance_id） |
| 项目（worktree） | `<worktree>/.claude-orchestrator/config.json` | 单个 Worker 的 name / role / instance_id |

合并规则（高优先级覆盖低优先级）：

```
CLI 参数 / 环境变量
   ↑ 覆盖
项目（worktree）config
   ↑ 覆盖
项目（根）config
   ↑ 覆盖
全局 config
   ↑
默认值
```

ZK 连接地址解析顺序：`-z` CLI flag → `ZK_HOSTS` 环境变量 → 全局配置 → `127.0.0.1:2181` 默认值。

### 配置键

#### 全局配置 `~/.claude-orchestrator/config.json`

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `zookeeper.url` | string | `"127.0.0.1:2181"` | ZK 连接地址 |
| `zookeeper.root_path` | string | `"/claude-orchestrator"` | ZK 根节点路径 |
| `zookeeper.auth` | string \| null | `null` | ZK 认证信息（`user:password`） |
| `cache_dir` | string | `".claude-orchestrator/sessions"` | 共享日志/结果目录 |
| `commands.claude-cli` | string | `"claude --dangerously-skip-permissions --permission-mode dontAsk"` | claude CLI 基础命令 |
| `hooks.leader_message_start` | string \| null | `null` | Leader 处理消息前执行的 shell 命令 |
| `hooks.leader_message_end` | string \| null | `null` | Leader 处理消息后执行的 shell 命令 |
| `hooks.worker_message_start` | string \| null | `null` | Worker 处理消息前执行的 shell 命令 |
| `hooks.worker_message_end` | string \| null | `null` | Worker 处理消息后执行的 shell 命令 |
| `init_status` | object | `{}` | InitChecker 历史决策记忆（详见 [`orchestration.md`](orchestration.md) §3） |

#### 项目根配置 `<cwd>/.claude-orchestrator/config.json`

| Key | 类型 | 必填 | 说明 |
|-----|------|------|------|
| `worktree` | `Record<name, WorktreeEntry>` | 是 | 所有 Worker 的 worktree 段落 |
| `commands.claude-cli` | string | 否 | 覆盖全局 claude-cli 命令 |

`WorktreeEntry` 结构：

```typescript
{
  name: string;          // "Tom"
  role: string;          // "planner"
  path: string;          // ".claude-orchestrator/worktree/Tom"
  branch: string;        // "claude-orchestrator/Tom-workspace"
  instance_id: string;   // 预生成 UUID
}
```

#### Worktree 配置 `<worktree>/.claude-orchestrator/config.json`

```json
{
  "name": "Tom",
  "role": "planner",
  "instance_id": "a1b2c3d4e5f6..."
}
```

#### 角色枚举

`role` 合法值：`planner` | `builder` | `verifier` | `reviewer` | `accepter` | `leader`

### 示例

```json
// ~/.claude-orchestrator/config.json
{
  "zookeeper": { "url": "127.0.0.1:2181", "root_path": "/claude-orchestrator", "auth": null },
  "cache_dir": ".claude-orchestrator/sessions",
  "commands": {
    "claude-cli": "claude --dangerously-skip-permissions --permission-mode dontAsk"
  },
  "hooks": {
    "leader_message_start": null,
    "leader_message_end": null,
    "worker_message_start": "echo $CO_WORKER_NAME starting >> ~/.claude-orchestrator/hooks.log",
    "worker_message_end": null
  },
  "init_status": { "/* ... */": null }
}
```

## 命令总览

| 分类 | 命令 | 说明 |
|------|------|------|
| 控制 | `run` | 一键启动：环境自检 + worktree + TUI + N 个 Worker |
| 控制 | `unregister` | 注销实例（删除 ZK `/instances/{id}` 节点） |
| 控制 | `config` | 查看合并后的当前配置 |
| 消息 | `send-message` | 发送消息（直发 / 广播） |
| 消息 | `poll-message` | 检查新消息 |
| 消息 | `delete-message` | 删除消息 |
| 任务 | `push-task` | 创建新任务 |
| 任务 | `poll-task` | 查看任务列表 |
| 任务 | `claim-task` | 认领任务 |
| 任务 | `complete-task` | 完成任务 |
| 任务 | `task-block` | 标记任务阻塞 |
| 任务 | `task-fail` | 标记任务失败 |
| 任务 | `task-retry` | 重试失败任务 |

共 13 个命令，源码入口 [src/index.ts](../../src/index.ts) + [src/cli/commands.ts](../../src/cli/commands.ts) + [src/orchestrator/run.ts](../../src/orchestrator/run.ts)。

## 通用约定

- 所有命令输出均为 JSON（`JSON.stringify(data, null, 2)`）
- 错误时输出 `{"error": "..."}` 并以 exit code 1 退出
- 全局选项 `-z, --zookeeper <hosts>` 覆盖配置中的 ZK url
- 全局选项 `-d, --debug` 开启 trace 日志（`Logger.enableDebug()`）
- `--instance-id` 是**命令级选项**，默认从当前目录项目配置或 worktree 配置读取

## 控制命令

### `run` — 一键启动编排

启动完整编排环境：环境自检 → worktree 初始化 → Leader TUI → fork N 个 Worker 子进程 → 阻塞等待 SIGINT。

```
claude-orchestrator run --worker <n> [options]
```

| 选项 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--worker <n>` | **是** | — | Worker 数量（角色按 `planner > builder > verifier > reviewer > accepter > builder...` 顺序分配） |
| `-y, --yes` | 否 | `false` | 跳过所有 InitChecker 交互提示，基于 `init_status` 历史记忆自动决策 |
| `-z, --zookeeper <hosts>` | 否 | 配置或 `127.0.0.1:2181` | ZK 连接地址 |
| `-d, --debug` | 否 | `false` | 调试模式，打印 `[Exec]` / `[Watcher]` 等 trace 日志 |

**行为**：

1. 阶段 1：`InitChecker.runAll()` 检查 6 步骤（global_config / user_claude_md / team_claude_md / skills / worktrees / npm_install）
2. 阶段 2：`WorktreeInitializer.initializeWorktrees(projectRoot, n)` 分配名称 + 角色 + 创建 git worktree
3. 阶段 3：`startLeader(config, worktreeConfigs)` 启动 Leader 子系统并渲染 TUI
4. 阶段 4：`startAllWorkers({ configs })` fork N 个子进程
5. 阶段 5：阻塞等待 SIGINT → kill 子进程 → 注销 → ZK disconnect

详见 [`orchestration.md`](orchestration.md)。

**示例**：

```bash
# 首次启动（交互模式）
claude-orchestrator run --worker 5

# 自动模式（基于历史决策）
claude-orchestrator run --worker 5 -y

# 自定义 ZK
claude-orchestrator run --worker 3 -z zk-prod-01:2181

# 调试模式
claude-orchestrator run --worker 2 --debug
```

### `unregister` — 注销实例

显式删除 ZK `/instances/{id}` 节点。通常由 SIGINT 自动清理触发，此命令用于残留节点的手动清理。

```
claude-orchestrator unregister [options]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

### `config` — 查看当前配置

合并展示全局配置 + 项目根配置 + 当前 worktree 配置的最终有效值。

```
claude-orchestrator config [options]
```

**输出示例**：

```json
{
  "zookeeper": {
    "url": "127.0.0.1:2181",
    "root_path": "/claude-orchestrator",
    "auth": null
  },
  "global": {
    "cache_dir": ".claude-orchestrator/sessions",
    "commands": {
      "claude-cli": "claude --dangerously-skip-permissions --permission-mode dontAsk"
    },
    "hooks": { "...": null }
  },
  "project": {
    "name": "Tom",
    "role": "planner",
    "instance_id": "a1b2c3d4..."
  }
}
```

## 消息命令

### `send-message` — 发送消息

三种发送方式至少指定一种：直发实例 ID、直发实例名、广播。

```
claude-orchestrator send-message --content <text> (--to <id> | --to-name <name> | --broadcast) [options]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--content <text>` | **是** | 消息内容 |
| `--to <id>` | 否* | 接收方实例 ID |
| `--to-name <name>` | 否* | 接收方实例名 |
| `--broadcast` | 否* | 广播给所有在线实例 |
| `--instance-id <id>` | 否 | 发送方实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

> *`--to`、`--to-name`、`--broadcast` 至少指定一个。

消息内容写入 `/messages/{recipient_id}/msg-{seq}` PERSISTENT_SEQUENTIAL 节点，接收方 ChildWatch 触发自动处理。

### `poll-message` — 检查新消息

```
claude-orchestrator poll-message [options]
```

返回当前实例 `/messages/{id}/` 下所有未读消息列表（read=false）。

### `delete-message` — 删除消息

```
claude-orchestrator delete-message --message-id <id> [options]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--message-id <id>` | **是** | 要删除的消息 ID |
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

## 任务命令

### `push-task` — 创建任务

```
claude-orchestrator push-task --title <title> [options]
```

| 选项 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--title <title>` | **是** | — | 任务标题 |
| `--description <text>` | 否 | `""` | 任务描述 |
| `--priority <n>` | 否 | `"1"` | 优先级：0=HIGH, 1=MEDIUM, 2=LOW |
| `--assignee <id>` | 否 | — | 指定分配给某实例 ID |
| `--link <link>` | 否 | — | 责任链环节：`plan` / `build` / `verify` / `review` / `accept` |
| `--chain-id <id>` | 否 | — | 链标识符，用于关联同一需求的任务 |
| `--depends-on <ids>` | 否 | `[]` | 依赖的上游任务 ID（逗号分隔） |
| `--blocked-by <ids>` | 否 | `[]` | 阻塞该任务的任务 ID |
| `--instance-id <id>` | 否 | 当前项目配置 | 创建者实例 ID |
| `-z, --zookeeper <hosts>` | 否 | 全局配置 | ZK 连接地址 |

任务写入 `/tasks/pending/task-{seq}` PERSISTENT_SEQUENTIAL 节点。

### `poll-task` — 查看任务

```
claude-orchestrator poll-task [--status <status>] [options]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--status <status>` | 否 | 过滤：`pending` / `claimed` / `completed` / `blocked` / `failed` |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

### `claim-task` — 认领任务

按 [角色权重排序](role-design.md#3-关键设计角色是权重不是身份)认领优先级最高的 pending 任务。ZK EPHEMERAL create 保证并发认领时只有一个 Worker 成功。

```
claude-orchestrator claim-task [options]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

### `complete-task` — 完成任务

```
claude-orchestrator complete-task --task-id <id> --result <text> [options]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--task-id <id>` | **是** | 要完成的任务 ID |
| `--result <text>` | **是** | 完成结果摘要 |
| `--instance-id <id>` | 否 | 实例 ID |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

校验 claimed 节点归属：`/tasks/claimed/{instance_id}-{task_id}` 必须存在且属于当前实例。

### `task-block` — 标记任务阻塞

```
claude-orchestrator task-block --task-id <id> --reason <text> [options]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--task-id <id>` | **是** | 任务 ID |
| `--reason <text>` | **是** | 阻塞原因 |
| `--instance-id <id>` | 否 | 实例 ID |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

### `task-fail` — 标记任务失败

```
claude-orchestrator task-fail --task-id <id> --reason <text> [options]
```

字段同 `task-block`。

### `task-retry` — 重试失败任务

将 failed 任务重新放入 pending 队列。

```
claude-orchestrator task-retry --task-id <id> [options]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--task-id <id>` | **是** | 要重试的任务 ID |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

## 任务状态流转

```
                  ┌─────────┐
                  │ pending │
                  └────┬────┘
                       │ claim-task (原子 EPHEMERAL create)
                  ┌────▼────┐
             ┌────│ claimed │────┐
             │    └────┬────┘    │
             │         │         │
             │ task-block        │ task-fail
             │         │         │
        ┌────▼─────┐   │   ┌────▼─────┐
        │ blocked  │   │   │  failed  │
        └──────────┘   │   └────┬─────┘
                       │        │ task-retry
                       │        ▼
                       │   pending (retry_count++)
                  complete-task
                       │
                  ┌────▼──────┐
                  │ completed │
                  └───────────┘

外加: Worker 断开 → ZK Session 超时 → claimed EPHEMERAL 删除
     → Recovery.scanOrphans() 重入 pending（max 3 次后归档为 failed）
```

| 状态 | 含义 | 触发 |
|------|------|------|
| `pending` | 等待认领 | `push-task` 或 ChainRouter 由 ChainDef push |
| `claimed` | 已认领，执行中 | `claim-task` 或 Worker 自动 claim |
| `completed` | 已完成 | `complete-task` 或 Worker 完成报告 |
| `blocked` | 被阻塞，等待解除 | `task-block` |
| `failed` | 执行失败，可重试 | `task-fail` |

详见 [`zookeeper-schema.md`](zookeeper-schema.md) §2 任务节点定义。
