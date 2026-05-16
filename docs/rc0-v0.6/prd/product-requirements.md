# Product Requirements — Claude Orchestrator v0.6

## 1. 产品定位

Claude Orchestrator 是一个 **CLI 原生的多 Agent 编排系统**，通过 ZooKeeper 直连提供分布式状态，依照 **Plan → Build → Verify → Review → Accept** 责任链推进任务闭环。

一句话：**一键启动 Leader TUI + N 个 Worker，输入需求，自动拆解、执行、验证、审查、验收。**

## 2. 核心价值

| 维度 | 价值 |
|------|------|
| **一键启动** | `claude-orchestrator run --worker N` 完成全部环境配置 + 进程启动 |
| **零运维** | 无 HTTP 服务、无 MCP Server、无数据库 —— 只需 ZooKeeper + claude CLI |
| **责任闭环** | Plan → Build → Verify → Review → Accept 五环节，任一环节可反馈上游 |
| **Worker 隔离** | 每个 Worker 运行在独立 git worktree 中，互不干扰 |
| **角色解耦** | 名称是身份，角色是权重 —— 任何 Worker 可承担任意环节 |
| **CLI-native** | 所有交互通过 CLI + ZK Watch 完成，无需 IDE、浏览器 |

## 3. 身份体系

### 3.1 角色定义

| 角色 | 标识 | 责任链位置 | 核心职责 |
|------|------|-----------|---------|
| **Leader** | `leader` | 协调者（不在链中） | 接收需求 → 拆解任务链 → 调度 Worker → 跟踪闭环 |
| **Planner** | `planner` | 链首：定义 | 把握整体方向，定义任务蓝图，拆解执行路径 |
| **Builder** | `builder` | 链中：执行 | 按蓝图执行任务，产出可验证的结果 |
| **Verifier** | `verifier` | 链中：验证 | 验证 Builder 产出与蓝图的一致性，发现偏离 |
| **Reviewer** | `reviewer` | 链中：审查 | 审查产出是否符合设计意图，签发 Pass/Revise |
| **Accepter** | `accepter` | 链尾：验收 | 从业务需求角度验收，签署 Go/No-Go |

### 3.2 关键设计：角色是权重，不是身份

Worker 的角色不是固定身份，而是任务认领的预设权重：

1. **注册时的 role 只是权重偏好** —— 任何 Worker 能认领任意环节的任务
2. **认领任务后才确定当前角色** —— 认领了 `build` link，当前就是 Builder
3. **空闲 Worker 可跨角色协助** —— 预设角色不匹配也可认领积压任务
4. **认领优先级**：显式指派 > role-link 匹配 > priority > FIFO

### 3.3 名称-角色解耦

- **名称**是身份标识，来自内置 20 个拟人化名称池（Tom / Jerry / Lucy / ...）
- **角色**是权重偏好，按优先级顺序分配（planner > builder > verifier > reviewer > accepter）
- 二者绑定关系持久化到 config.json

## 4. 责任链模型

```
需求进入
    │
    ▼
┌─────────┐     ┌──────────┐     ┌─────────┐     ┌──────────┐     ┌──────────┐
│  Plan   │ ──▶ │  Build   │ ──▶ │ Verify  │ ──▶ │  Review  │ ──▶ │  Accept  │ ──▶ 闭环
│         │     │          │     │         │     │          │     │          │
│Planner  │     │Builder   │     │Verifier │     │Reviewer  │     │Accepter  │
└─────────┘     └──────────┘     └─────────┘     └──────────┘     └──────────┘
     │               │                │               │                │
     └───────────────┴────────────────┴───────────────┴────────────────┘
           任一环节发现问题均可向前反馈至对应环节
```

每个环节的产出与进入下一环节的条件：

| 环节 | 产出 | 进入下一环节条件 |
|------|------|----------------|
| Plan | 蓝图文档、任务规格 | 蓝图清晰，Builder 理解无歧义 |
| Build | 实现结果、commit hash | 产出可被验证 |
| Verify | 验证报告、问题清单 | 关键问题已修复或记录 |
| Review | 审查结论 (Pass/Revise) | 质量问题已解决 |
| Accept | 验收报告、Go/No-Go | Go 则闭环；No-Go 反馈上游 |

## 5. 关键用户场景

### 5.1 场景一：首次启动

```bash
# 一键启动 5 个 Worker 的完整编排环境
claude-orchestrator run --worker 5
```

系统自动完成：
1. 环境自检（config、CLAUDE.md、skills、worktree、npm install）
2. 分配 5 个 Worker（Tom/planner、Jerry/builder、Lucy/verifier、Thomas/reviewer、Jack/accepter）
3. 创建 5 个 git worktree + 独立分支
4. 启动 Leader TUI + fork 5 个 Worker 子进程
5. 展示 TUI 界面，等待用户输入

### 5.2 场景二：输入需求，推进责任链

1. 用户在 TUI 输入框输入需求："实现用户认证模块"
2. Leader 将需求拆解为 5 个任务（Plan → Build → Verify → Review → Accept）
3. Tom(planner) 认领 Plan 任务 → 输出蓝图
4. 自评估通过 → 激活 Build 任务
5. Jerry(builder) 认领 Build 任务 → 实现代码 → 自动 commit
6. 自评估通过 → 激活 Verify 任务
7. ...依次推进至 Accept 环节
8. Jack(accepter) 签署 Go → 链关闭

### 5.3 场景三：Worker 崩溃恢复

1. Jerry(builder) 正在执行 Build 任务时子进程崩溃
2. ZK `/instances/Jerry` EPHEMERAL 节点自动删除
3. Leader 检测到 Worker 离开 → 孤儿任务回收
4. 任务 retry_count++ 后重新入 pending 队列
5. 主进程自动重启 Jerry 子进程（最多 3 次）
6. 其他 Builder（如有）可认领该任务继续

### 5.4 场景四：跨角色协助

1. Build 环节 5 个任务积压
2. Lucy(verifier) 空闲，认领 Build 任务
3. TUI 显示 Lucy 的 Current Role 为 "Builder ◀←"（表示跨角色协助）
4. Lucy 按 Build 模板执行，无需额外配置

## 6. Worker 隔离与身份注入

### 6.1 Git Worktree 隔离

每个 Worker 在独立的 git worktree 中运行：

```
<project>/.claude-orchestrator/worktree/
├── Tom/        # branch: claude-orchestrator/Tom-workspace
├── Jerry/      # branch: claude-orchestrator/Jerry-workspace
├── Lucy/       # branch: claude-orchestrator/Lucy-workspace
├── Thomas/     # branch: claude-orchestrator/Thomas-workspace
└── Jack/       # branch: claude-orchestrator/Jack-workspace
```

隔离维度：
- **文件系统**：每个 Worker `chdir` 到自己的 worktree
- **Git 状态**：独立分支，互不干扰
- **进程**：子进程独立内存空间

### 6.2 身份注入分离

Worker 身份信息通过 `--append-system-prompt` 注入 system prompt，任务内容通过 `-p` 注入 user prompt，二者分离以便缓存复用：

```bash
claude --append-system-prompt '## Worker Identity
You are **Tom**, a **planner**...
- Name: Tom
- Role: planner
- Worktree: /path/to/worktree/Tom
- Branch: claude-orchestrator/Tom-workspace
- Instance: a1b2c3d4...' \
  -p '## Task
Title: Plan auth module
Description: ...'
```

## 7. 配置分层

四级配置合并（高优先级覆盖低优先级）：

```
CLI 参数 / 环境变量        ← 最高
    ↑
Worktree 配置
    ↑
项目根配置
    ↑
全局配置 (~/.claude-orchestrator/config.json)  ← 最低
```

关键配置项：

| 配置 | 位置 | 说明 |
|------|------|------|
| ZK 连接地址 | 全局 | `zookeeper.url`，可通过 `-z` flag 覆盖 |
| claude-cli 命令 | 全局 | `commands.claude-cli` |
| cache_dir | 全局 | 日志和结果共享目录 |
| hooks | 全局 | 生命周期 shell 脚本 |
| worktree 段落 | 项目根 | 所有 Worker 的 name/role/path/branch/instance_id |
| 单 Worker 身份 | worktree 内 | name/role/instance_id |

## 8. 安全与可靠性

| 维度 | 措施 |
|------|------|
| 单 Leader 保证 | ZK `/leader` EPHEMERAL 节点互斥 |
| Worker 隔离 | git worktree + 独立分支 + 独立 cwd + 子进程独立内存 |
| 孤儿任务恢复 | EPHEMERAL claimed 节点自动删除 → retry_count++ → 重入 pending（max 3 次） |
| 子进程崩溃 | 主进程自动重启（最多 3 次） |
| 父进程崩溃 | 子进程每秒检测父进程存活，父进程消失则主动退出 |
| 合并冲突 | `git merge --abort` + 返回 `review_first`，不破坏 main |
| ZK 临时断开 | 自动重连（指数退避，最多 10 次） |

## 9. 非目标（v0.6 不做）

- Leader 热备 / 高可用
- Web UI / IDE 插件
- MCP Server / HTTP API
- 上下文存储（`/context` ZK 路径）
- 自定义 Hook 事件名扩展
- 任务结果 TTL 自动清理
