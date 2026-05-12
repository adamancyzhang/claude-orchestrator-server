# CLI Commands & Configuration Reference (v0.3.0)

## 设计原则

v0.3.0 从 v0.2.0 的 25 个 MCP 工具精简为 14 个 CLI 命令，聚焦 Leader-Worker 核心流程：

- **实例配置归属项目** — `instance_id`、`name`、`role` 是项目级配置，不进入全局配置
- **register 严格校验** — name 必填、role 必须为合法值，不允许回退默认值
- **register 绑定当前目录** — 不提供 `--work-dir`，始终监听 `cwd`
- **无共享上下文** — 移除所有 context 相关命令，不维护跨实例 KV 存储
- **无长轮询/帮助请求** — 移除 `wait-for-message`、`request-help`
- **保留完整任务流转** — pending → claimed → completed/blocked/failed，含 retry 路径

---

## 配置系统 (config.json)

### 文件位置

| 层级 | 路径 | 用途 |
|---|---|---|
| 全局 | `~/.claude-orchestrator/config.json` | 用户级默认配置：ZK 连接、缓存目录、Claude CLI 命令 |
| 项目 | `<cwd>/.claude-orchestrator/config.json` | 项目级配置：实例身份(name/role/id)、可覆盖的 CLI 命令 |

读取时合并：项目配置覆盖全局配置。写入时指定层级（默认项目），与已有 key 合并，不删除未写入的 key。

### 配置键

#### 全局配置 (`~/.claude-orchestrator/config.json`)

| Key | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `zookeeper.url` | string | 否 | `"127.0.0.1:2181"` | ZooKeeper 连接地址 |
| `zookeeper.root_path` | string | 否 | `"/claude-orchestrator"` | ZK 根节点路径 |
| `zookeeper.auth` | string \| null | 否 | `null` | ZK 认证信息（`user:password`） |
| `cache_dir` | string | 否 | `"~/.claude-orchestrator/sessions"` | 共享会话缓存目录 |
| `command` | string | 否 | `"claude --dangerously-skip-permissions -v"` | Worker 处理消息时启动的 Claude CLI 命令 |

#### 项目配置 (`<cwd>/.claude-orchestrator/config.json`)

| Key | 类型 | 必填 (for register) | 说明 |
|---|---|---|---|
| `name` | string | **是** | 实例显示名称 |
| `role` | string | **是** | 实例角色，必须为合法值 |
| `instance_id` | string | 自动生成 | 实例唯一标识（register 时生成并写入） |
| `command` | string | 否 | 覆盖全局 Claude CLI 命令 |

#### 角色枚举

`role` 合法值：`architect` | `developer` | `tester` | `general` | `leader`

### 示例

**全局配置** (`~/.claude-orchestrator/config.json`):
```json
{
  "zookeeper": {
    "url": "127.0.0.1:2181",
    "root_path": "/claude-orchestrator",
    "auth": null
  },
  "cache_dir": "~/.claude-orchestrator/sessions",
  "command": "claude --dangerously-skip-permissions -v"
}
```

**项目配置** (`<project>/.claude-orchestrator/config.json`):
```json
{
  "name": "Bob",
  "role": "developer",
  "instance_id": "ddd2fba51af04c0ca434ed07bf7c9e28"
}
```

---

## 命令总览

| 分类 | 命令 | 说明 |
|---|---|---|
| 控制 | `leader` | 启动 Leader TUI 编排控制台 |
| 控制 | `register` | 注册为 Worker，监听当前目录 |
| 控制 | `unregister` | 注销实例 |
| 控制 | `config` | 查看当前配置 |
| 控制 | `setup` | 初始化环境与配置文件 |
| 消息 | `send-message` | 发送消息（直发/广播） |
| 消息 | `poll-message` | 检查新消息 |
| 消息 | `delete-message` | 删除消息 |
| 任务 | `push-task` | 创建新任务 |
| 任务 | `poll-task` | 查看任务列表 |
| 任务 | `claim-task` | 认领任务 |
| 任务 | `complete-task` | 完成任务 |
| 任务 | `task-block` | 标记任务阻塞 |
| 任务 | `task-fail` | 标记任务失败 |
| 任务 | `task-retry` | 重试失败任务 |

---

## 通用约定

- 所有命令输出均为 JSON（`JSON.stringify(data, null, 2)`）
- 错误时输出 `{ "error": "..." }` 并以 exit code 1 退出
- `--instance-id` 是**命令级选项**（非全局），仅在需要实例身份的命令上出现，默认从当前目录项目配置读取

---

## 控制命令

### leader — 启动 Leader 节点

启动 TUI 编排控制台，读取全局配置中的 ZK 连接、`command` 和 `cache_dir`。

```
claude-orchestrator leader [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--name <name>` | 否 | Leader 显示名称 |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址（覆盖全局配置） |

---

### register — 注册 Worker

注册当前目录为 Worker 实例，**必须**在当前目录的项目配置中提供 `name` 和 `role`。注册成功后生成 `instance_id` 并写入项目配置。之后阻塞监听当前目录的消息队列，有新消息时 spawn Claude 子进程处理，直到 SIGINT。

```
claude-orchestrator register [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址（覆盖全局配置） |

**行为规则:**

1. 从 `<cwd>/.claude-orchestrator/config.json` 读取 `name` 和 `role`
2. `name` **必填** — 缺失则报错退出，不允许回退
3. `role` **必填** — 必须为合法枚举值，缺失或非法则报错退出，不允许回退
4. 生成 UUID 作为 `instance_id`，在 ZK 创建 ephemeral 节点完成注册
5. 若项目配置中无 `instance_id`，写入配置；已有则保留
6. 持久化运行：监听消息 → spawn `claude -p` → 等待完成 → 继续监听
7. SIGINT 时清理 ZK 节点并退出

**错误场景:**
- 项目配置缺失 `name` → `{ "error": "name is required in .claude-orchestrator/config.json" }`
- 项目配置 `role` 非法 → `{ "error": "invalid role 'xxx', must be one of: architect, developer, tester, general, leader" }`

---

### unregister — 注销实例

```
claude-orchestrator unregister [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

---

### config — 查看当前配置

合并展示全局配置和当前目录项目配置的最终有效值。

```
claude-orchestrator config [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

**输出示例:**
```json
{
  "zookeeper": {
    "url": "127.0.0.1:2181",
    "root_path": "/claude-orchestrator",
    "auth": null
  },
  "global": {
    "cache_dir": "~/.claude-orchestrator/sessions",
    "command": "claude --dangerously-skip-permissions -v"
  },
  "project": {
    "name": "Bob",
    "role": "developer",
    "instance_id": "ddd2fba51af04c0ca434ed07bf7c9e28"
  }
}
```

---

### setup — 初始化环境

创建配置文件、复制 Agent 模板（leader.md / worker.md）到 `.claude-orchestrator/agents/`。已存在的模板文件不覆盖。

```
claude-orchestrator setup [options]
```

| 选项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `--leader` | 否 | `false` | 初始化为 Leader 环境 |
| `--name <name>` | 否 | `"Leader"`（仅当 `--leader`） | 实例显示名称 |
| `--role <role>` | 否 | `"leader"`（仅当 `--leader`），否则 `"general"` | 实例角色 |
| `--cache-dir <path>` | 否 | `~/.claude-orchestrator/sessions` | 共享缓存目录 |
| `--command <cmd>` | 否 | `claude --dangerously-skip-permissions -v` | Claude CLI 命令 |
| `--global` | 否 | `false` | 仅写入全局配置（不写项目配置） |

---

## 消息命令

### send-message — 发送消息

三种发送方式至少指定一种。

```
claude-orchestrator send-message --content <text> (--to <id> | --to-name <name> | --broadcast) [options]
```

| 选项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `--content <text>` | **是** | — | 消息内容 |
| `--to <id>` | 否* | — | 接收方实例 ID |
| `--to-name <name>` | 否* | — | 接收方实例名（如 @Tom, @All） |
| `--broadcast` | 否* | `false` | 广播给所有在线实例 |
| `--instance-id <id>` | 否 | 当前项目配置 | 发送方实例 ID |
| `-z, --zookeeper <hosts>` | 否 | 全局配置 | ZK 连接地址 |

> *`--to`、`--to-name`、`--broadcast` 至少指定一个。

---

### poll-message — 检查新消息

```
claude-orchestrator poll-message [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

---

### delete-message — 删除消息

```
claude-orchestrator delete-message --message-id <id> [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--message-id <id>` | **是** | 要删除的消息 ID |
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

---

## 任务命令

### push-task — 创建任务

```
claude-orchestrator push-task --title <title> [options]
```

| 选项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `--title <title>` | **是** | — | 任务标题 |
| `--description <text>` | 否 | `""` | 任务描述 |
| `--priority <n>` | 否 | `"1"` | 优先级：0=HIGH, 1=MEDIUM, 2=LOW |
| `--assignee <id>` | 否 | — | 指定分配给某实例 ID |
| `--instance-id <id>` | 否 | 当前项目配置 | 创建者实例 ID |
| `-z, --zookeeper <hosts>` | 否 | 全局配置 | ZK 连接地址 |

---

### poll-task — 查看任务

```
claude-orchestrator poll-task [--status <status>] [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--status <status>` | 否 | 状态过滤：`pending` / `claimed` / `completed` / `blocked` / `failed` |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

---

### claim-task — 认领任务

原子认领优先级最高的 pending 任务。

```
claude-orchestrator claim-task [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

---

### complete-task — 完成任务

```
claude-orchestrator complete-task --task-id <id> --result <text> [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--task-id <id>` | **是** | 要完成的任务 ID |
| `--result <text>` | **是** | 完成结果摘要 |
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

---

### task-block — 标记任务阻塞

将 claimed 任务标记为 blocked。

```
claude-orchestrator task-block --task-id <id> --reason <text> [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--task-id <id>` | **是** | 任务 ID |
| `--reason <text>` | **是** | 阻塞原因 |
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

---

### task-fail — 标记任务失败

将 claimed 任务标记为 failed。

```
claude-orchestrator task-fail --task-id <id> --reason <text> [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--task-id <id>` | **是** | 任务 ID |
| `--reason <text>` | **是** | 失败原因 |
| `--instance-id <id>` | 否 | 实例 ID（默认从当前目录项目配置读取） |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

---

### task-retry — 重试失败任务

将 failed 任务重新放入 pending 队列。

```
claude-orchestrator task-retry --task-id <id> [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--task-id <id>` | **是** | 要重试的任务 ID |
| `-z, --zookeeper <hosts>` | 否 | ZK 连接地址 |

---

## 任务状态流转

```
                   ┌─────────┐
                   │ pending │
                   └────┬────┘
                        │ claim-task
                   ┌────▼────┐
              ┌────│ claimed │────┐
              │    └─────────┘    │
              │ task-block        │ task-fail
         ┌────▼─────┐       ┌────▼─────┐
         │ blocked  │       │  failed  │
         └──────────┘       └────┬─────┘
                                 │ task-retry
                                 ▼
                            pending (retry)

              │
              │ complete-task
         ┌────▼──────┐
         │ completed │
         └───────────┘
```

- `claimed` 即表示执行中，无需额外的 `in_progress`
- `blocked` 任务需外部介入解除后重新流转
- `failed` 任务可通过 `task-retry` 重新入队

---

## v0.2.0 → v0.3.0 变更对照

| v0.2.0 命令 | v0.3.0 去向 |
|---|---|
| `server` | 移除（不再有 MCP Server） |
| `status` | 移除（由 `config` + ZK 连接诊断替代） |
| `register` | **保留**，重设计：绑定 cwd，name/role 必填不可回退 |
| `heartbeat` | 移除（ZK ephemeral 节点自动保活） |
| `list-instances` | 移除（Leader TUI 内置实例列表） |
| `push-task` | **保留** |
| `claim-task` | **保留** |
| `complete-task` | **保留** |
| `list-tasks` | **重命名** → `poll-task` |
| `send-message` | **保留** |
| `poll-messages` | **重命名** → `poll-message` |
| `wait-for-message` | **移除** |
| `dismiss-message` | **重命名** → `delete-message` |
| `request-help` | **移除** |
| `set-context` | **移除**（无共享上下文设计） |
| `get-context` | **移除** |
| `delete-context` | **移除** |
| `list-context-keys` | **移除** |
| `watch-context` | **移除** |
| `watch-tasks` | **移除** |
| `unregister` | **保留** |
| `config` | **保留** |
| `setup` | **保留** |
| `task-block` | **保留** |
| `task-fail` | **保留** |
| `task-retry` | **保留** |
| `leader` | **保留** |
