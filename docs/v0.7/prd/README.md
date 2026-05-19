# Product Requirements — Claude Orchestrator v0.7

## 1. 文档定位

本目录是 Claude Orchestrator **v0.7 的产品需求基线**，是产品需求的唯一权威来源。内容由两部分构成：

1. **v0.6 RC0 继承基线**：全部 24 项已实现功能（A-01 ~ A-24）+ 7 项 RC0 修复（R-01 ~ R-07）+ 14 项已知边界的体系化重写，作为 v0.7 的稳定底盘
2. **自主循环调度增量**：
   - role 重命名：`builder` → `executor`、link `build` → `execute`
   - 新增 `explorer` role 与 `explore` 链节（第 6 链节，仅 `--magic` 模式存在）
   - 新增 `--magic` 启动开关 + `--magic-max-chains M` 上限
   - EvalDecision 新增 `spawn_chain` 第 5 态（仅 explore link 合法）
   - ChainManifest 新增 `parent_chain_id` / `child_chain_ids` / `chain_depth` / `magic_mode` 字段
   - PROTOCOL_VERSION 升至 `"0.7.0"`，与 v0.6 不兼容、不混跑

让 PM、新成员、架构师、验收人能在一组文档内掌握完整产品形态。

本目录**只包含 PRD**。详细设计（DD）见 `../dd/`；v0.6 及更早版本的旧文档已经从仓库中移除，本 PRD 是产品需求的权威基线。

## 2. 目录索引

| 文件 | 回答的问题 |
|------|-----------|
| `01-overview.md` | 这是什么产品，为什么做，核心价值是什么 |
| `02-personas-and-roles.md` | 谁是用户，系统内有哪些角色，名称-角色如何解耦，Worker 如何隔离 |
| `03-scenarios.md` | 用户实际操作时会发生什么（含 happy path + RC0 边界场景） |
| `04-functional-requirements.md` | 系统必须具备哪些功能（FR-01 ~ FR-30），每个 FR 的完成判定 |
| `05-non-functional.md` | 可靠性、性能、安全、可观测、可配置如何保证 |
| `06-boundaries.md` | v0.6 不做、不保证哪些能力，哪些是 v0.7 候选 |
| `07-glossary.md` | 术语统一释义 |

## 3. 阅读路径

**PM / 决策者**：`01` → `03` → `06`

**新成员**：`01` → `02` → `03` → `07` → 按需展开 `04` `05`

**架构师**：`01` → `04` → `05` → `06`，配合 `../dd/01-architecture.md`

**验收人**：`04` 的完成判定列 + `06` 的边界声明。RC0 时代的逐项 acceptance checklist 已随旧文档目录移除；v0.7 验收基于 `04-functional-requirements.md` 每条 FR 末尾的"done 判定"自行勾选,FR 编号保留原 A-* / R-* 追溯关系（见 `04-functional-requirements.md` 末尾的追溯表）。
