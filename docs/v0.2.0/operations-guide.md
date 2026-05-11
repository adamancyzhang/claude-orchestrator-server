# Claude Code 连接操作手册

## 1. 前置条件

- ZooKeeper 运行中（`127.0.0.1:2181`）
- MCP Server 运行中（`127.0.0.1:3100`）
- Claude Code 已安装

## 2. 启动 MCP Server

```bash
# 终端 0：启动服务端

# 1. 确保 ZooKeeper 运行（如果没有，用 Docker 启动）
docker-compose up -d

# 2. 安装依赖并编译，启动 MCP Server
cd claude-orchestrator-server
npm install
npm run build
node dist/index.js --server
# 输出: MCP server listening on http://127.0.0.1:3100
```

## 3. 配置 Claude Code 连接

每个 Claude Code 实例需要配置 `.claude/mcp.json`，指向 MCP Server。

**配置文件位置**：你启动 Claude Code 时所在的**工作目录**下的 `.claude/mcp.json`（或全局 `~/.claude/mcp.json`）。

### 3.1 为不同实例创建独立工作目录

为了模拟多实例协同，给每个"角色"创建独立目录，各自拥有 `.claude/mcp.json`：

```bash
# 创建两个工作目录，模拟两个开发者
mkdir -p ~/claude-instances/tom
mkdir -p ~/claude-instances/jerry
```

### 3.2 配置文件

两个实例使用**相同的** mcp.json（因为连接同一个 Server）：

**`~/claude-instances/tom/.claude/mcp.json`** 和 **`~/claude-instances/jerry/.claude/mcp.json`** 内容：

```json
{
  "mcpServers": {
    "orchestrator": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

## 4. 真机测试：两实例协同

### 4.1 启动两个 Claude Code 实例

```bash
# 终端 1：Tom (Architect)
cd ~/claude-instances/tom
claude

# 终端 2：Jerry (Developer)
cd ~/claude-instances/jerry
claude
```

### 4.2 测试流程

以下是完整的端到端测试步骤。每一步标注了在哪个实例的对话中执行。

---

#### Step 1：注册实例身份

每个实例首次使用时，调用 `register_instance` 获取自己的 `instance_id`。

**终端 1 — Tom：**
```
请调用 register_instance 工具，name 设为 "Tom"，role 设为 "architect"，然后记下返回的 instance_id，后面所有的工具调用都要用它。
```

Tom 的 Claude Code 会返回类似：
```json
{
  "id": "a1b2c3d4e5f6...",
  "name": "Tom",
  "role": "architect",
  "status": "idle"
}
```

Tom 记住：`我的 instance_id = a1b2c3d4e5f6...`

**终端 2 — Jerry：**
```
请调用 register_instance 工具，name 设为 "Jerry"，role 设为 "developer"，记下你的 instance_id。
```

Jerry 记住：`我的 instance_id = f6e5d4c3b2a1...`

---

#### Step 2：互相发现

**Tom：**
```
调用 list_instances，看看有哪些人在线。
```

预期结果：
```
2 active instances:
  [architect] Tom (a1b2c3d4...) status=idle
  [developer] Jerry (f6e5d4c3...) status=idle
```

---

#### Step 3：分配任务

**Tom（Architect）分配任务给 Jerry：**
```
调用 push_task：
  title = "实现用户登录接口 POST /api/auth/login"
  description = "按照 OpenAPI 3.0 规范实现，支持邮箱+密码登录，返回 JWT token。需要处理参数校验和错误码。"
  priority = 0
  instance_id = a1b2c3d4e5f6...（Tom 的 ID）
  assignee = f6e5d4c3b2a1...（Jerry 的 ID）
```

再追加一个通用任务：
```
调用 push_task：
  title = "编写 API 集成测试"
  description = "用 pytest + httpx 测试所有接口的 happy path 和异常情况"
  priority = 1
  instance_id = a1b2c3d4e5f6...（Tom 的 ID）
```

---

#### Step 4：认领任务

**Jerry（Developer）认领任务：**
```
调用 claim_task，instance_id 用你的 ID（f6e5d4c3b2a1...）
```

预期结果（因为 assigned_to 匹配 Jerry，优先分配）：
```
Claimed task task-0000000000
  title: 实现用户登录接口 POST /api/auth/login
  description: 按照 OpenAPI 3.0 规范实现...
```

Jerry 记下 task_id：`task-0000000000`。

**再次认领第二个任务：**
```
再调用一次 claim_task，instance_id 用你的 ID
```

预期结果：
```
Claimed task task-0000000001
  title: 编写 API 集成测试
```

---

#### Step 5：更新心跳

**Jerry 开始工作，更新状态：**
```
调用 heartbeat：
  instance_id = f6e5d4c3b2a1...
  current_task = "task-0000000000"
```

**Tom 检查状态：**
```
调用 list_instances，看看 Jerry 在做什么。
```

预期 Jerry 状态变为 `busy`，current_task_id 显示正在做的任务。

---

#### Step 6：发送求助（跨实例消息）

**Jerry 遇到问题：**
```
调用 request_help：
  instance_id = f6e5d4c3b2a1...
  question = "JWT token 的过期时间应该设多久？access token 和 refresh token 分别怎么处理？"
  context = "当前技术栈：FastAPI + python-jose，用户量预期 10万 DAU"
```

---

#### Step 7：检查消息

**Tom 检查消息：**
```
调用 poll_messages，instance_id 用你的 ID（a1b2c3d4e5f6...）
```

预期结果：
```
1 message(s):
  [broadcast] from Jerry: JWT token 的过期时间应该设多久？...
```

**Tom 回复 Jerry：**
```
调用 send_message：
  instance_id = a1b2c3d4e5f6...
  content = "access_token 设 15 分钟，refresh_token 设 7 天。用 redis 黑名单来处理登出。"
  to_instance = f6e5d4c3b2a1...（Jerry 的 ID）
```

**Jerry 收消息：**
```
调用 poll_messages，instance_id 用你的 ID
```

---

#### Step 8：共享上下文

**Tom 记录架构决策：**
```
调用 set_context：
  key = "jwt_strategy"
  value = "access_token: 15min, refresh_token: 7d, 黑名单用 redis"
  instance_id = a1b2c3d4e5f6...
```

**Jerry 查阅：**
```
调用 get_context，key = "jwt_strategy"
```

---

#### Step 9：完成任务

**Jerry 完成第一个任务：**
```
调用 complete_task：
  instance_id = f6e5d4c3b2a1...
  task_id = task-0000000000
  result = "PR #42 — 实现了 POST /api/auth/login，包含参数校验、JWT 签发、错误码映射，已通过单元测试"
```

**Tom 验证：**
```
调用 list_tasks 查看任务状态
调用 list_instances 看 Jerry 是否回到 idle
```

---

#### Step 10：查看全局状态

```
调用 list_tasks（不带参数）— 看所有任务状态
调用 list_instances — 看所有实例状态
```

### 4.3 完整对话示例

以下是 Tom 的 Claude Code 终端中第一轮对话的实际写法：

```
我连接了一个 MCP 工具叫做 orchestrator。请你帮我完成以下操作：

1. 首先调用 register_instance，参数 name="Tom", role="architect"
   记下返回的 instance_id，后面所有工具都要传这个 ID。

2. 然后调用 list_instances 看看当前有哪些实例在线。

完成后告诉我结果。
```

Jerry 的终端类似，用 `name="Jerry", role="developer"`。

## 5. 工具速查

| 工具 | 关键参数 | 谁调用 |
|------|---------|--------|
| `register_instance` | `name`, `role` | 每个实例启动时调用一次 |
| `heartbeat` | `instance_id`, `current_task?` | 定期更新状态 |
| `list_instances` | — | 查看谁在线 |
| `push_task` | `title`, `description`, `priority`, `instance_id`, `assignee?` | Architect 分配任务 |
| `claim_task` | `instance_id` | Developer 认领任务 |
| `complete_task` | `instance_id`, `task_id`, `result` | Developer 完成任务 |
| `list_tasks` | `status?` (pending/claimed/completed) | 查看任务状态 |
| `send_message` | `instance_id`, `content`, `to_instance?`, `broadcast?` | 发送消息 |
| `poll_messages` | `instance_id` | 检查新消息 |
| `wait_for_message` | `instance_id`, `timeout_seconds?` | 阻塞等待新消息 |
| `dismiss_message` | `instance_id`, `message_id` | 删除消息 |
| `mark_read` | `instance_id`, `message_id` | 标记消息已读 |
| `request_help` | `instance_id`, `question`, `context?` | 求助广播 |
| `set_context` | `key`, `value`, `instance_id?` | 写入共享配置 |
| `get_context` | `key` | 读取共享配置 |
| `delete_context` | `key` | 删除共享配置 |
| `list_context_keys` | — | 列出所有上下文键 |
| `server_status` | — | 健康检查 |

## 6. 重要提示

### instance_id 的生命周期

- `register_instance` 返回的 `instance_id` 是 UUID
- 实例**断线后**其在 ZooKeeper 中的 Ephemeral 节点会被自动清除
- 重新连接时需要**再次调用** `register_instance`，会得到**新的** instance_id
- Claude Code 会在对话上下文中记忆 instance_id，但重启后需要重新注册

### 角色说明

| 角色 | 值 | 典型职责 |
|------|-----|---------|
| Architect | `architect` | 制定规范、分配任务、审核结果 |
| Developer | `developer` | 认领任务、编码实现、提交 PR |
| Tester | `tester` | 认领测试任务、E2E 验证 |
| General | `general` | 通用角色 |

### 任务优先级

| 值 | 含义 | 认领顺序 |
|----|------|---------|
| `0` | HIGH | 优先分配 |
| `1` | MEDIUM | 默认 |
| `2` | LOW | 最后分配 |

## 7. 故障排查

### Server 连接不上

```bash
# 确认 server 在运行
curl -s http://127.0.0.1:3100/mcp
# 正常应返回 JSON-RPC 错误（406 Not Acceptable — 这是正常的，说明 server 在监听）

# 确认 ZooKeeper 在运行
echo stat | nc 127.0.0.1 2181
# 正常应返回 ZK 状态信息
```

### 工具调用报错 "instance not found"

说明 instance_id 过期或不存在。重新调用 `register_instance` 获取新的 ID。

### 任务认领不到

- 调用 `list_tasks status=pending` 确认有待办任务
- 如果有 `assigned_to` 指定了其他实例，需那个实例来认领
- 检查 instance_id 是否正确

### 两个实例都在同一台机器

完全没问题。每个实例在独立终端中运行 Claude Code，各自维护独立的对话上下文。ZooKeeper 根据 UUID 区分不同实例。
