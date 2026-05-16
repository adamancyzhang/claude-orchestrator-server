# Workspace Memory — v0.6 工作区内容记忆

> **文档定位**：Worker 在执行时能快速理解项目代码结构的"事实型"记忆层设计。是对现有"过程/角色"型记忆（`templates/claude-memory/`）和"任务产物"型记忆（`docs/<worker>/<date>/`）的正交补充。
> 相关：`execution-runtime.md`（Template 渲染层）、`core/02-task-claim-and-execute.md`（Worker 流水线）、`zk-schema.md`（缓存根路径定义）。

## 1. 动机

### 1.1 现有记忆缺口

v0.6 已具备两类记忆：

| 类别 | 位置 | 内容 | 谁写 / 谁读 |
|------|------|------|-------------|
| 角色规则记忆 | `templates/claude-memory/team-claude.md` + `personal-claude-{role}.md` | 团队公约 + 角色职责 | worktree 初始化时种入；Worker 读 |
| 任务产物记忆 | `${root}/docs/<worker>/<date>/CLAUDE.md` + `<prefix>-<uniqueKey>.md` | 每日上下文 + blueprint / traceability-map 等 5 类 link 产物 | Worker 写；下游链节读 |

**缺的是"代码事实"记忆**：当 Worker 接到一个修改 `packages/worker/src/chain-router.ts`（680 行）的 build 任务时，没有一份速查记忆告诉它"这个文件的公共 API、关键不变式、依赖关系"，只能：
- 直接 `Read` 全文（每次 ~3 KB token 开销）
- 或推断（容易出错）

### 1.2 目标

引入与项目源码树**同构**的 `memory/` 目录，每个源文件配一份 `.md` 摘要，每个目录配一份 `CLAUDE.md` 索引。Workers 在读源文件前先扫这份摘要，可显著降低跨大文件、跨包修改时的认知成本。

## 2. 位置与目录形态

memory 是 **Leader 实例级共享运行时缓存**，挂在现有 `coRootDir()` 之下，与 `chains/` / `tasks/` / `messages/` / `docs/` 并列：

```
${projects_root}/${leader_instance_id}/      # ~/.claude-orchestrator/projects/<leader_id>/
├── chains/<chain_id>/...
├── tasks/<task_id>/...
├── messages/<message_id>/...
├── docs/<worker>/<date>/...
└── memory/                                  # 【本文档主题】
    ├── CLAUDE.md                            # 项目根索引（架构总览）
    └── packages/
        ├── CLAUDE.md                        # packages 目录索引
        ├── worker/
        │   ├── CLAUDE.md                    # worker 包索引
        │   └── src/
        │       ├── CLAUDE.md                # src 目录索引
        │       ├── watcher.md               # watcher.ts 摘要
        │       └── chain-router.md          # chain-router.ts 摘要
        └── ...
```

**镜像规则**：`packages/<x>/<y>/<file>.ts` ↔ `memory/packages/<x>/<y>/<file>.md`。后缀替换为 `.md`，路径其它部分一一对应。

**特性**：
- **不入 git** — 是运行时缓存，与 `docs/<worker>/...` 同生命周期
- **不在 worktree 内** — 所有 Worker 跨 worktree 通过同一绝对路径读写
- **跨 Leader 重启复用** — `leader_instance_id` 持久化在项目级 `.claude-orchestrator/config.json`

**作用范围**：本期只镜像 `packages/`。`tests/` / `docs/` / `templates/` / `skills/` / `scripts/` 不镜像（它们本身已是文档/配置/测试，二次摘要属套娃）。

## 3. 路径辅助函数

定义在 `packages/contracts/src/paths/cachePaths.ts`：

```typescript
export function workspaceMemoryRoot(o: CachePathOptions): string;
//  → ${projects_root}/${leader_instance_id}/memory

export function workspaceMemoryFilePath(
  o: CachePathOptions,
  relativeSourcePath: string,  // e.g. "packages/worker/src/watcher.ts"
): string;
//  → ${root}/memory/packages/worker/src/watcher.md

export function workspaceMemoryDirIndexPath(
  o: CachePathOptions,
  relativeDirPath: string,     // e.g. "packages/worker/src" or "" for root
): string;
//  → ${root}/memory/packages/worker/src/CLAUDE.md
```

`workspaceMemoryFilePath` 自动剥前导斜杠并替换扩展名为 `.md`。
`workspaceMemoryDirIndexPath` 对空串或 `.` 折叠到 `memory/CLAUDE.md`。

单测：`packages/contracts/tests/core/unit/paths.test.ts`。

## 4. 文件格式

### 4.1 单文件摘要 `<file>.md`

```markdown
---
source: packages/worker/src/watcher.ts
source_hash: <git blob sha>
updated_at: 2026-05-16
---

## Purpose
（1–2 句，文件存在的理由）

## Public exports
- `class WorkerWatcher` — ...
- `function startWatchLoop()` — ...

## Key invariants / non-obvious behavior
- ...

## Depends on
- `packages/runtime/src/template.ts`（模板渲染）
- `packages/coordination/...`（ZK watch）

## Touched by chain links
- build / verify
```

`source_hash` 取 `git hash-object <path>`，用于**陈旧检测**：消费者读取时比对，若文件已变化但 hash 未更新 → 标记 stale。

### 4.2 目录索引 `CLAUDE.md`

```markdown
---
dir: packages/worker/src
updated_at: 2026-05-16
---

## 目录职责
（这个目录在系统中承担的角色）

## 入口文件
- `watcher.ts` — Worker 主流水线
- `chain-router.ts` — ...

## 子目录
- `(none)` 或列出

## 关键文件清单
| 文件 | 一句话摘要 |
|------|-----------|
| watcher.md → watcher.ts | 8 步流水线，处理 ZK 消息 |
| chain-router.md → chain-router.ts | 决策路由与 EvalDecision 执行 |
```

## 5. 消费路径

### 5.1 Template 变量注入

`packages/worker/src/watcher.ts` 在调用 `template_engine.render()` 时新增变量：

```typescript
const workspaceMemoryPath = cachePaths.workspaceMemoryRoot(opts.cache_paths);
template_engine.render(tplName, {
  // ... 既有变量 ...
  workspace_memory_path: workspaceMemoryPath,
});
```

模板引擎本身无需修改——它已支持任意 `{{...}}` 变量。

### 5.2 各 link 模板的引导文案

5 份 `worker-{role}-task.md` 各加一段 "Workspace Memory (fast reference)" 小节，告诉 Worker：
- 速查路径：`{{workspace_memory_path}}/<relative-source-path>.md` 和同目录 `CLAUDE.md`
- 性质：hints，不是 ground truth；缺失或 stale 时回落到源文件

## 6. 生命周期

### 6.1 首次填充（bootstrap）

`MemoryBootstrap`（`packages/leader/src/memory-bootstrap.ts`）在 Leader 启动期由 `packages/orchestrator/src/run.ts` 触发，以后台 Promise 运行（不阻塞 Worker 启动）：

1. `isPopulated()` 检查 `${root}/memory/CLAUDE.md` 根索引是否存在；若存在则跳过
2. `enumerateSources()` 通过 `git ls-files -- 'packages/**/*.ts'` 取全集
3. `generateFiles(sources, "skip-existing")` 逐文件调 ClaudeRunner，渲染 `worker-memorize-file.md` → 写 `memory/<path>.md`
4. `generateDirs(grouped)` 按目录调 ClaudeRunner，渲染 `worker-memorize-dir.md`（注入已生成的 Purpose 摘要块）→ 写 `<dir>/CLAUDE.md`
5. `writeRootMarker(stats)` 写根索引 `memory/CLAUDE.md` 作为 populated 哨兵

失败逐项计数但不中断；幂等。

### 6.2 增量刷新（commit-driven）

新增 message type `"memory_refresh"`（`packages/contracts/src/enums.ts`）：

1. Worker 在 chain link 提交成功后（`packages/worker/src/watcher.ts`，commit-checker 调用之后），向 Leader fire-and-forget 发送 `memory_refresh` 消息，body 形如：
   ```json
   {"chain_id": "...", "task_id": "...", "commit_sha": "...",
    "changed_files": ["packages/worker/src/watcher.ts", ...]}
   ```
2. `ChainRouter.route()` 早期分发到 `handleMemoryRefresh()`：解析 payload → 调 `MemoryBootstrap.refreshFiles(changed_files)`
3. `refreshFiles()` 用 `git ls-files` 过滤非源码路径，对剩余路径以 `"force"` 模式重写 memory，并删除受影响目录的 `CLAUDE.md` 后重生

发送失败不阻塞 Worker 任务完成；解析失败不阻塞链路推进。

### 6.3 启动期陈旧扫描

Leader 启动期在 bootstrap 之后调用 `MemoryBootstrap.refreshStale()`：

1. `findStaleEntries()` 递归扫 `memory/` 下所有非 `CLAUDE.md` 的 `.md`，解析 front-matter 中的 `source` 与 `source_hash`
2. 对每条比对 `git hash-object <source>` 与记录值
3. 不匹配的进入 stale 列表 → 调 `refreshFiles(...)` 重生

涵盖 Leader 离线期间代码变化的场景（如开发者在 Leader 不在时手工提交）。

## 7. 与现有架构的关系

| 已有部件 | 影响 |
|----------|------|
| `cachePaths.coRootDir()` | 不变；新增 3 个辅助函数在它之下 |
| Worktree 隔离 | 无影响——memory 在用户目录下，跨 worktree 共享 |
| Git | memory 不入库；不需要 `.gitignore` 例外 |
| Template 引擎 | 不改；新增 `{{workspace_memory_path}}` 变量靠调用方传入 |
| 责任链 | 不改 schema；增量刷新作为独立消息流，不在 plan→accept 主链内 |
| Task / Message 协议 | 不动；后续增量刷新作为普通 message（type 由 chain-router 自定义） |

## 8. 验证清单

- ✅ 路径合成单测：5 个场景（基础路径 / 前导斜杠 / 非 .ts 后缀 / 目录索引 / 根索引）—— `packages/contracts/tests/core/unit/paths.test.ts`
- ✅ Bootstrap 单测：枚举 / 分组 / populated 哨兵 / 全量布局 / 幂等 / 失败计数 —— `packages/leader/tests/core/unit/memory-bootstrap.test.ts`
- ✅ 增量刷新单测：覆盖写 + 目录索引重生成 + glob 过滤 —— 同上文件
- ✅ 陈旧检测单测：source_hash 不匹配检出 + CLAUDE.md 跳过 + refreshStale 一次性闭环 —— 同上文件
- ✅ Chain-router memory_refresh 路由单测：payload 解析 / 空载 / malformed / 未注入 bootstrap —— `packages/leader/tests/core/unit/chain-router.test.ts`
- ⏳ E2E：清空 memory → 启动 Leader（真实 claude-cli + ZK）→ 期望 packages/**/*.ts 100% 覆盖、build 链节后涉及文件 source_hash 更新
- ⏳ Worker 消费验证：build 链节 Bash hook 记录 `Read memory/...` 的实际调用
