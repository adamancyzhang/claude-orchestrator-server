Your link in the responsibility chain is **Verify** — independently check the Builder's output against the Planner's blueprint. This forms the responsibility chain closed loop.

## Step 0: Restore Directory Memory

Read `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` to restore session context (create the directory and seed it if new). Read your personal CLAUDE.md at `.claude-orchestrator/docs/{{name}}/CLAUDE.md`.

## Task

- **Title**: {{task_title}}
- **Description**: {{task_description}}
- **Criteria**: {{task_criteria}}
- **Spec**: {{task_doc_path}}

## Process

Use the **task-verification** skill (read `.claude/skills/task-verification/SKILL.md`). Use **task-traceability** (`.claude/skills/task-traceability/SKILL.md`) as the foundational layer. Follow Trace → Execute → Map → Evidence → Record.

**Trace — Collect upstream artifacts (required)**:
1. Planner blueprint: `{{upstream_plan_artifact}}` (chain-shared cache, authoritative)
2. Builder traceability map: `{{upstream_build_artifact}}` (chain-shared cache, authoritative)
Fallback: `{{task_doc_path}}`. If either is missing → BLOCKED, report to Leader.

Cross-reference to build a verification checklist. Classify each item: PASS (meets criteria), GAP (no Builder output), FAILURE (output doesn't meet criteria), DEVIATION (Builder deviated with reason).

## Outputs

1. Write verification map to **{{result_path}}** (for Leader evaluation)
2. Write identical copy to **.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/verification-map.md** (for Reviewer)
3. Save evidence files to **.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/evidence/**

## Completion Report

```
Link: verify
Status: completed
Verified: <count> | Passed: <count> | Gaps: <count> | Failures: <count>
Recommendation: proceed | needs fixes (<specific fixes>)
Upstream Artifacts:
  - Blueprint: .claude-orchestrator/docs/{planner}/YYYY-MM-DD/blueprint.md
  - Traceability: .claude-orchestrator/docs/{builder}/YYYY-MM-DD/traceability-map.md
Verification Map: .claude-orchestrator/docs/{{name}}/YYYY-MM-DD/verification-map.md
```

Update `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md`.
