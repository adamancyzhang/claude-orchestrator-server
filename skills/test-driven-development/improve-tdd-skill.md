---
name: test-driven-development
description: "TDD: enforce RED-GREEN-REFACTOR, tests before code, traceable trust, and test-suite hygiene."
version: 2.0.0
author: Adamancy Zhang
license: MIT
---

# Test-Driven Development (TDD)

## Overview

Write the test first. Watch it fail. Write minimal code to pass. Keep the test suite from rotting.

**Three core principles:**

1. If you didn't watch the test fail, you don't know if it tests the right thing.
2. A test you can't trust is worse than no test — it creates false confidence.
3. Tests are project assets with a lifecycle — ungoverned tests become a graveyard.

**Violating the letter of the rules is violating the spirit of the rules.**

## When to Use

**Always:**
- New features
- Bug fixes
- Refactoring
- Behavior changes

**Exceptions (ask the user first):**
- Throwaway prototypes
- Generated code
- Configuration files

Thinking "skip TDD just this once"? Stop. That's rationalization.

---

## Part 1: The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over.

**No exceptions:**
- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete

Implement fresh from tests. Period.

---

## Part 2: Red-Green-Refactor Cycle

### RED — Write Failing Test

Write one minimal test showing what should happen.

**Good test:**
```python
def test_retries_failed_operations_3_times():
    attempts = 0
    def operation():
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise Exception('fail')
        return 'success'

    result = retry_operation(operation)

    assert result == 'success'
    assert attempts == 3
```
Clear name, tests real behavior, one thing.

**Bad test:**
```python
def test_retry_works():
    mock = MagicMock()
    mock.side_effect = [Exception(), Exception(), 'success']
    result = retry_operation(mock)
    assert result == 'success'  # What about retry count? Timing?
```
Vague name, tests mock not real code.

**Requirements:**
- One behavior per test
- Clear descriptive name ("and" in name? Split it)
- Real code, not mocks (unless truly unavoidable — see Part 4)
- Name describes behavior, not implementation
- Assert on **observable effects**: return values, state changes, output, side effects — not internal call counts

### Verify RED — Watch It Fail

**MANDATORY. Never skip.**

```bash
# Run the specific test
<project-test-runner> <test-file>::<test-name>
```

Confirm:
- Test fails (not errors from typos)
- Failure message is expected
- Fails because the feature is missing

**Test passes immediately?** You're testing existing behavior. Fix the test.

**Test errors?** Fix the error, re-run until it fails correctly.

### GREEN — Minimal Code

Write the simplest code to pass the test. Nothing more.

**Good:**
```python
def add(a, b):
    return a + b  # Nothing extra
```

**Bad:**
```python
def add(a, b):
    result = a + b
    logging.info(f"Adding {a} + {b} = {result}")  # Extra!
    return result
```

Don't add features, refactor other code, or "improve" beyond the test.

**Cheating is OK in GREEN:**
- Hardcode return values
- Copy-paste
- Duplicate code
- Skip edge cases

We'll fix it in REFACTOR.

### Verify GREEN — Watch It Pass

**MANDATORY.**

```bash
# Run the specific test
<project-test-runner> <test-file>::<test-name>

# Then run ALL related tests to check for regressions
<project-test-runner> <test-directory>/
```

Confirm:
- Test passes
- Other tests still pass
- Output pristine (no errors, warnings)

**Test fails?** Fix the code, not the test.

**Other tests fail?** Fix regressions now.

### REFACTOR — Clean Up

After green only:
- Remove duplication
- Improve names
- Extract helpers
- Simplify expressions

Keep tests green throughout. Don't add behavior.

**If tests fail during refactor:** Undo immediately. Take smaller steps.

### Repeat

Next failing test for next behavior. One cycle at a time.

---

## Part 3: Test Classification & Lifecycle

TDD produces tests. Ungoverned tests rot. Every test you write belongs to one of two categories:

### Core Tests — Permanent Behavioral Locks

A test that guards a critical behavior. It earns its place permanently.

**When a test qualifies as core:**
- It locks in a behavior whose regression would break production
- It exercises a cross-module contract (API boundary, protocol, data format)
- It encodes a bug fix — the bug actually happened, the test prevents its return

**Core test obligations:**
- Must declare **what behavior it locks in and why it's critical** (a one-line CORE-RETENTION header)
- Must name the **primary source files** it exercises
- Mock usage must carry a **TRUST-JUSTIFICATION** (see Part 4)

```
# CORE-RETENTION
# Locks in: <one sentence describing the observable behavior>.
# Critical because: <what breaks if this regresses>.
# Primary sources: <file paths>.
```

A test without this header is subject to deletion during any triage pass.

### Scratch Tests — Temporary Iteration

Tests written during active development that haven't proven their lasting value.

**Scratch test rules:**
- Keep them lightweight — no headers required
- They have a **limited lifespan**: delete them within a fixed window (e.g., 3 days) or when the feature stabilizes
- They live in an isolated directory (e.g., `tests/scratch/YYYY-MM-DD/<feature>/`)

**Promotion to core:**
When a scratch test proves it covers a meaningful behavioral invariant:
1. Move it to the core test directory
2. Add the CORE-RETENTION header
3. Verify it passes in isolation and as part of the full suite
4. Delete the original scratch directory

**Why this distinction matters:**
Without it, every test is permanent by default. The suite accumulates one-off experiments, half-finished explorations, and tests that passed once and were never touched again. Developers stop trusting the suite. Then they stop running it. Then they stop writing tests.

Core vs scratch is not bureaucracy — it's the difference between a curated library and a junk drawer.

---

## Part 4: Trust-Justification & Mock Discipline

### The Problem with Mocks

Every mock is a lie. You're replacing a real dependency with a fake one. The question is whether the lie is justified and documented.

A mocked test that passes while the real dependency is broken is a **false negative** — the most dangerous kind of test. It tells you everything is fine while production burns.

### Relationship-Chain Review

Before mocking any dependency, complete this review:

1. **Identify** the downstream dependency being mocked.
2. **Determine** whether asserting the protocol contract is sufficient to declare the whole call chain working.
3. **If yes**: record a TRUST-JUSTIFICATION. The mock is acceptable.
4. **If no**: do not mock. Exercise the real dependency.

The canonical acceptable case: external API calls, subprocess invocations, or expensive I/O where the cost (time, money, flakiness) of real execution outweighs the risk of the mock. The protocol contract — "we send X, we expect Y-shaped response" — is the trust boundary.

### TRUST-JUSTIFICATION Template

Every mock must carry a comment immediately above it:

```
TRUST-JUSTIFICATION: Mocking <module-or-function>.
Downstream: <what is being skipped>.
Reason: <why the real dependency is not exercised here>.
Evidence: <what covers the real downstream — an integration test,
          a manual smoke test, a contract assertion, or a known
          external guarantee>.
```

Example:
```python
# TRUST-JUSTIFICATION: Mocking stripe.Charge.create.
# Downstream: Stripe API — real HTTP call to payment processor.
# Reason: Real calls cost money (~$0.30) and require network; running
#   them in unit tests is impractical and non-deterministic.
# Evidence: The full payment flow is exercised in tests/integration/stripe/
#   using Stripe's test mode. Here we assert only that the correct charge
#   amount and currency are passed — the protocol contract between our
#   code and the Stripe SDK.
```

**No TRUST-JUSTIFICATION, no mock.** A mock without justification is technical debt you can't see.

### When NOT to Mock

- **In-memory collaborators** (other modules in your codebase) — mock only if the real module has its own tested contract and the integration is tested elsewhere. Prefer real.
- **Standard library / framework APIs** — these are already tested by their maintainers. Mock only if they have side effects (network, filesystem, time).
- **Data structures / value objects** — never mock. These are data, not behavior.

### Errors Must Propagate

Do not add defensive try/catch in tests. Let unexpected failures surface as test failures. Errors are signal, not noise to be silenced.

```python
# GOOD — error surfaces naturally
result = service.process(invalid_input)
assert result.status == "error"

# BAD — swallows the error, test passes when it shouldn't
try:
    service.process(invalid_input)
except Exception:
    pass  # "I expected it might fail" — did it fail the RIGHT way?
```

---

## Part 5: Observable-Behavior Testing

Coverage percentage is NOT the goal. **Observable-behavior testing is.**

### What to Assert On

Assert on **externally visible effects**:
- Return values
- State changes (database rows, file contents, in-memory state via public API)
- Output content (stdout, HTTP response body, rendered UI)
- Side effects (messages sent, events emitted, files written)
- Exit codes / error types

### What NOT to Assert On

Do NOT assert on:
- Internal call counts (`expect(fn).toHaveBeenCalledTimes(3)`)
- Private method invocations
- Intermediate states that no external observer can see
- Implementation details (the fact that a cache is a dict, not a list)

```python
# GOOD — asserts on observable result
result = pipeline.process(input_data)
assert result.errors == []
assert len(result.items) == 5

# BAD — asserts on internal implementation
assert pipeline._cache.hits == 3
assert pipeline._validator.was_called
```

If changing the implementation without changing the behavior breaks your test, you tested the wrong thing.

### Hard to Test = Hard to Use

A test that's painful to write is telling you something about the design:

| Test Pain | Design Problem |
|-----------|---------------|
| Don't know how to test | Interface is unclear |
| Test too complicated | Design too complicated |
| Must mock everything | Code too coupled |
| Test setup is huge | Missing abstractions |

Listen to the test. Fix the design, not the test.

---

## Part 6: Scope Decision Flow

Not every change requires running every test. But misjudging scope causes regressions.

### Minimum Required Test Scope

| Change touches | Minimum scope |
|---------------|---------------|
| Shared infrastructure (config, auth, logging, database client) | Full test suite |
| Cross-module contract (API schema, data format, protocol) | Full test suite |
| Single module internals | Unit tests for that module |
| New feature (isolated) | Unit tests for the feature + integration test at boundary |
| Bug fix | Test reproducing the bug + unit tests for the fix + check for related cases |
| Refactoring (no behavior change) | Existing tests must still pass; no new tests required |
| Documentation / config only | No tests required |

### Rule of Thumb

- Change crosses a module boundary → run integration tests.
- Change modifies a shared constant, type, or interface → run full suite.
- Change is isolated to one module's internals → unit tests for that module only.

### When in Doubt

Run the full suite. A minute of CI time is cheaper than a regression in production.

---

## Part 7: Per-Test Isolation

Tests must not leak state into each other. A test whose outcome depends on run order is a lie waiting to surface.

**Rules:**
- Each test file sets up and tears down its own context (database, files, environment)
- No shared mutable state across test files
- Use unique identifiers per test run (timestamps, UUIDs) for any persistent resources

```
# GOOD — isolated
TEST_DB = f"test_{uuid4().hex}"
db = create_database(TEST_DB)
yield db
drop_database(TEST_DB)

# BAD — shared state leaks
db = connect_to("test_db")  # All tests share this
```

---

## Part 8: Why Order Matters

**"I'll write tests after to verify it works"**

Tests written after code pass immediately. Passing immediately proves nothing:
- Might test the wrong thing
- Might test implementation, not behavior
- Might miss edge cases you forgot
- You never saw it catch the bug

Test-first forces you to see the test fail, proving it actually tests something.

**"I already manually tested all the edge cases"**

Manual testing is ad-hoc. You think you tested everything but:
- No record of what you tested
- Can't re-run when code changes
- Easy to forget cases under pressure
- "It worked when I tried it" ≠ comprehensive

Automated tests are systematic. They run the same way every time.

**"Deleting X hours of work is wasteful"**

Sunk cost fallacy. The time is already gone. Your choice now:
- Delete and rewrite with TDD (high confidence)
- Keep it and add tests after (low confidence, likely bugs)

The "waste" is keeping code you can't trust.

**"TDD is dogmatic, being pragmatic means adapting"**

TDD IS pragmatic:
- Finds bugs before commit (faster than debugging after)
- Prevents regressions (tests catch breaks immediately)
- Documents behavior (tests show how to use code)
- Enables refactoring (change freely, tests catch breaks)
- Governed tests stay trustworthy (classification + trust-justification prevent rot)

"Pragmatic" shortcuts = debugging in production = slower.

**"Tests after achieve the same goals — it's spirit not ritual"**

No. Tests-after answer "What does this do?" Tests-first answer "What should this do?"

Tests-after are biased by your implementation. You test what you built, not what's required. Tests-first force edge case discovery before implementing.

---

## Part 9: Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Tests after achieve same goals" | Tests-after = "what does this do?" Tests-first = "what should this do?" |
| "Already manually tested" | Ad-hoc ≠ systematic. No record, can't re-run. |
| "Deleting X hours is wasteful" | Sunk cost fallacy. Keeping unverified code is technical debt. |
| "Keep as reference, write tests first" | You'll adapt it. That's testing after. Delete means delete. |
| "Need to explore first" | Fine. Throw away exploration, start with TDD. |
| "Test hard = design unclear" | Listen to the test. Hard to test = hard to use. |
| "TDD will slow me down" | TDD faster than debugging. Pragmatic = test-first. |
| "Manual test faster" | Manual doesn't prove edge cases. You'll re-test every change. |
| "Existing code has no tests" | You're improving it. Add tests for the code you touch. |
| "Mock is fine, it's obvious why" | No TRUST-JUSTIFICATION, no mock. Obvious to you ≠ obvious in 6 months. |
| "This test is temporary" | Then put it in scratch/ with a date. "Temporary" without a delete-by date is permanent. |
| "Coverage is high, we're good" | Coverage measures execution, not verification. 100% coverage with bad assertions = 0% confidence. |

---

## Part 10: Red Flags — STOP and Start Over

If you catch yourself doing any of these, delete the code and restart with TDD:

- Code before test
- Test after implementation
- Test passes immediately on first run
- Can't explain why test failed
- Tests added "later"
- Rationalizing "just this once"
- "I already manually tested it"
- "Tests after achieve the same purpose"
- "Keep as reference" or "adapt existing code"
- "Already spent X hours, deleting is wasteful"
- "TDD is dogmatic, I'm being pragmatic"
- "This is different because..."
- Adding a mock without a TRUST-JUSTIFICATION
- Asserting on internal call counts instead of observable behavior
- Test outcome depends on which tests ran before it
- "This test doesn't need a home, I'll figure it out later"

**All of these mean: Delete code. Start over with TDD.**

---

## Part 11: Verification Checklist

Before marking work complete:

### RED-GREEN-REFACTOR
- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)

### Test Quality
- [ ] Tests assert on observable behavior, not internal implementation
- [ ] Tests use real code (mocks only where TRUST-JUSTIFICATION is recorded)
- [ ] Edge cases and errors covered
- [ ] Each test is isolated — no shared mutable state across tests

### Test Governance
- [ ] Every core test has a CORE-RETENTION header
- [ ] Every mock has a TRUST-JUSTIFICATION comment immediately above it
- [ ] Scratch tests are in the correct dated directory
- [ ] Scratch directories older than the retention window are deleted
- [ ] No unlabeled "temporary" tests sitting in core directories

Can't check all boxes? You skipped something. Start over.

---

## Part 12: Testing Anti-Patterns

- **Testing mock behavior instead of real behavior** — mocks should isolate, not replace the system under test
- **Testing implementation details** — test behavior/results, not internal method calls
- **Happy path only** — always test edge cases, errors, and boundaries
- **Brittle tests** — tests should verify behavior, not structure; refactoring shouldn't break them
- **Test suite graveyard** — unclassified, ungoverned tests that no one trusts or runs; prevented by Part 3
- **Mock without justification** — a lie with no record of why the lie is safe; prevented by Part 4
- **Coverage obsession** — optimizing for line coverage while ignoring assertion quality; prevented by Part 5
- **Leaky tests** — tests that depend on run order or shared state; prevented by Part 7
- **Swallowed errors** — try/catch in tests that mask real failures; prevented by Part 4

---

## Part 13: When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write the wished-for API. Write the assertion first. Ask the user. |
| Test too complicated | Design too complicated. Simplify the interface. |
| Must mock everything | Code too coupled. Use dependency injection. |
| Test setup huge | Extract helpers. Still complex? Simplify the design. |
| Not sure if test is core or scratch | Default to scratch. Promote later if it proves its worth. |
| Not sure if mock is justified | It probably isn't. Write the TRUST-JUSTIFICATION — if you can't fill the Evidence field, don't mock. |

## Final Rule

```
Production code → test exists and failed first
Core test       → CORE-RETENTION header present
Mock            → TRUST-JUSTIFICATION recorded
Scratch test    → dated directory, deleted within window
Otherwise       → not TDD
```

No exceptions without the user's explicit permission.
