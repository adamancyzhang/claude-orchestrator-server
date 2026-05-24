---
name: code-review-guidelines
description: "General-purpose code review standard: test real logic, fail loud on configuration errors, no meaningless fallbacks, structural decomposition for testability. Use when reviewing any code change."
version: 1.0.0
author: Adamancy Zhang
license: MIT
---

# Code Review Guidelines

## Overview

Review code for structural robustness, error sensitivity, and test authenticity. A passing test that exercises copied logic proves nothing. A system that silently degrades on missing configuration is broken in ways no test will catch.

**Core principle:** If a configuration error does not crash, you do not know it happened.

## When to Use

**Always:**
- Reviewing any code change before commit
- Assessing test quality and coverage
- Evaluating error-handling patterns
- Refactoring decisions

**No exceptions.** Every code change that reaches review must pass this standard.

## The Iron Law

```
NO SILENT FALLBACK FOR MISSING CONFIGURATION
```

Missing template, missing required file, missing required parameter — throw immediately. Do not substitute a default. Do not skip the step. Do not log a warning and continue.

**No exceptions:**
- Not for "better user experience"
- Not for "the system should be resilient"
- Not for "it's unlikely to happen"

Resilience means handling runtime failures gracefully. It does not mean hiding configuration errors.

## Test Real Code

Unit tests must exercise production code paths. If logic cannot be tested through its public API, the code structure needs refactoring — extract pure functions, inject dependencies, split modules — before writing the test.

Copying logic into tests creates drift. The copied code and the production code diverge silently. The test passes while the production code is broken. A passing copy-paste test is worse than no test — it creates false confidence.

Mock only external boundaries: process spawning, network calls, filesystem. Internal logic must never be replaced by mocks in tests.

## Structural Decomposition for Testability

Test difficulty is a signal. When code is hard to test, the problem is the code structure, not the test approach. More mocks, deeper stubs, or wider integration tests are not the answer.

Extract the untestable logic into a pure function with explicit inputs and outputs. Inject the dependency through the constructor or function parameter. Let the test pass real values and assert real results.

A codebase that requires heavy mocking to test is a codebase that needs structural refactoring.

## No Meaningless Fallbacks

Any pattern that substitutes a hardcoded default when a required resource is absent is a bug:

- Template not found → fallback string
- Required file missing → skip the step
- Configuration key absent → use a default
- Service unavailable → return empty result

Each of these hides the root cause. The system continues in a degraded state. The output looks plausible but is substantively wrong. The error may surface hours or days later, in a different part of the system, with no trace back to the source.

A crash is visible, immediate, and fixable. A silent fallback is invisible, deferred, and corrupting.

## Error Sensitivity

Every catch block must answer: after this error is swallowed, can the caller detect that something went wrong? Will downstream code act on incorrect or incomplete data?

If the answer is "no," the error must propagate. Logging a warning is not enough — logs are not monitored, warnings are ignored, and the degraded state compounds.

Robust code fails loud. Sensitive code treats every catch as a decision point, not a convenience.

## Distinguish Configuration Errors from Runtime Errors

Two fundamentally different categories, requiring fundamentally different handling:

**Configuration errors** are permanent and deterministic: missing templates, wrong paths, absent required parameters, invalid schema. The system cannot recover because the necessary information does not exist. These must throw immediately, before any work begins. Retries cannot help. Defaults cannot substitute. Fast failure is the only correct response.

**Runtime errors** are transient and environmental: process crashes, network timeouts, temporary file locks, resource exhaustion. The system may recover because the underlying condition is temporary. These may be retried, handled with degraded behavior, or escalated after exhausting retries.

Conflating these two categories under the same error-tolerance logic is the root cause of phantom anomalies — the system appears to work but produces wrong results.

## Anti-Patterns

- **`has() ? load() : fallback`** — missing resource silently substituted. Throw instead.
- **`try { ... } catch { return defaultValue }`** — error swallowed, caller cannot detect failure.
- **Copy-paste test logic** — test exercises a duplicate, not the production code.
- **Mock-heavy tests** — mocks replace the system under test rather than isolating external boundaries.
- **`??` chains for required values** — each `??` is a configuration error waiting to be hidden.
- **Degraded fallback that looks successful** — returning an empty list, empty string, or "success" status when an operation actually failed.
- **Catch-log-continue** — the error is recorded and immediately forgotten. The log is the only evidence, and nobody reads it.

## Red Flags — Stop and Fix

If any of these appear in a review, block the change:

- Fallback string or default value for a missing required resource
- Catch block that returns a default without the caller being able to detect the failure
- Test that copies production logic instead of calling it
- Template or configuration loaded conditionally with a silent else-branch
- Mock replacing an internal dependency that could be injected instead
- A `warn` or `debug` log as the only response to a failed operation

## Verification Checklist

Before approving any change:

- [ ] Tests call real production functions, not copied logic
- [ ] No `has() ? load() : "fallback"` pattern for required resources
- [ ] Every catch block preserves the caller's ability to detect failure
- [ ] Configuration errors throw immediately, not deferred to runtime
- [ ] Mocks are limited to external process boundaries
- [ ] No `??` fallback on values that must exist
- [ ] Hard-to-test code was refactored, not mocked around

Cannot check all boxes? The change is not ready. Send it back.

## Final Rule

```
Missing required resource → throw
Error swallowed → caller must still detect failure
Test copies logic → test is worthless
Hard to test → refactor, don't mock
```
