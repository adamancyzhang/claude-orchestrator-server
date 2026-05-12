# 迁移指南: v0.2.0 → v0.3.0

## 概述

v0.3.0 是一次破坏性变更：完全移除 MCP Server，改为 Leader-Worker CLI-native 架构，引入 Agent 模板系统和共享 CACHE_DIR。

## 破坏性变更清单

### 1. CLI 命令变化

| v0.2.0 | v0.3.0 | 操作 |
|--------|--------|------|
| `claude-orchestrator server` | `claude-orchestrator leader` | 替换命令，启动 Leader TUI（仅 msg/status/exit 三个命令） |
| `claude-orchestrator setup` | `claude-orchestrator setup [--leader]` | 增强，`--leader` 初始化 Leader 环境，写入 Agent 模板 |
| 其他 CLI 命令 | 不变 | 继续使用 |

### 2. 依赖变化

| 包 | v0.2.0 | v0.3.0 |
|----|--------|--------|
| `@modelcontextprotocol/sdk` | ✓ | ✗ 移除 |
| `express` | ✓ | ✗ 移除 |
| `@types/express` | ✓ | ✗ 移除 |
| `commander` | ✓ | ✓ |
| `node-zookeeper-client` | ✓ | ✓ |
| `zod` | ✓ | ✓ |

### 3. ZK Schema 变化

- 新增 `/leader` 临时节点
- `Task` 节点增加 `status` 枚举值 (`in_progress`, `blocked`, `failed`) 和 `retry_count` 字段
- `Instance` 节点增加 `work_dir` 字段，移除 `status=blocked`
- `Claimed` 节点增加 `task_data` 嵌入

新旧格式兼容：v0.3.0 可以读取 v0.2.0 创建的节点，但新增字段有默认值。

### 4. 工作流变化

| v0.2.0 | v0.3.0 |
|--------|--------|
| 先启动 `server`，再配置 `.claude/mcp.json`，再连接 | 先启动 `leader`，再 `register --work-dir` |
| Claude Code 通过 MCP 工具交互 | Claude Code 通过 CLI 命令 + 本地 watcher 交互 |
| MCP Server 负责消息推送 | ZK Watch + 本地 `claude -p` 处理消息 |

## 迁移步骤

### 步骤 1: 升级包

```bash
npm install -g @adamancyzhang/claude-orchestrator@0.3.0
```

### 步骤 2: 清理 v0.2.0 遗留

```bash
# 停止旧的 MCP Server (如果还在运行)
pkill -f "claude-orchestrator server" || true

# 移除 .claude/mcp.json 中旧的 orchestrator 配置
# 删除 "orchestrator" 条目或删除整个文件
```

### 步骤 3: 初始化 Leader 环境

```bash
# 在 Leader 的项目目录中
claude-orchestrator setup --leader --name Tom
```

生成文件：
- `.claude-orchestrator/agents/leader.md` — Leader 任务指令模板
- `.claude-orchestrator/agents/worker.md` — Worker 消息模板
- `.claude-orchestrator/config.json` — `{"name":"Tom","role":"leader"}`
- `~/.claude-orchestrator/config.json` — 全局配置（command, cache_dir）

### 步骤 4: 启动 Leader

```bash
claude-orchestrator leader
# 或指定 ZK 地址:
claude-orchestrator leader -z 10.0.0.1:2181
```

Leader TUI 启动，提供 `msg`, `status`, `exit` 三个命令。

### 步骤 5: 初始化 Worker 环境并注册

每个 Worker：

```bash
# 在工作目录中初始化
claude-orchestrator setup --name Jerry --role builder

# 注册并启动消息监听
claude-orchestrator register --name Jerry --role builder --work-dir /path/to/project
```

Leader TUI 将显示 Worker 上线。

### 步骤 6: 配置命令和缓存目录

默认配置自动写入 `~/.claude-orchestrator/config.json`：

```json
{
  "command": "claude --dangerously-skip-permissions -v",
  "cache_dir": "~/.claude-orchestrator/sessions"
}
```

若有自定义需求，可手动编辑或通过 setup 参数指定：

```bash
claude-orchestrator setup --leader --name Tom \
  --command "claude --dangerously-skip-permissions -v --model opus" \
  --cache-dir /shared/team-sessions
```

**重要**: Leader 和所有 Worker 必须配置相同的 `cache_dir` 路径，以共享日志和结果文件。

### 步骤 7: 验证

1. Leader TUI 显示所有在线 Worker ✓
2. Leader TUI 中 `msg Jerry "任务描述"` 发送消息，Worker watcher 接收并处理 ✓
3. Worker `claim-task` 认领并 `complete-task` 完成 ✓
4. Worker `request-help` 广播求助，其他 Worker 的 watcher 自动处理 ✓
5. Worker 使用 `worker.md` 模板发送回复，告知 Leader 结果路径 ✓
6. 关闭 Worker 进程，Leader TUI 显示离线 ✓
7. 重启 Leader，自动扫描 /instances 和 /tasks 恢复状态 ✓
8. CACHE_DIR 中的日志文件可供 Leader 和 Worker 互相读取 ✓

## 兼容性说明

### ZK 数据兼容

v0.3.0 可以读取 v0.2.0 创建的 ZK 节点数据：

- `/instances/*`: 兼容。`work_dir` 字段缺失时默认为空
- `/tasks/pending/*`: 兼容。`retry_count`、`created_by_name` 等新增字段缺失时使用默认值
- `/tasks/claimed/*`: 部分兼容。`task_data` 缺失时，孤儿任务回收需要从 `/tasks/pending` 或 `/tasks/completed` 查找原始任务数据
- `/messages/*`: 完全兼容。`reply_to` 缺失时默认为 null
- `/context/*`: 完全兼容

### 无需数据迁移

v0.3.0 的新增字段都有合理的默认值，无需手动迁移已有的 ZK 数据。但建议在升级后重启 ZK 集群（或在维护窗口清理旧节点）以获得干净的节点状态。

### 回滚

如果需要回滚到 v0.2.0：

```bash
# 1. 停止 v0.3.0 Leader
# 在 Leader TUI 中: quit

# 2. 降级包
npm install -g @adamancyzhang/claude-orchestrator@0.2.8

# 3. 恢复 MCP 配置
claude-orchestrator setup --name Jerry --role builder

# 4. 重启 MCP Server
claude-orchestrator server

# 5. ZK 数据兼容，MCP Server 自动读取
```

## 常见问题

### Q: 没有 Leader 能工作吗？

可以。大部分 CLI 命令（push-task, claim-task, send-message 等）直接操作 ZK，不依赖 Leader。Leader 提供：
- 实时 TUI 可视化
- 孤儿任务自动回收
- 集中管理界面

没有 Leader 时，Member 之间的通信和任务认领仍然正常工作。

### Q: 多个 Leader 同时启动会怎样？

只有第一个 Leader 能成功创建 `/leader` EPHEMERAL 节点。后续 Leader 启动时 `create` 失败，输出 `Another leader is already running` 并退出。

### Q: Worker watcher 的 `$COMMAND -p` 调用会阻塞吗？

每个 Worker watcher 串行处理消息，因为多个并发调用可能导致 session 冲突。

### Q: 消息和日志会丢失吗？

不会。消息存储在 ZK PERSISTENT_SEQUENTIAL 节点中。日志通过 `tee` 同时写入终端和 CACHE_DIR 文件。即使 Worker 离线，消息也会在重连后被处理。

### Q: 没有 Leader 能工作吗？

可以。大部分 CLI 命令直接操作 ZK。Leader 提供 TUI 可视化和孤儿任务自动回收。没有 Leader 时，Worker 之间的通信和任务认领仍然正常。

### Q: CACHE_DIR 必须是共享文件系统吗？

是的。Leader 写入的任务文档和 Worker 的执行日志都存储在 CACHE_DIR 中，Leader 和 Worker 需要读取彼此的文件。在同一台机器或 NFS 上配置相同路径即可。

### Q: 模板文件可以自定义吗？

可以。`setup` 写入的 `.claude-orchestrator/agents/leader.md` 和 `worker.md` 可以在部署前编辑，适应团队的具体需求。后续 `setup` 不会覆盖已存在的模板。
