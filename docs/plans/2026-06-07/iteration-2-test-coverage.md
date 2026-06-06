# Iteration 3 Improvements - 2026-06-07

## Overview
Based on codebase analysis, this iteration focuses on filling critical test coverage gaps and improving error handling.

## Priority 1: Critical Test Coverage (High)

### Task 1: orchestrator/run.ts tests
- **File:** `packages/orchestrator/src/run.ts` (679 lines, 0 tests)
- **Why:** Main entry point wiring everything together; integration regressions undetected
- **Scope:** Smoke test for startup phases, headless mode integration
- **Assignee:** dev-1

### Task 2: in-process-supervisor.ts tests
- **File:** `packages/orchestrator/src/in-process-supervisor.ts` (231 lines, 0 tests)
- **Why:** Worker lifecycle management; bugs could cause leaks or race conditions
- **Scope:** Start/shutdown lifecycle, mutex behavior, error propagation
- **Assignee:** dev-2

### Task 3: docs-committer.ts tests
- **File:** `packages/worker/src/docs-committer.ts` (224 lines, 0 tests)
- **Why:** Concurrent git operations across workers; pure functions easy to test
- **Scope:** parseStatusPaths, extractStderr utilities, concurrent commit handling
- **Assignee:** dev-3

## Priority 2: Error Handling Improvements (Medium)

### Task 4: Add logging to silent catches
- **Files:** `recovery.ts`, `task-orchestrator.ts`, `merge-validator.ts`
- **Why:** 10 instances of `.catch(() => undefined)` hide failures
- **Scope:** Replace with `logger.debug("audit write failed", { error })`
- **Assignee:** dev-1

### Task 5: CLI child entry point validation
- **Files:** `packages/worker/src/child.ts`, `packages/orchestrator/src/child.ts`
- **Why:** JSON.parse without try-catch produces unhelpful errors
- **Scope:** Add try-catch with descriptive error message
- **Assignee:** dev-2

### Task 6: Fix CLI description
- **File:** `packages/cli/src/index.ts`
- **Why:** Says "backed by ZooKeeper" but default is in-memory
- **Scope:** Update description to match actual behavior
- **Assignee:** dev-3

## Priority 3: Additional Test Coverage (Medium)

### Task 7: monitor.ts tests
- **File:** `packages/leader/src/monitor.ts` (55 lines)
- **Scope:** Worker join/leave/status tracking
- **Assignee:** dev-1

### Task 8: stream-tailer.ts tests
- **File:** `packages/leader/src/stream-tailer.ts` (70 lines)
- **Scope:** File polling behavior with temp files
- **Assignee:** dev-2

### Task 9: co-root-initializer.ts tests
- **File:** `packages/orchestrator/src/co-root-initializer.ts` (82 lines)
- **Scope:** ensureCoRoot in temp directory
- **Assignee:** dev-3

## Verification Chain
Each task follows: dev → qa → verifier

## Success Criteria
- All new tests pass
- No regression in existing 364 tests
- Error handling improvements verified by architect
- Commit hashes recorded for all changes

---

## Product Manager Roadmap (Task #52)

### Current State
- 470+ tests passing
- All benchmark scenarios (A1-A4, B1-B8, C1-C7, D1-D4) complete
- CLI headless mode functional

### Top 5 Immediate Priorities
1. Graceful shutdown + worker health monitoring (production safety)
2. E2E integration tests (confidence in correctness)
3. Architecture documentation (onboarding)
4. `--json` flag (scripting support)
5. Config validation (fail-fast)

### Sprint Planning
| Sprint | Focus | Duration |
|--------|-------|----------|
| Sprint 1 | Production Hardening | 1 week |
| Sprint 2 | Documentation & Testing | 2 weeks |
| Sprint 3 | Feature Completion | 3 weeks |
| Sprint 4 | Developer Experience | 4 weeks |

### Recommended Team Focus (Next)
- **dev-1:** Graceful shutdown + health monitoring
- **dev-2:** E2E integration tests + failure injection
- **dev-3:** Documentation (architecture + API reference)
- **architect:** Review state persistence design
- **qa-engineer:** Stress testing + performance benchmarks
