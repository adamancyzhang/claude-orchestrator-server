# 迁移指南: v0.2.0 → v0.3.0

## 概述

v0.3.0 是一次破坏性变更：完全移除 MCP Server，改为 Leader + CLI-native 架构。

## 破坏性变更清单

### 1. CLI 命令变化

| v0.2.0 | v0.3.0 | 操作 |
|--------|--------|------|
| `claude-orchestrator server` | `claude-orchestrator leader` | 替换命令 |
| `claude-orchestrator setup` | **删除** | 不再需要 MCP 配置 |
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
# 编辑 ~/.claude/mcp.json 或项目 .claude/mcp.json
# 删除 "orchestrator" 条目

# 清理旧的 MCP 配置 (可选)
rm -f .claude/mcp.json   # 如果整个文件只有 orchestrator 配置
```

### 步骤 3: 启动 Leader

```bash
# 在新终端中启动 Leader
claude-orchestrator leader

# 如果 ZK 在其他地址:
claude-orchestrator leader -z 10.0.0.1:2181
```

你将看到 Leader TUI 界面。

### 步骤 4: 注册 Member

每个 Claude Code 实例：

```bash
# 替代原来的 setup + MCP 连接流程
claude-orchestrator register \
  --name Jerry \
  --role developer \
  --work-dir /path/to/project
```

实例将注册到 ZK，并开始监听消息。Leader TUI 将显示新成员上线。

### 步骤 5: 移除旧的 MCP 注册方式

v0.2.0 在 Claude Code 中通过 MCP 工具 `register_instance` 注册。v0.3.0 中 Claude Code 实例不再需要调用 MCP 工具，而是：

1. **自动注册**: `register --work-dir` 一次性完成注册 + 消息监听
2. **CLI 命令**: Claude Code 调用 `claude-orchestrator claim-task` / `complete-task` 等命令

如果你在 Claude Code 中配置了自动调用 `register_instance` 的 hook 或 prompt，需要更新：

```bash
# v0.2.0 方式 (已废弃)
# Claude Code: 调用 MCP tool register_instance

# v0.3.0 方式
# Terminal: claude-orchestrator register --name X --role Y --work-dir Z
# Claude Code: 直接调用 CLI 命令 (claim-task, complete-task, etc.)
```

### 步骤 6: 更新 Claude Code 中的命令

如果你的 Claude Code 实例需要通过 CLI 与团队交互，直接调用命令即可：

```bash
# 认领任务
claude-orchestrator claim-task

# 完成任务
claude-orchestrator complete-task --task-id task-0000000001 --result "..."

# 求助
claude-orchestrator request-help --question "..."

# 发送消息
claude-orchestrator send-message --to-name Jerry --content "..."
```

### 步骤 7: 验证

1. Leader TUI 显示所有在线成员 ✓
2. 从 Leader TUI `task push` 创建任务 ✓
3. Member `claim-task` 认领并 `complete-task` 完成 ✓
4. Member `request-help` 广播求助，其他 Member 的 watcher 自动处理 ✓
5. `send-message` 点对点通信正常 ✓
6. 关闭 Member 进程，Leader TUI 显示离线 ✓
7. 重启 Leader，自动扫描并恢复状态 ✓

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
claude-orchestrator setup --name Jerry --role developer

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

### Q: Member watcher 的 `claude -p` 调用会阻塞吗？

每个 Member watcher 串行处理消息（一次处理一条），因为多个 `claude -p` 并发可能导致 session 冲突。如果一条消息处理时间很长，后续消息会排队等待。

### Q: 消息会丢失吗？

不会。消息存储在 ZK PERSISTENT_SEQUENTIAL 节点中。即使 Member 离线，消息也会在 `register --work-dir` 重连后被处理。

### Q: 任务会丢失吗？

不会。已认领但实例断连的任务会被 Leader 自动回收到 pending 队列。没有 Leader 时，任务的 EPHEMERAL claimed 节点也会因 ZK session 超时自动删除，但需要 Leader 重启后来回收。
