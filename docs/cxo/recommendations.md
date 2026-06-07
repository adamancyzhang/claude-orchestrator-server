# Optimization Recommendations

## High Priority

### Recommendation #1: Fix CommandWatcher crash on missing commands.jsonl

- **Problem**: Orchestrator crashes on startup because `CommandWatcher.processNewLines()` calls `readFileSync` without handling file-not-found
- **File**: `packages/leader/src/command-watcher.ts:77`
- **Solution**: Wrap `readFileSync` in try-catch, return silently if file does not exist
- **Benefit**: Blocks all orchestrator usage — must fix before anything else works
- **Effort**: Small (5 lines of code)

### Recommendation #2: Protect user's global CLAUDE.md from overwrite

- **Problem**: `init` silently overwrites `~/.claude/CLAUDE.md` with orchestrator template
- **File**: `packages/orchestrator/src/run.ts` (init flow)
- **Solution**: Before overwriting, check if file exists. If so, either prompt user for confirmation or create backup as `~/.claude/CLAUDE.md.bak`
- **Benefit**: Prevents user configuration loss, avoids breaking other Claude workflows
- **Effort**: Small

### Recommendation #3: Improve error messages with actionable guidance

- **Problem**: Error messages are either raw stack traces or generic text without fix instructions
- **Files**: Various error handlers in orchestrator
- **Solution**: Define standard error format:
  ```
  [ERROR] <description>
    Fix: <actionable command or steps>
    Details: <file>:<line>
  ```
- **Benefit**: Users can self-service resolve issues without reading source code
- **Effort**: Medium

---

## Medium Priority

### Recommendation #4: Add unit tests for CommandWatcher

- **Problem**: The crash bug (Issue #1) indicates insufficient test coverage for edge cases
- **File**: `packages/leader/src/command-watcher.ts`
- **Solution**: Add tests for:
  - File does not exist on startup
  - File created after watcher starts
  - Malformed JSON lines
- **Benefit**: Prevents regression, catches similar issues in other components
- **Effort**: Medium

### Recommendation #5: Fix TypeScript compilation errors

- **Problem**: Multiple TS errors exist (TS2339, TS2345) in chain-router.ts and state.ts
- **Files**: `packages/leader/src/chain-router.ts`, `packages/leader/src/state.ts`
- **Solution**: Fix type definitions for ChainDef (tasks vs task_list), quality_gate union type, and event types
- **Benefit**: Type safety prevents runtime errors, enables better IDE support
- **Effort**: Medium

### Recommendation #6: Add --dry-run option

- **Problem**: Users cannot preview what orchestrator will do before it executes
- **Solution**: Add `--dry-run` flag that shows planned actions without executing:
  ```
  [DRY RUN] Will create 6 workers: Mike (planner), Anna (executor)...
  [DRY RUN] Will install 7 skills to .claude/skills/
  [DRY RUN] Will overwrite CLAUDE.md (backup: CLAUDE.md.bak)
  ```
- **Benefit**: Users can verify configuration before committing to changes
- **Effort**: Small

### Recommendation #7: Add --cleanup option

- **Problem**: `~/.claude-orchestrator/projects/<id>/` persists after orchestrator stops
- **Solution**: Add `--cleanup` flag or automatic cleanup on graceful shutdown
- **Benefit**: Prevents disk space accumulation
- **Effort**: Small

---

## Low Priority

### Recommendation #8: Add verbose mode for headless operation

- **Problem**: `--headless` mode is silent, no real-time feedback
- **Solution**: Add `--verbose` flag that outputs progress to stdout:
  ```
  [12:01:28] Mike (planner) started
  [12:01:28] Anna (executor) started
  [12:01:28] Waiting for task input...
  ```
- **Benefit**: Better observability for automated pipelines
- **Effort**: Small

### Recommendation #9: Add quick-start guide to README

- **Problem**: New users must read decompose.md (200+ lines) to understand how to use orchestrator
- **Solution**: Add 5-line quick-start section:
  ```bash
  git init my-project && cd my-project
  # Create basic project structure
  npx claude-orchestrator run -y
  # Type your requirement when prompted
  ```
- **Benefit**: Lowers onboarding barrier
- **Effort**: Small

### Recommendation #10: Add trace query command

- **Problem**: No way to query task execution history after orchestration completes
- **Solution**: Add `npx claude-orchestrator trace --chain <chain-id>` that outputs:
  ```
  Task 0: Initialize project structure
    Worker: Anna (executor)
    Started: 2026-06-07T12:01:30Z
    Completed: 2026-06-07T12:02:15Z
    Quality Gate: PASS (npm run build succeeded)
    Commit: abc1234
  ```
- **Benefit**: Enables debugging and audit of orchestration runs
- **Effort**: Medium

---

## Summary

| Priority | Recommendations | Total Effort |
|----------|----------------|--------------|
| High | #1, #2, #3 | Small-Medium |
| Medium | #4, #5, #6, #7 | Medium |
| Low | #8, #9, #10 | Small-Medium |

**Recommended order**: Fix high-priority issues first (#1 is a blocker), then add tests (#4), then UI improvements (#6, #8, #9).
