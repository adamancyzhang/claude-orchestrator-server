# CLI Commands & Configuration Reference (v0.3.0)

## Global Options

所有命令都可用的全局选项：

| 选项 | 环境变量 | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `-z, --zookeeper <hosts>` | `ZK_HOSTS` | string | `127.0.0.1:2181` | ZooKeeper 连接地址 |
| `-i, --instance-id <id>` | — | string | 从 config.json 自动读取 | 实例 ID，缺省时从配置文件读取 |

优先级：CLI 选项 > 环境变量 > 默认值。ZK_HOSTS 仅在 CLI 未显式指定 `--zookeeper`（或值为默认值）时生效。

---

## 配置系统 (config.json)

### 文件位置

| 层级 | 路径 | 用途 |
|---|---|---|
| 全局 | `~/.claude-orchestrator/config.json` | 用户级默认配置（command, cache_dir） |
| 项目 | `<cwd>/.claude-orchestrator/config.json` | 项目级配置（name, role, instance_id） |

读取配置时，项目配置 **合并覆盖** 全局配置（项目值优先）。

写入配置（`saveInstanceConfig`）时，默认写入项目文件；指定 `--global` 则写入全局文件。写入是 **合并模式**（merge），已有 key 不会被清除。

### 配置键

| Key | 类型 | 层级 | 说明 |
|---|---|---|---|
| `instance_id` | string | 全局/项目 | 实例唯一标识（register 时自动生成 UUID） |
| `name` | string | 项目 | 实例显示名称 |
| `role` | string | 项目 | 实例角色：`architect` / `developer` / `tester` / `general` / `leader` |
| `command` | string | 全局 | Worker 处理消息时启动的 Claude CLI 命令，默认 `claude --dangerously-skip-permissions -v` |
| `cache_dir` | string | 全局 | 共享会话缓存目录，默认 `~/.claude-orchestrator/sessions` |
| `port` | string | 全局/项目 | 服务器端口（CLI 命令一般不使用） |
| `host` | string | 全局/项目 | 服务器地址（CLI 命令一般不使用） |

### 示例

**全局配置** (`~/.claude-orchestrator/config.json`):
```json
{
  "command": "claude --dangerously-skip-permissions -v",
  "cache_dir": "~/.claude-orchestrator/sessions"
}
```

**项目配置** (`<project>/.claude-orchestrator/config.json`):
```json
{
  "instance_id": "ddd2fba51af04c0ca434ed07bf7c9e28",
  "name": "Bob",
  "role": "tester"
}
```

---

## 命令列表

所有命令输出均为 JSON 格式（`console.log(JSON.stringify(data, null, 2))`），错误时输出 `{ error: "..." }` 并以 exit code 1 退出。

### status — 健康检查

不依赖 instance_id，无需注册即可使用。

```
claude-orchestrator status
```

**选项**: 无（仅全局选项）

**输出**:
```json
{
  "status": "healthy" | "degraded",
  "zookeeper": "connected" | "disconnected",
  "instances_online": <number>
}
```

---

### register — 注册实例

两种模式：

**模式 1: 一次性注册**（不带 `--work-dir`）。注册后立即输出实例信息并退出。

**模式 2: 持久化监听**（带 `--work-dir`）。注册后阻塞运行，监听消息队列，有新消息时在指定目录下 spawn `claude -p` 子进程处理，直到 SIGINT。

```
claude-orchestrator register [options]
```

| 选项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `--name <name>` | 否 | 从 config.json 读取 | 显示名称 |
| `--role <role>` | 否 | 从 config.json 读取，最终回退 `"general"` | 实例角色 |
| `--work-dir <path>` | 否 | — | 指定后进入持久化监听模式，在该目录下 spawn Claude 子进程 |

持久化模式下额外读取全局配置 `command` 和 `cache_dir`。

---

### heartbeat — 发送心跳

```
claude-orchestrator heartbeat [options]
```

| 选项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `--current-task <id>` | 否 | — | 当前正在处理的任务 ID，省略则清空 |

---

### list-instances — 列出活跃实例

```
claude-orchestrator list-instances
```

**选项**: 无

---

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

---

### claim-task — 认领任务

原子认领优先级最高的 pending 任务。

```
claude-orchestrator claim-task
```

**选项**: 无

---

### complete-task — 完成任务

```
claude-orchestrator complete-task --task-id <id> --result <text>
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--task-id <id>` | **是** | 要完成的任务 ID |
| `--result <text>` | **是** | 完成结果摘要 |

---

### task-block — 标记阻塞

```
claude-orchestrator task-block --task-id <id> --reason <text>
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--task-id <id>` | **是** | 任务 ID |
| `--reason <text>` | **是** | 阻塞原因 |

---

### task-fail — 标记失败

```
claude-orchestrator task-fail --task-id <id> --reason <text>
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--task-id <id>` | **是** | 任务 ID |
| `--reason <text>` | **是** | 失败原因 |

---

### task-retry — 重试失败任务

将失败任务重新放入队列（pending）。

```
claude-orchestrator task-retry --task-id <id>
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--task-id <id>` | **是** | 要重试的任务 ID |

---

### list-tasks — 列出任务

```
claude-orchestrator list-tasks [--status <status>]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--status <status>` | 否 | 状态过滤：`pending` / `claimed` / `in_progress` / `completed` / `blocked` / `failed` |

---

### send-message — 发送消息

三种发送方式至少指定一种。

```
claude-orchestrator send-message --content <text> (--to <id> | --to-name <name> | --broadcast)
```

| 选项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `--content <text>` | **是** | — | 消息内容 |
| `--to <id>` | 否* | — | 接收方实例 ID |
| `--to-name <name>` | 否* | — | 接收方实例名（如 @Tom, @All） |
| `--broadcast` | 否* | `false` | 广播给所有实例 |

> *`--to`、`--to-name`、`--broadcast` 至少指定一个。

---

### poll-messages — 检查新消息

```
claude-orchestrator poll-messages
```

**选项**: 无

---

### wait-for-message — 等待消息（长轮询）

阻塞等待直到有新消息或超时。

```
claude-orchestrator wait-for-message [--timeout <seconds>]
```

| 选项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `--timeout <seconds>` | 否 | `"30"` | 超时秒数 |

---

### dismiss-message — 删除消息

```
claude-orchestrator dismiss-message --message-id <id>
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--message-id <id>` | **是** | 要删除的消息 ID |

---

### request-help — 请求帮助

向所有在线实例广播帮助请求。

```
claude-orchestrator request-help --question <text> [--context <text>]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--question <text>` | **是** | 问题描述 |
| `--context <text>` | 否 | 附加上下文（如 stack trace、日志） |

---

### set-context — 设置共享上下文

```
claude-orchestrator set-context --key <key> --value <value>
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--key <key>` | **是** | 上下文键 |
| `--value <value>` | **是** | 上下文值 |

---

### get-context — 获取共享上下文

```
claude-orchestrator get-context --key <key>
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--key <key>` | **是** | 要获取的键 |

---

### delete-context — 删除共享上下文

```
claude-orchestrator delete-context --key <key>
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--key <key>` | **是** | 要删除的键 |

---

### list-context-keys — 列出所有上下文键

```
claude-orchestrator list-context-keys
```

**选项**: 无

---

### watch-context — 监听上下文变化

阻塞直到指定 key 的值发生变化。

```
claude-orchestrator watch-context --key <key>
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--key <key>` | **是** | 要监听的键 |

---

### watch-tasks — 监听新任务

阻塞直到有新任务产生。

```
claude-orchestrator watch-tasks
```

**选项**: 无

---

### unregister — 注销实例

```
claude-orchestrator unregister
```

**选项**: 无

---

### config — 查看当前配置

```
claude-orchestrator config
```

**选项**: 无（仅全局选项）

**输出**:
```json
{
  "zookeeper": "127.0.0.1:2181",
  "instance_id": "ddd2fba51af04c0ca434ed07bf7c9e28",
  "config_dir": "~/.claude-orchestrator/"
}
```

---

### setup — 初始化环境

创建配置文件、复制 Agent 模板（leader.md / worker.md）到 `.claude-orchestrator/agents/`，已存在的模板文件不覆盖。

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
| `--global` | 否 | `false` | 仅写入全局配置（`~/.claude-orchestrator/`），不写项目配置 |

---

### leader — 启动 Leader 节点

启动 TUI 编排控制台（动态导入 `src/leader/index.ts`），读取全局配置中的 `command` 和 `cache_dir`。

```
claude-orchestrator leader [options]
```

| 选项 | 必填 | 说明 |
|---|---|---|
| `--name <name>` | 否 | Leader 显示名称 |

---

## 任务状态流转

```
                   ┌─────────┐
                   │ pending │
                   └────┬────┘
                        │ claim_task
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
              │ complete_task
         ┌────▼──────┐
         │ completed │
         └───────────┘
```

- `claimed` 和 `in_progress` 在过滤时视为同一阶段
- `blocked` 任务需手动转为 `pending` 或 `failed`
- `failed` 任务可通过 `task-retry` 重新入队
