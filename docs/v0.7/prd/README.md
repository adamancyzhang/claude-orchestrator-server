# Product Requirements — Claude Orchestrator v0.7

## 1. 文档定位

本目录是 Claude Orchestrator **v0.7 的产品需求基线**。内容由两部分构成：

1. **v0.6 RC0 继承基线**：全部 24 项已实现功能（A-01 ~ A-24）+ 7 项 RC0 修复（R-01 ~ R-07）+ 14 项已知边界的体系化重写，作为 v0.7 的稳定底盘
2. **[v0.7 NEW] 自主循环调度增量**：
   - role 重命名：`builder` → `executor`、link `build` → `execute`
   - 新增 `explorer` role 与 `explore` 链节（第 6 链节，仅 `--magic` 模式存在）
   - 新增 `--magic` 启动开关 + `--magic-max-chains M` 上限
   - EvalDecision 新增 `spawn_chain` 第 5 态（仅 explore link 合法）
   - ChainManifest 新增 `parent_chain_id` / `child_chain_ids` / `chain_depth` / `magic_mode` 字段
   - PROTOCOL_VERSION 升至 `"0.7.0"`，与 v0.6 不兼容、不混跑

让 PM、新成员、架构师、验收人能在一组文档内掌握完整产品形态。

**v0.7 NEW** 标签：本目录所有新增内容均以 `**[v0.7 NEW]**` 标记；renamed 内容以 `**[v0.7 rename]**` 标记。`grep -rn "v0.7 NEW\|v0.7 rename" docs/v0.7/prd/` 可一次性列出全部增量。

本目录**只包含 PRD**。详细设计（DD）、核心链路、贯穿样例、测试用例、验收清单沿用 `../../rc0-v0.6/` 不动；v0.7 NEW 的 DD 单独迭代，本 PRD 不写实现细节。

## 2. 与 docs/rc0-v0.6/prd/ 的关系

| 维度 | `rc0-v0.6/prd/product-requirements.md` | `v0.7/prd/`（本目录） |
|------|---------------------------------------|---------------------|
| 体量 | 单文件 8.5 KB | 8 文件 ≈ 32 KB |
| 内容时态 | v0.5 遗留 + 沿用 v0.6 | RC0 完整快照 |
| 覆盖 RC0 修复 | ❌ 未提及 R-01 ~ R-07 | ✅ 全部嵌入功能需求 + 场景 |
| 覆盖已知边界 | ❌ 仅"非目标"6 条 | ✅ 5 类 14 条结构化呈现 |
| 场景颗粒度 | 4 个 happy 场景 | 9 个端到端场景，含 5 个 RC0 边界场景 |
| 功能清单 | 散在正文 | FR 编号，按 10 个功能域分组 |
| 术语表 | 无 | 有 |

迁移读者：

| 原 `rc0-v0.6/prd/` 章节 | 在 v0.7 中的位置 |
|------------------------|-----------------|
| §1 产品定位、§2 核心价值 | `01-overview.md` |
| §3 身份体系、§6 Worker 隔离与身份注入 | `02-personas-and-roles.md` |
| §4 责任链模型 | `01-overview.md` §3 + `04-functional-requirements.md` §3 |
| §5 关键用户场景 | `03-scenarios.md` |
| §7 配置分层、§8 安全与可靠性 | `05-non-functional.md` |
| §9 非目标 | `06-boundaries.md` |

## 3. 目录索引

| 文件 | 回答的问题 |
|------|-----------|
| `01-overview.md` | 这是什么产品，为什么做，核心价值是什么 |
| `02-personas-and-roles.md` | 谁是用户，系统内有哪些角色，名称-角色如何解耦，Worker 如何隔离 |
| `03-scenarios.md` | 用户实际操作时会发生什么（含 happy path + RC0 边界场景） |
| `04-functional-requirements.md` | 系统必须具备哪些功能（FR-01 ~ FR-30），每个 FR 的完成判定 |
| `05-non-functional.md` | 可靠性、性能、安全、可观测、可配置如何保证 |
| `06-boundaries.md` | v0.6 不做、不保证哪些能力，哪些是 v0.7 候选 |
| `07-glossary.md` | 术语统一释义 |

## 4. 阅读路径

**PM / 决策者**：`01` → `03` → `06`

**新成员**：`01` → `02` → `03` → `07` → 按需展开 `04` `05`

**架构师**：`01` → `04` → `05` → `06`，配合 `../../rc0-v0.6/dd/architecture.md`

**验收人**：`04` 的完成判定列 + `06` 的边界声明 + `../../rc0-v0.6/acceptance-checklist.md` 的逐项勾选

## 5. 与 RC0 验收的衔接

PRD 不重复 `acceptance-checklist.md` 的逐项勾选步骤；`04-functional-requirements.md` 每条 FR 只给出 2-3 条"done 判定"。完整勾选步骤仍以 `../../rc0-v0.6/acceptance-checklist.md` 为准，FR 编号与该 checklist 中 A-/R- 编号一一对应（见 `04-functional-requirements.md` 末尾的追溯表）。
