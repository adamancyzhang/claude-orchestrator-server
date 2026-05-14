# Testing Standards

Authoritative testing convention for **humans and AI agents** (Claude Code) working on this repository.
MUST be read before adding or modifying any test file.
Language is directive: **MUST**, **MUST NOT**, **PREFER**.

---

## 1. Purpose & Audience

This document governs all tests under `tests/`. It exists to:

- Prevent the test suite from becoming a graveyard of one-off scratch tests.
- Ensure expensive dependencies (real ZooKeeper, real `claude-cli`) are governed by explicit trust rules rather than ad-hoc mocks.
- Give AI agents a self-contained reference for scope decisions, file placement, and comment templates.

If you are an AI agent: consult §6 (Scope Decision Flow) before writing any test. Consult §7 for copy-pasteable comment templates. Check §10 before committing.

---

## 2. Directory Layout

```
tests/
├── CLAUDE.md                           # this file
├── core/                               # long-lived, reviewed, must-justify-retention
│   ├── unit/                           # pure logic tests, no ZK, limited mocking
│   ├── integration/                    # real ZK (docker-compose), multi-module flows
│   ├── e2e/                            # full leader+worker over real ZK
│   └── manual/                         # executable scripts + README for human-driven runs
└── scratch/                            # ephemeral iteration tests; auto-deleted after 3 days
    └── YYYY-MM-DD/
        └── <feature-or-task>/
            └── *.test.ts
```

### Per-directory purpose

| Directory | Purpose | Retention |
|---|---|---|
| `core/unit/` | Pure module logic; no ZK; vi.mock only for exec calls | Permanent |
| `core/integration/` | Real ZK; multi-module orchestration | Permanent |
| `core/e2e/` | Full leader+worker runs via `src/orchestrator/run.ts` | Permanent |
| `core/manual/` | Node.js scripts hitting real claude-cli + ZK | Permanent |
| `scratch/YYYY-MM-DD/<feature>/` | In-progress iteration tests | 3 days maximum |

---

## 3. Universal Rules

These rules apply to **all** tests — both `core/` and `scratch/`.

### 3.1 Observable-behavior over coverage

Coverage percentage is NOT the key metric. **Observable-behavior testing is.**

Assert on externally visible effects: ZK node state, emitted messages, stdout content, exit codes, file contents.
MUST NOT assert on internal call counts or instrumented line coverage unless the call itself is the public contract.

```typescript
// GOOD — asserts on observable ZK state
const data = await zk.getData(ZkPaths.taskResult(taskId));
expect(JSON.parse(data.toString()).status).toBe("completed");

// BAD — asserts on internal spy count, tells you nothing about behavior
expect(orchestrator.assignTask).toHaveBeenCalledTimes(2);
```

### 3.2 5-minute rule

When `npm test` wall-clock time exceeds **5 minutes**, slow endpoints MUST be split into separately-invocable test groups.

- Slow files use suffix `.slow.test.ts`.
- Fast subset MUST remain runnable with `npx vitest run tests/core/unit` or `npx vitest run tests/core/integration`.
- Slow subset is invoked explicitly: `npx vitest run tests/core/integration/*.slow.test.ts`.

### 3.3 No casual mocking or try/catch

MUST NOT mock a collaborator or swallow an exception without completing a **relationship-chain review**:

1. Identify the downstream dependency.
2. Determine whether asserting the protocol contract is sufficient to declare the whole call chain working.
3. If yes, embed a `TRUST-JUSTIFICATION` comment (see template §7.1) in the test file.
4. If no, do not mock — exercise the real dependency.

The canonical acceptable case: `claude-cli` subprocess calls are expensive (~30 s, ~$0.10 per call). Asserting that the output JSON matches the expected schema is sufficient to consider the full call chain working. This MUST still be recorded in a `TRUST-JUSTIFICATION` comment.

### 3.4 Per-test ZK isolation

Integration and e2e tests MUST set a unique `ZK_ROOT_PATH` per test file via `vi.hoisted()`.
MUST NOT share ZK root paths across files — shared roots cause cross-test state leakage.

```typescript
const TEST_ROOT = vi.hoisted(() => {
  const root = `/test-my-module-${Date.now()}`;
  process.env.ZK_ROOT_PATH = root;
  return root;
});
```

### 3.5 Errors must propagate

Do not add defensive try/catch in tests. Let unexpected failures surface as test failures.
Mirror the philosophy in `src/` — errors are signal, not noise to be silenced.

---

## 4. Core Tests (`tests/core/`)

Core tests represent long-lived, reviewed behavioral locks on the system's critical paths.

### 4.1 Retention rule

Every file under `tests/core/` **MUST** carry a `CORE-RETENTION` header comment (template §7.2) that:

- Names the observable behavior it locks in.
- Explains why that behavior is a core path.
- Names the owner subsystem and the primary source files it exercises.

Files without this header are subject to deletion during any triage pass.

### 4.2 `core/unit/`

- Target: pure module logic — no ZooKeeper, no child processes.
- Source modules typically covered: `src/zk/paths.ts`, `src/executor/template.ts`, `src/leader/chain-router.ts`, `src/leader/state.ts`, `src/leader/event-bus.ts`, `src/worker/evaluator.ts`.
- `vi.mock()` is acceptable **only** for `execWithStreaming` / `execAndCapture` in `src/executor/runner.ts` and `src/utils/exec.ts`. All other mocks require `TRUST-JUSTIFICATION`.
- Real filesystem via `fs.mkdtempSync()` is preferred over mocking `fs`.

### 4.3 `core/integration/`

- Target: multi-module orchestration over a **real ZooKeeper** instance.
- Requires: `docker-compose up -d` (see `docker-compose.yml`); ZK on `127.0.0.1:2181`.
- Primary source modules: `src/zk/client.ts`, `src/modules/task-queue.ts`, `src/modules/registry.ts`, `src/modules/message-router.ts`, `src/leader/watcher.ts`, `src/leader/recovery.ts`, `src/worker/watcher.ts`.
- `claude-cli` MUST be mocked in integration tests (record `TRUST-JUSTIFICATION`).
- Each test file creates and tears down its own ZK subtree via `vi.hoisted()` + `beforeAll`/`afterAll`.

### 4.4 `core/e2e/`

- Target: full leader+worker runs initiated via `src/orchestrator/run.ts`.
- Requires: real ZooKeeper (same as integration).
- `claude-cli` subprocess output MAY be stubbed; record `TRUST-JUSTIFICATION`.
- These tests exercise the entire message delivery path: ZK watch → template render → CLI exec → completion report → Leader state update.
- Long wall-clock time is expected; apply the 5-minute rule (§3.2) and suffix `.slow.test.ts` if needed.

### 4.5 `core/manual/`

Manual tests hit **real `claude-cli`** and **real ZooKeeper** together. They are not automated by Vitest.

Structure:
```
core/manual/
├── README.md           # prerequisites, run commands, verification checklist
└── *.mjs               # executable Node.js scripts
```

`README.md` MUST include:

- **Prerequisites**: `claude-cli` installed and authenticated, ZK running via docker-compose, any required env vars.
- **Run command** per script (e.g., `node tests/core/manual/claude-cli-smoke.mjs`).
- **Verification checklist**: expected stdout markers, expected ZK path contents, pass/fail criteria.

Scripts are not wrapped in Vitest — they exit with code 0 on success, non-zero on failure.

---

## 5. Scratch Tests (`tests/scratch/`)

Scratch tests support day-to-day feature development and are **explicitly temporary**.

### Path

```
tests/scratch/YYYY-MM-DD/<feature-or-task>/*.test.ts
```

Example: `tests/scratch/2026-05-14/worker-retry-backoff/basic.test.ts`

### Scope

Default scope = only the tests covering the modified function points. Full regression (`npm test`) is NOT required unless §6 mandates it.

### Retention

Scratch directories older than **3 days** MUST be deleted by the contributor before committing.
There is no automation — this is a manual contributor responsibility. Check `ls tests/scratch/` before each commit.

### No retention header required

Scratch tests do not require a `CORE-RETENTION` header. Keep them lightweight.

### Promotion to core

A scratch test that proves its worth may be promoted to `tests/core/`. See §8.

---

## 6. Scope Decision Flow

When developing a feature or fixing a bug, use this table to determine the minimum required test scope. "Full regression" means `npm test` across all of `tests/core/`.

| Change touches | Minimum required test scope |
|---|---|
| `src/zk/paths.ts` or `src/zk/client.ts` | Full `npm test` — ZK paths are cross-cutting; every subsystem depends on them |
| `src/leader/**` | `tests/core/unit/leader-*` + `tests/core/integration/leader-*` + one e2e smoke |
| `src/worker/**` | `tests/core/unit/worker-*` + `tests/core/integration/worker-*` + one e2e smoke |
| `src/executor/template.ts` | `tests/core/unit/` only |
| `src/executor/runner.ts` | `tests/core/unit/runner*` + one e2e smoke in `tests/core/e2e/` |
| `src/orchestrator/**` | `tests/core/e2e/` |
| `src/modules/**` | `tests/core/integration/` for the affected module |
| `src/hooks/**` | `tests/core/unit/hooks*` |
| Type-only or cross-cutting changes (`src/models/schemas.ts`) | Full `npm test` |
| `templates/` or `skills/` | No automated tests; manual verification via `tests/core/manual/` |
| `docs/` or `*.md` only | None |

### Rule of thumb

- Change crosses the leader/worker boundary → run integration tests.
- Change modifies a ZK path constant → run full `npm test`.
- Change is isolated to one module with no cross-module side effects → unit tests for that module only.

### Triggering full regression

Full regression is required when:

1. The scope analysis above maps to "Full `npm test`", OR
2. The change modifies shared infrastructure (ZK client, config loader, path constants), OR
3. You detect that multiple independent subsystems could be affected.

If full regression takes > 5 minutes, apply §3.2 (5-minute rule) before committing.

---

## 7. Templates

### 7.1 Mock / Trust-Justification Comment

Use this template whenever mocking a dependency or swallowing an exception. Place it immediately above the mock call or try/catch block.

```typescript
// TRUST-JUSTIFICATION: Mocking <module-or-function> in <source-path>.
// Downstream: <description of what is being skipped>.
// Reason: <why the real dependency is not exercised here>.
// Evidence: <what covers the real downstream — a manual test, a separate
//            integration test, a contract assertion, or a known external guarantee>.
//
// Example:
// TRUST-JUSTIFICATION: Mocking execWithStreaming (src/utils/exec.ts).
// Downstream: claude-cli subprocess spawned by ClaudeRunner.
// Reason: claude-cli calls take ~30 s and cost ~$0.10 per invocation; running
//   them in unit tests is impractical and non-deterministic.
// Evidence: The full call chain is exercised in tests/core/manual/claude-cli-smoke.mjs.
//   Here we assert only that ClaudeRunner passes the correct prompt string and
//   parses the output JSON into the expected EvalDecision shape — the protocol
//   contract between src/executor/runner.ts and claude-cli.
```

### 7.2 Core Test Header Comment

Place this at the very top of every file under `tests/core/`, before any imports.

```typescript
// CORE-RETENTION
// Locks in: <one sentence describing the observable behavior this file asserts>.
// Core path because: <why this behavior is critical — what breaks if it regresses,
//   which production scenario it covers>.
// Owner subsystem: <leader | worker | zk | executor | orchestrator | modules>.
// Primary source files exercised:
//   - <src/path/to/file.ts>
//   - <src/path/to/other.ts>
//
// Example:
// CORE-RETENTION
// Locks in: Leader re-queues a claimed task when the owning Worker's ephemeral
//   ZK node disappears (worker crash / disconnect).
// Core path because: task recovery is the only safety net for crashed workers;
//   without it, claimed tasks are permanently lost.
// Owner subsystem: leader.
// Primary source files exercised:
//   - src/leader/recovery.ts
//   - src/leader/watcher.ts
//   - src/zk/client.ts
```

---

## 8. Promotion: Scratch → Core

When a scratch test proves it covers a meaningful behavioral invariant:

1. **Move** the file to `tests/core/<category>/` (pick the right category per §4).
2. **Add** the `CORE-RETENTION` header (template §7.2) at the top of the file.
3. **Rename** to drop the date — e.g., `basic.test.ts` → `worker-retry-backoff.test.ts`.
4. **Verify** the file passes in isolation: `npx vitest run tests/core/<category>/worker-retry-backoff.test.ts`
5. **Verify** it passes as part of the full suite: `npm test`
6. **Delete** the original scratch directory if it is now empty.

---

## 9. Running Tests

```bash
# Full suite (all core tests)
npm test                                          # vitest run

# Watch mode
npm run test:watch                                # vitest

# Single file
npx vitest run tests/core/unit/leader.test.ts

# Narrowed directory
npx vitest run tests/core/unit
npx vitest run tests/core/integration

# Slow tests only
npx vitest run tests/core/integration/*.slow.test.ts

# Scratch tests (current feature)
npx vitest run tests/scratch/2026-05-14/my-feature

# Manual tests (real claude-cli + real ZK)
node tests/core/manual/claude-cli-smoke.mjs
```

ZooKeeper must be running for integration, e2e, and manual tests:
```bash
docker-compose up -d
```

---

## 10. Quick Checklist for AI Agents

### Before writing a test

- [ ] Identify the subsystem being changed.
- [ ] Consult §6 to determine minimum required test scope.
- [ ] Choose `tests/scratch/YYYY-MM-DD/<feature>/` for iteration work, or `tests/core/<category>/` for a behavioral lock.
- [ ] If placing in `core/`, write the `CORE-RETENTION` header (§7.2) before writing any test logic.

### Before using a mock or try/catch

- [ ] Conduct a relationship-chain review: is the downstream trustworthy? Is there evidence?
- [ ] Write the `TRUST-JUSTIFICATION` comment (§7.1) immediately above the mock/catch.

### Before committing

- [ ] Run the minimum required test scope per §6.
- [ ] Prune `tests/scratch/` directories older than 3 days.
- [ ] Confirm every file in `tests/core/` has a `CORE-RETENTION` header.
- [ ] Confirm every mock/catch in `tests/core/` has a `TRUST-JUSTIFICATION` comment.
- [ ] If total test time exceeded 5 minutes, apply the `.slow.test.ts` split (§3.2).
