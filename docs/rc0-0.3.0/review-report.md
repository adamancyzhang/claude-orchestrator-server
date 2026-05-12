# rc0-0.3.0 设计实现审查报告

审查日期：2026-05-12

## 1. 总体评估

**结论：核心功能已全部实现，存在 6 项待补充功能。**

- 设计文档 7 篇，覆盖角色体系、Leader/Worker 流程、CLI 命令、ZK Schema、架构细节
- 已实现 CLI 命令 15 个（全部覆盖设计）
- Leader 模块 8 个文件已实现，Worker 模块、模板系统、核心模块均已就位
- 测试覆盖：2 个单元测试文件 + 1 个集成测试文件

---

## 2. CLI 命令 — 全部通过 ✓

| 命令 | 设计 | 实现 | 状态 |
|------|:---:|:---:|:----:|
| `leader` | ✓ | ✓ | 通过 |
| `register` | ✓ | ✓ | 通过 |
| `unregister` | ✓ | ✓ | 通过 |
| `config` | ✓ | ✓ | 通过 |
| `setup` | ✓ | ✓ | 通过 |
| `send-message` | ✓ | ✓ | 通过 |
| `poll-message` | ✓ | ✓ | 通过 |
| `delete-message` | ✓ | ✓ | 通过 |
| `push-task` | ✓ | ✓ | 通过 |
| `poll-task` | ✓ | ✓ | 通过 |
| `claim-task` | ✓ | ✓ | 通过 |
| `complete-task` | ✓ | ✓ | 通过 |
| `task-block` | ✓ | ✓ | 通过 |
| `task-fail` | ✓ | ✓ | 通过 |
| `task-retry` | ✓ | ✓ | 通过 |

---

## 3. Leader 模块 — 核心通过，2 项待补充

| 文件 | 设计 | 实现 | 状态 |
|------|:---:|:---:|:----:|
| `leader/index.ts` | ✓ | ✓ | 通过 |
| `leader/tui.ts` | ✓ | ✓ | 通过 |
| `leader/watcher.ts` | ✓ | ✓ | 通过 |
| `leader/monitor.ts` | ✓ | ✓ | 通过 |
| `leader/orchestrator.ts` | — | ✓ | 新增（拆分自 monitor，承担 task watch 职责） |
| `leader/recovery.ts` | ✓ | ✓ | 通过 |
| `leader/event-bus.ts` | ✓ | ✓ | 通过 |
| `leader/state.ts` | ✓ | ✓ | 通过 |
| `leader/task-generator.ts` | ✓ | ✗ | **缺失** |
| `leader/decision-engine.ts` | ✓ | ✗ | **缺失** |

### 3.1 缺失：task-generator.ts

设计要求：Leader 收到用户需求后，通过 Claude + `leader-decompose.md` 模板拆解为结构化任务链 JSON，解析后写入 ZK 任务队列。

当前状态：`leader-decompose.md` 模板已存在，但**没有运行时代码触发此流程**。LeaderWatcher 收到消息后直接用 `execWithTee` 调用 Claude 处理，但未使用 leader-decompose 模板做任务拆解。

### 3.2 缺失：decision-engine.ts

设计要求：Leader 收到 Worker 完成报告后，通过 Claude + `leader-decide.md` 模板评估报告，输出 pass/feedback/reject + next_action 决策。

当前状态：`leader-decide.md` 模板已存在，但**运行时未使用**。LeaderWatcher 处理消息后仅标记已读并记录事件，未执行调度决策逻辑。

---

## 4. Worker 模块 — 全部通过 ✓

| 文件 | 设计 | 实现 | 状态 |
|------|:---:|:---:|:----:|
| `worker/watcher.ts` | ✓ | ✓ | 通过 |

实现要点：
- 监听 `/messages/{instance_id}` 新消息 ✓
- 根据 message.link 选择对应模板（plan/build/verify/review/accept） ✓
- 模板变量替换（{{name}}, {{preset_role}}, {{task_title}} 等 9 个变量）✓
- `execWithTee` 执行 Claude 命令并 tee 到日志 ✓
- 执行完成后向 Leader 发送完成报告 ✓
- 回退到通用 `worker.md` 模板（当 per-link 模板不存在时）✓

---

## 5. 模板系统 — 全部通过 ✓

| 模板文件 | 设计 | 实现 | 状态 |
|---------|:---:|:---:|:----:|
| `leader-decompose.md` | ✓ | ✓ | 通过 |
| `leader-decide.md` | ✓ | ✓ | 通过 |
| `worker-plan.md` | ✓ | ✓ | 通过 |
| `worker-build.md` | ✓ | ✓ | 通过 |
| `worker-verify.md` | ✓ | ✓ | 通过 |
| `worker-review.md` | ✓ | ✓ | 通过 |
| `worker-accept.md` | ✓ | ✓ | 通过 |
| `leader.md` | — | ✓ | 额外（通用 Leader 回退模板） |
| `worker.md` | — | ✓ | 额外（通用 Worker 回退模板） |

---

## 6. 核心模块 — 1 项缺失

| 文件 | 设计 | 实现 | 状态 |
|------|:---:|:---:|:----:|
| `modules/registry.ts` | ✓ | ✓ | 通过 |
| `modules/task-queue.ts` | ✓ | ✓ | 通过 |
| `modules/message-router.ts` | ✓ | ✓ | 通过 |
| `modules/context-store.ts` | ✓ | ✗ | **缺失** |

### 6.1 缺失：context-store.ts

设计要求的共享键值存储模块，提供以下能力：
- `set_context` — 写入键值对
- `get_context` — 读取键值
- `delete_context` — 删除键
- `list_context_keys` — 列出所有键

当前状态：ZK `/context` 路径不存在于 `paths.ts` 的 `ALL_ENSURE_PATHS` 中，ZkClient 无 context 相关方法，CLI 无 context 命令。

---

## 7. 数据模型 — 基本一致，存在小差异

| 模型 | 差异 | 影响 |
|------|------|------|
| Instance | 一致 | 无 |
| Task | 新增字段：`created_by_name`, `assigned_to_name`, `completed_by_name`, `duration_seconds`, `blocked_reason`, `fail_reason` | 正向增强 |
| Task | `depends_on` / `blocked_by` 字段在 Schema 中缺失 | **低影响**（设计定义但 Schema 未包含） |
| Message | `link`, `task_title`, `task_description`, `task_criteria` 已添加 | 与设计一致 |
| Message | `type` 枚举缺少 `help` | **低影响**（help 类型未实现） |
| TaskStatus | 包含 `in_progress`（设计未定义） | 低影响 |

---

## 8. ZooKeeper Schema — 1 项缺失

| 路径 | 设计 | 实现 | 状态 |
|------|:---:|:---:|:----:|
| `/leader` | ✓ | ✓ | 通过 |
| `/instances/{id}` | ✓ | ✓ | 通过 |
| `/tasks/pending/task-{seq}` | ✓ | ✓ | 通过 |
| `/tasks/claimed/{ins}-{task}` | ✓ | ✓ | 通过 |
| `/tasks/completed/{task}` | ✓ | ✓ | 通过 |
| `/messages/{id}/msg-{seq}` | ✓ | ✓ | 通过 |
| `/context/{key}` | ✓ | ✗ | **缺失** |

---

## 9. 配置系统 — 存在结构性差异

| 差异项 | 设计 | 实现 | 影响 |
|--------|------|------|------|
| CLI 命令配置键 | `command` | `commands.claude-cli` | 低（需更新 setup 文档） |
| 额外配置键 | 无 | `commands.leader-sync` | 低（预留扩展） |

---

## 10. setup 命令 — 通过 ✓

- 写入全局配置 ✓
- 写入项目配置 ✓
- 复制 Agent 模板到 `.claude-orchestrator/agents/` ✓
- 已存在模板不覆盖 ✓
- 额外复制了 `leader.md` 和 `worker.md` 通用模板（正向增强）

---

## 11. 测试覆盖

| 测试文件 | 覆盖范围 | 状态 |
|---------|---------|:----:|
| `tests/unit/leader.test.ts` | EventBus, LeaderState, LeaderTui | ✓ |
| `tests/unit/message-watcher.test.ts` | WorkerWatcher 启动/消息处理/错误处理 | ✓ |
| `tests/integration/leader-worker.test.ts` | Leader 注册、Worker 注册、任务生命周期、消息收发、角色权重排序 | ✓ |

集成测试覆盖了 P→B→V→R→A 全链路的 task lifecycle 和 Accepter 角色。

---

## 12. 功能清单总结

### 已实现（通过）

1. 15 个 CLI 命令全部实现
2. Leader TUI 只读面板（Team + Tasks + Event Log + Footer）✓
3. Leader EventBus 事件驱动架构 ✓
4. LeaderState 状态管理 ✓
5. WorkerMonitor / TaskOrchestrator / LeaderWatcher ✓
6. 孤儿任务回收（max 3 retries）✓
7. WorkerWatcher 消息监听 + per-link 模板选择 + Claude 执行 ✓
8. 9 个 Agent 模板文件（设计 7 + 额外 2 通用模板）✓
9. 角色权重排序认领（role-to-link matching）✓
10. ZK 连接管理、自动重连、Watch 重建 ✓
11. 任务状态机（pending→claimed→completed/blocked/failed→retry）✓
12. Instance Registry / Task Queue / Message Router 模块 ✓
13. 全局 + 项目两级配置系统 ✓
14. setup 命令环境初始化 ✓

### 待补充

| # | 项目 | 优先级 | 说明 |
|---|------|:------:|------|
| 1 | `modules/context-store.ts` | 高 | 共享键值存储模块，需 ZK client 方法和 CLI 命令 |
| 2 | `leader/task-generator.ts` | 高 | Claude 驱动的任务拆解管线，使用 leader-decompose.md |
| 3 | `leader/decision-engine.ts` | 高 | Claude 驱动的调度决策管线，使用 leader-decide.md |
| 4 | Context CLI 命令 | 高 | `set-context`, `get-context`, `delete-context`, `list-context-keys` |
| 5 | ZK `/context` 路径 | 中 | paths.ts 和 ALL_ENSURE_PATHS 需补充 |
| 6 | Message `help` 类型 | 低 | 设计定义了 help 类型但 Schema 未包含 |

---

## 13. 设计文档自身问题

| 问题 | 位置 | 说明 |
|------|------|------|
| `depends_on` / `blocked_by` 字段 | README.md §13 | Schema 中未定义这两个字段 |
| `leader.md` / `worker.md` 模板 | — | 实现中新增加的回退模板，设计文档未记录 |
| `orchestrator.ts` | — | 实现从 monitor 拆分出的 task watch 模块，设计文件列表未体现 |

---

## 14. 建议后续迭代优先级

1. **补充 context-store.ts** — 涉及 ZK、CLI、modules 三层的连通
2. **实现 task-generator.ts** — 使 Leader 能够从自然语言需求自动生成任务链
3. **实现 decision-engine.ts** — 使 Leader 能够自动评估 Worker 产出并做出调度决策
4. **补充 Context CLI 命令** — `set-context`, `get-context`, `delete-context`, `list-context-keys`
5. **更新设计文档** — 记录实际实现的差异（额外模板、orchestrator 模块等）
