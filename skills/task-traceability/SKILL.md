---
name: task-traceability
description: Foundational traceability layer for the entire Plan→Build→Verify→Review→Accept responsibility chain. Every role must leave a traceable record: upstream requirements → execution → output mapping → evidence → persisted record. Without traceability at every link, the chain cannot be audited, handoffs break, and sign-off is unreliable. Use this skill whenever any team member executes work in any link of the responsibility chain — planning, building, verifying, reviewing, or accepting. Triggers on any task execution context: task assignment, work plans, code changes, verification, review, or acceptance.
---

# Task Traceability — Foundational Layer

Traceability is not optional. It is the foundation that makes the Plan→Build→Verify→Review→Accept chain auditable, handoffs reliable, and sign-off meaningful. **Every link must produce a traceable record. A single broken link breaks the entire chain.**

## The Universal Five-Step Pattern

Every role in the chain follows the same five-step pattern, applied to its specific context:

```
Step 1: Trace (追溯)
  └── Identify all upstream requirements and artifacts you must reference

Step 2: Execute (执行)
  └── Do the work, following the traced requirements

Step 3: Map (映射)
  └── Link every output back to a specific upstream requirement

Step 4: Evidence (举证)
  └── Provide proof that each mapping is correct and complete

Step 5: Record (记录)
  └── Persist the traceability record so downstream roles can pick up the chain
```

**Why five steps?** Without Trace, you don't know what to do. Without Map, nobody knows why you did it. Without Evidence, your output is unverifiable. Without Record, the next link starts blind.

## Why Every Link Matters

```
Plan ──→ Build ──→ Verify ──→ Review ──→ Accept
  │         │         │          │           │
  │         │         │          │           └── Break here → sign-off is unverifiable
  │         │         │          └── Break here → audit trail is incomplete
  │         │         └── Break here → verification is untrustworthy
  │         └── Break here → implementation is untraceable
  └── Break here → entire chain starts without a foundation
```

A chain is only as strong as its weakest link. Traceability must be enforced at **every** link.

## Role-Specific Application

### Plan — Blueprint Traceability

Plan is the chain's foundation. If blueprint traceability is broken, every downstream link is working from ambiguity.

| Step | Action |
|------|--------|
| **Trace** | Read the original requirement. Extract business goals, constraints, scope boundaries, and success criteria. |
| **Execute** | Design the blueprint: architecture, interfaces, data flow. Break into ordered Build steps, each with completion criteria. |
| **Map** | Every Build step must trace back to a specific requirement. Every completion criterion must be objectively verifiable. |
| **Evidence** | Self-check: can a Builder start from this blueprint alone? Are edge cases covered? Are interfaces unambiguous? |
| **Record** | Write the blueprint document. Push tasks to the orchestrator queue. Store the blueprint in shared context (`set-context`). Notify Leader. |

**Plan traceability record**: `requirement → blueprint → task list → shared context key`

### Build — Implementation Traceability

Build produces the concrete artifacts. Every code change must be traceable to a specific Plan requirement.

| Step | Action |
|------|--------|
| **Trace** | Read the Planner's blueprint. Extract every implementable requirement as a checklist. |
| **Execute** | Implement each requirement. Follow the Plan's architecture and interfaces. Document any deviations. |
| **Map** | Build a traceability map: `Plan Requirement → Implementation → Status (done/deviated/blocked)`. |
| **Evidence** | Provide proof: tests passing, manual verification results, key implementation decisions and rationale. |
| **Record** | Commit code signed with your own name. Record the commit hash next to each completed item in the task document. Commit the document update. |

**Build traceability record**: `blueprint requirement → code change → commit hash → document update → document commit`

### Verify — Verification Traceability

Verify independently checks Builder output. Every verification finding must be traceable to a Plan acceptance criterion and a Builder output.

| Step | Action |
|------|--------|
| **Trace** | Read the Plan blueprint (acceptance criteria) and Builder output (commits, artifacts). Build a verification checklist by cross-referencing. |
| **Execute** | For each checklist item, independently verify. Run tests. Inspect code. Check edge cases and regressions. |
| **Map** | Build a verification map: `Plan Criterion → Builder Output → Verified Result → Status (pass/gap/fail)`. |
| **Evidence** | For each finding, record: what was checked, how, actual command output, and references to Plan and Builder artifacts. |
| **Record** | Write the verification report. Store in shared context. Flag gaps and failures to Builder and Reviewer. |

**Verify traceability record**: `acceptance criterion → verification method → actual result → verdict → report path`

### Review — Judgment Traceability

Review judges the full chain. Every judgment must be traceable to Plan intent, Builder output, and Verify findings.

| Step | Action |
|------|--------|
| **Trace** | Read all upstream artifacts: Plan blueprint, Builder traceability map, Verify report. Build a chain-level review checklist. |
| **Execute** | For each item, make a judgment: ACCEPT / CONCERN / REJECT. Classify issues as P0 (blocking) / P1 (severe) / P2 (minor) / P3 (suggestion). |
| **Map** | Build a review map: `Plan Intent → Build Result → Verify Finding → Review Judgment`. |
| **Evidence** | For each CONCERN and REJECT: reference the specific Plan requirement, Builder output, Verify finding, and clear rationale. |
| **Record** | Write the review report. Store in shared context. Issue Pass/Revise decision. Notify responsible roles. |

**Review traceability record**: `plan intent → build result → verify finding → review judgment → report path → decision`

### Accept — Sign-Off Traceability

Accept is the final gate. The Go/No-Go decision must be traceable to specific business acceptance criteria and verified deliverables.

| Step | Action |
|------|--------|
| **Trace** | Read the full chain: Plan blueprint, Builder output, Verify report, Review judgment. Extract business acceptance criteria. |
| **Execute** | For each acceptance criterion, verify: is there a corresponding deliverable? Does it actually exist? Are upstream issues resolved? |
| **Map** | Build an acceptance map: `Acceptance Criterion → Deliverable → Verification Result → Review Judgment → Status`. |
| **Evidence** | For each criterion: verify code exists (grep), verify commits exist (git log), verify tests pass (run them), verify reports are self-consistent. |
| **Record** | Write the acceptance report. Sign Go/No-Go. Zero issues for Go — no conditional passes. Store in shared context. |

**Accept traceability record**: `acceptance criterion → deliverable → verification → review → Go/No-Go → report path`

## The Traceability Record Chain

When every link records its traceability, the full chain is auditable from end to end:

```
Business Requirement
  └── Plan: blueprint → task-001(task-0000000001), task-002(task-0000000002)
        └── Build: task-001 → commit a1b2c3d → doc update commit e4f5g6h
              └── Verify: criterion A → test X passed, criterion B → gap found
                    └── Review: gap B → CONCERN P1 → Revise decision
                          └── Re-Build: fix gap B → commit i7j8k9l
                                └── Re-Verify: criterion B → test Y passed
                                      └── Re-Review: all clear → Pass
                                            └── Accept: all criteria met → GO
```

Anyone can enter the chain at any point and traverse forward or backward. A reviewer can ask "what requirement led to this commit?" and get the answer in one step. An auditor can ask "was this acceptance criterion verified?" and find the verification report, the test output, and the reviewer's judgment.

## Task Completion Checklist (All Roles)

```
□ Step 1 — Trace: Identified all upstream requirements and artifacts
□ Step 2 — Execute: Completed work following traced requirements
□ Step 3 — Map: Every output linked to a specific upstream requirement
□ Step 4 — Evidence: Proof provided for each mapping
□ Step 5 — Record: Traceability record persisted (commit, context store, or report)
```

## Common Mistakes (All Roles)

- **Skipping Trace (Step 1)**: Starting work without reading upstream artifacts. Produces output that may not align with requirements.
- **Skipping Map (Step 3)**: Producing output without linking it back to requirements. Downstream roles can't tell what was done for what.
- **Map without Evidence (Step 4)**: Claiming "done" without proof. Unverifiable claims are invisible to auditors.
- **Skipping Record (Step 5)**: Doing the work but not persisting the traceability record. The next link starts blind — the chain is broken.
- **Weak evidence**: "Looks good" is not evidence. Specific commands run, specific outputs observed, specific file paths checked — these are evidence.
- **Signing with someone else's name**: Traceability depends on knowing who did what. Every commit and report must identify its author.
