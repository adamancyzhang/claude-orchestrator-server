# 01 — 产品总览

> **文档定位**：v0.7 的产品定位、核心价值、责任链模型与设计哲学。回答"这是什么、为什么做"。

## 1. 一句话定义

Claude Orchestrator 是 **CLI 原生的多 Agent 编排系统**：一键启动 Leader TUI + N 个 Worker，输入自然语言需求，系统自动按 **Plan → Build → Verify → Review → Accept** 五环责任链拆解、执行、自评估、合并、闭环。

- 无 HTTP / 无 MCP Server / 无数据库 —— 仅需 ZooKeeper + `claude` CLI
- 所有跨进程通信通过 ZK Watch；所有 Agent 执行通过 `claude -p` 子进程
- 每个 Worker 独占一个 git worktree + 独立分支
- 每条链路都有显式的自评估与失败回退路径

## 2. 核心价值

| # | 价值维度 | 兑现方式 |
|---|---------|---------|
| 1 | **一键启动** | `claude-orchestrator run --worker N`（N≥6，默认 6）一条命令完成环境自检、worktree 创建、Leader+Worker 子进程启动 |
| 2 | **零运维** | 无服务器进程、无配置中心、无数据库迁移；ZK + claude CLI 两个外部依赖 |
| 3 | **责任闭环** | Plan/Build/Verify/Review/Accept 五环节顺序推进；每环节自评估输出 4 态决策（activate_next / feedback / reject / close_chain）；任一环节可单步反馈到上一环节 |
| 4 | **角色权重而非身份** | 任何 Worker 可认领任意环节；预设 role 只影响认领排序；空闲 Worker 可跨角色协助 |
| 5 | **Worker 隔离** | 每 Worker 独占 git worktree + 独立分支 + 独立 cwd + 独立子进程内存 |
| 6 | **失败显式化** | commit 失败强制 feedback、merge 冲突走 `merge_failed` 终态并自动派 retry、反馈累计超 9 次自动 abort、chain_id 冲突拒绝、自评估三连失败一律 reject —— 不允许失败被静默吞噬 |
| 7 | **CLI-native** | TUI 键盘交互完成全部用户操作；无浏览器、无 IDE 插件、无 GUI |

## 3. 责任链模型

```
需求进入
    │
    ▼
┌─────────┐     ┌──────────┐     ┌─────────┐     ┌──────────┐     ┌──────────┐
│  Plan   │ ──▶ │  Build   │ ──▶ │ Verify  │ ──▶ │  Review  │ ──▶ │  Accept  │ ──▶ 闭环
│Planner  │     │Builder   │     │Verifier │     │Reviewer  │     │Accepter  │
└─────────┘     └──────────┘     └─────────┘     └──────────┘     └──────────┘
     │               │                │               │                │
     └───────────────┴────────────────┴───────────────┴────────────────┘
            任一环节自评估失败 → 单步反馈至上一环节
            累计反馈 ≤ max_total_retries（默认 9）；超限 → 链 aborted
```

每环节的产出与放行条件：

| 环节 | 主要产出 | 进入下一环节的条件 |
|------|---------|------------------|
| Plan | 蓝图文档、任务规格 | 蓝图清晰，Builder 可直接动手 |
| Build | 实现代码 + 自动 commit | commit 成功且产出可被验证 |
| Verify | 验证报告 + 问题清单 | 关键问题已修复或显式记录 |
| Review | Pass/Revise 审查结论 | 质量问题已解决 |
| Accept | 验收报告 + Go/No-Go | Go → close_chain → MergeValidator 合并到 main；No-Go → feedback |

EvalDecision 4 态语义：

| decision | 触发的下一动作 |
|---------|---------------|
| `activate_next` | 派发下一 link 的任务 |
| `feedback` | 派发上一 link 的 retry 任务（计入 `total_retry_count`） |
| `reject` | 链直接终结为 `aborted`（不再 push 任何 task） |
| `close_chain` | 触发 MergeValidator，合并成功则链 `completed`，失败则 `merge_failed` 并派 builder retry |

## 4. 设计哲学

### 4.1 CLI-native 而非 GUI-native

所有用户交互通过 TUI 键盘完成（输入框、Tab/Shift+Tab/1-9 切换 Worker 焦点、Enter 提交、Esc 清空、? 帮助、Ctrl+C 关停）。所有跨进程通信通过 ZK Watch 触发 `claude -p`。这避免了 Web UI / IDE 插件带来的多端同步问题与认证复杂度。

### 4.2 零中心化运行时

没有 MCP Server、没有 HTTP Endpoint、没有任务调度服务。Leader 与 Worker 都是 `claude-orchestrator` 同一可执行文件下的角色，直接与 ZK 通信。整个系统的唯一关键路径是 ZK 节点的 EPHEMERAL 语义与 SEQUENTIAL 顺序。

### 4.3 角色是权重，不是身份

Worker 启动时的 `role` 只是任务认领时的偏好分数（planner→plan 权重 100，其它 link 权重 10-20）。当某 link 任务积压且首选 role 全忙时，其它 role 的空闲 Worker 会按权重表兜底认领。认领顺序固定：**显式指派 > role-link 匹配 > priority > FIFO**。

### 4.4 失败显式化

每一条失败路径都有显式的"被用户看到"的产出：

- `commit failed` → 走 feedback 回到同 Worker，audit 记 `feedback_sent`，TUI EVENT LOG 出现 retry 派发
- `merge conflict` → 链终态 `merge_failed`，TUI EVENT LOG 出现红色 `MERGE_FAILED chain <id>: N branch(es) ...`，Builder 收件箱出现 conflict resolve 任务
- `feedback ceiling exceeded` → 链终态 `aborted`，TUI 出现 `[debug] chain <id> aborted: retry ceiling N exceeded`
- `chain_id 冲突` → 拒绝、原 manifest 不被覆盖，audit 记 `chain_id_conflict`
- `evaluator 三连失败` → 强制 `reject`（不允许 accept link "无声签字"绕过质量门）

详见 `03-scenarios.md` S-05 ~ S-09 与 `04-functional-requirements.md` 失败保护组。

### 4.5 协议优先

`@co/contracts` 是唯一的"协议真相源"：所有 Zod schema、所有 branded ID、所有错误类、`PROTOCOL_VERSION` 字段集中在此。任何对 contracts 的破坏性变更视为 v0.8 候选（v0.7 维持 `PROTOCOL_VERSION = "0.6.0"`，Worker 启动校验 `/leader` 协议版本不匹配即退出）。
