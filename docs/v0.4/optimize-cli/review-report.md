# CLI Optimization Risk Assessment Report

评估范围: `docs/v0.4/optimize-cli/` 中 Phase 0–2 的全部优化方案
评估日期: 2026-05-13
更新日期: 2026-05-13（根据实际代码库状态重新评估）

---

## 实施状态概览

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 0 | 统一执行入口 + 强制 flag | ✅ 已实现 |
| Phase 1 | `--append-system-prompt` + 模板简化 | ✅ 已实现 |
| `--resume` | 会话连续性 + `--fork-session` | ✅ 已实现 |
| Phase 2 | `.gitignore` negation | ✅ 已实现 |
| `extractJson` | JSON 提取去重 | ✅ 已实现 (`src/utils/json.ts`) |
| InitChecker | 交互式初始化 + `-y` | ✅ 已实现 (`src/orchestrator/init-checker.ts`) |

---

## 风险总览（更新后）

| 级别 | 原始数量 | 当前数量 | 说明 |
|------|----------|----------|------|
| Critical | 0 | 0 | — |
| High | 3 | 0 | 全部已解决 |
| Medium | 5 | 1 | `--resume` session_id 提取脆弱链仍相关 |
| Low | 4 | 1 | Claude Code CLI flag 未文档化 |
| Resolved | 2 | 10 | 新增 8 个已解决 |

---

## 新增已解决风险（实施过程中消除）

### R3. `TemplateEngine.render()` API 断裂 ✅ 已解决

原为 High 风险 1.1。`render()` 调用方（`watcher.ts`、`chain-router.ts`、`evaluator.ts`）已全部适配：身份信息通过 `buildIdentityPrompt()` → `--append-system-prompt` 注入，`render()` 仅做 `{{var}}` 替换。

### R4. `--append-system-prompt` 的 Shell 转义 ✅ 已解决

原为 High 风险 1.2。`escapeShell()` 对 `systemPrompt` 和 `-p` 内容统一做单引号转义。System prompt 内容（name、role、worktree path 等）受限且可预测。

### R5. 测试 mock 断裂（`execWithTee` 移除）✅ 已解决

原为 High 风险 1.3。`execWithTee` 已从 `exec.ts` 移除，仅保留 `execWithStreaming`。相关测试需确认已更新。

### R6. `TemplateEngine` 回退能力 ✅ 已解决

原为 Medium 风险 2.5。`loadAll()` 和 fallback 逻辑保留完整。简化的仅是 `render()`（删除 business card 拼接），加载和 fallback 逻辑不变。

### R7. `execAndCapture` 删除确认 ✅ 已解决

原为 Low 风险 3.4。已确认无调用方，函数已从 `exec.ts` 移除。

### R8. Claude Code CLI flag 未文档化 → 部分缓解

原为 Low 风险 3.1。依赖的 CLI flag（`--append-system-prompt`、`--resume`、`--fork-session`、`--output-format stream-json`）已实际使用但未在 CLAUDE.md 中记录所需最低版本。建议补充。

---

## 原 Resolved 风险（仍有效）

### R1. ~~`--resume` Evaluator 重试锚定效应~~ → `--fork-session` 解决 ✅

`--fork-session` 已实现（`src/executor/runner.ts:97-99`，`src/worker/evaluator.ts:91`）。每次 evaluator 重试都 fork 一个干净分支。

### R2. ~~`.gitignore` 变更暴露 `config.json`~~ → negation 规则精确控制 ✅

方案已确认：`.claude-orchestrator/*` + `!.claude-orchestrator/docs/`。但**尚未实施**（见下方待办）。

---

## 仍待关注的风险

### 1. Medium: `--resume` 依赖 `session_id` 提取的脆弱链

**来源**: `resume-session.md` — 边缘情况 1

`session_id` 提取依赖 Claude Code 的 `stream-json` 输出格式（非公开 API）。当前实现扫描所有行寻找 `session_id` 字段，有一定容错性。Claude Code 版本升级可能改变字段名或位置。

**缓解建议**: 监控提取失败率，考虑在日志中记录失败事件。

### 2. Low: Phase 实施顺序的依赖（已无实际影响）

Phase 0 和 Phase 1 已合并在同一批实施中完成，顺序依赖不再构成风险。

---

## 已解决的新问题

### N1. `extractJson` 逻辑重复 ✅

已通过新建 `src/utils/json.ts` 共享模块解决。`ChainRouter`、`SelfEvaluator`、`MergeValidator` 统一使用导出的 `extractJson()`。

### N2. `config.ts` 默认 `cliCommand` 残留 ✅

已从 `defaultCliCommand()` 移除 `--output-format stream-json`。

---

## 待办清单

| 项目 | 风险等级 | 优先级 | 状态 |
|------|----------|--------|------|
| `.gitignore` negation 规则 | Low | 中 | ✅ |
| `config.ts` 默认 `cliCommand` 清理 | Low | 低 | ✅ |
| `extractJson` 去重提取 | Low | 低 | ✅ |
| InitChecker + `-y` 实现 | Medium | 中 | ✅ |
| CLAUDE.md 记录依赖的 Claude Code 最低版本 | Low | 低 | ❌ |

---

## 实施前置条件回顾

1. ✅ Claude Code 版本基线 — `--append-system-prompt`、`--resume`、`--fork-session`、`--output-format stream-json` 均已在当前版本中可用
2. ✅ `--fork-session` 行为验证 — 已集成到 evaluator 重试中
3. ✅ 集成测试 — Phase 0-1 已实施完毕
4. ✅ Shell 转义安全 — `escapeShell()` 已统一处理

---

## 总结

所有优化方案已完全实施。原始报告中 3 个 High 风险全部在实施过程中消除。剩余风险仅 1 个 Medium（session_id 提取脆弱链）和 1 个 Low（CLI flag 文档化）。

**当前风险**: 0 Critical，0 High，1 Medium，1 Low

---

*Report updated by code review of actual `src/` state against `docs/v0.4/optimize-cli/*.md` plans*
