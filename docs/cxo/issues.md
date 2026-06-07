# Issues Found

## Critical Issues

### Issue #1: CommandWatcher crashes on startup — commands.jsonl not found

- **Severity**: Critical
- **Description**: Running `npx claude-orchestrator run --headless -y` crashes immediately with ENOENT error
- **Steps to Reproduce**:
  1. Create a clean git repository with a simple project
  2. Run `npx claude-orchestrator run --headless -y`
  3. Observe crash
- **Expected**: Orchestrator starts successfully, creates worktrees and workers
- **Actual**: Crash with stack trace:
  ```
  Error: ENOENT: no such file or directory, open '.../commands.jsonl'
      at readFileSync (node:fs:440)
      at CommandWatcher.processNewLines (.../packages/leader/dist/command-watcher.js:55:24)
  ```
- **Root Cause**: `CommandWatcher.processNewLines()` calls `readFileSync(this.filePath)` without try-catch. The directory watcher triggers before `commands.jsonl` is created.
- **File**: `packages/leader/src/command-watcher.ts:77`
- **Impact**: Cannot use orchestrator at all — blocks all functionality
- **Reproducibility**: 100%

---

## Major Issues

### Issue #2: Init overwrites user's global CLAUDE.md without warning

- **Severity**: Major
- **Description**: `npx claude-orchestrator run -y` overwrites `~/.claude/CLAUDE.md` with the orchestrator template
- **Steps to Reproduce**:
  1. Create custom content in `~/.claude/CLAUDE.md`
  2. Run `npx claude-orchestrator run -y`
  3. Check `~/.claude/CLAUDE.md` content
- **Expected**: Either preserve user's file or prompt for confirmation before overwriting
- **Actual**: User's custom global instructions are silently replaced with orchestrator template
- **Impact**: User loses personalized configuration, may break other Claude workflows
- **Reproducibility**: 100%

### Issue #3: Uncommitted changes error lacks actionable guidance

- **Severity**: Major
- **Description**: When workspace has uncommitted changes, orchestrator exits with generic error
- **Steps to Reproduce**:
  1. In a git repository, create a file but don't commit
  2. Run `npx claude-orchestrator run --headless -y`
- **Expected**: Error message includes how to fix (e.g., "Run `git add -A && git commit` or `git stash`")
- **Actual**: Generic error: `Fatal error: Error: Workspace has uncommitted changes. Please commit or stash them before starting the orchestrator.`
- **Impact**: User must search documentation or source code to understand how to proceed
- **Reproducibility**: 100%

---

## Minor Issues

### Issue #4: Crash output shows only stack trace, no user-friendly message

- **Severity**: Minor
- **Description**: When orchestrator crashes, only Node.js stack trace is displayed
- **Expected**: Clean error message with description and suggested fix
- **Actual**: Raw stack trace with internal file paths
- **Impact**: Difficult for users to understand what went wrong and how to fix it

### Issue #5: Worker roles are predefined, not visible to user

- **Severity**: Minor
- **Description**: Workers have preset roles (planner, executor, verifier, reviewer, accepter) but user cannot see who is doing what
- **Expected**: State or logs show current task assignment and worker activity
- **Actual**: state.json shows workers as idle with no task context
- **Impact**: Cannot monitor or debug orchestration progress

### Issue #6: headless mode provides no real-time feedback

- **Severity**: Minor
- **Description**: Running with `--headless` only writes to state.json, no stdout progress
- **Expected**: Optional verbose output showing initialization steps and task progress
- **Actual**: Silent operation, must manually read state.json to check status
- **Impact**: Difficult to monitor automated pipelines

### Issue #7: Orchestrator does not clean up project directory on stop

- **Severity**: Minor
- **Description**: `~/.claude-orchestrator/projects/<id>/` is created but not cleaned up after orchestrator stops
- **Expected**: Automatic cleanup or `--cleanup` option
- **Actual**: Project directory persists with state.json, leader log, and metrics
- **Impact**: Disk space accumulation over multiple runs

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| Major | 2 |
| Minor | 4 |
| **Total** | **7** |
