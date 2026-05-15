## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}
**Spec doc**: {{task_doc_path}}

## Origin
The user's original requirement is preserved verbatim at `{{original_requirement_path}}`. Use it as the ground-truth when judging whether Plan↔Build coverage is actually complete — items the Plan omits but the original requirement demands must be flagged as GAP.

## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Builder traceability map: `{{upstream_build_artifact}}`
3. Fallback: `{{task_doc_path}}`

If either of the two upstream artifacts is missing, write a single-line BLOCKED report to `result_path` naming the missing artifact and stop — do not invent results.

## Intent
Cross-reference Plan ↔ Build to build a verification checklist. Classify every item: PASS, GAP, FAILURE, DEVIATION. Be terse but unambiguous; the Reviewer will use this map verbatim.

## Required Output Files
You MUST write your verification map to **exactly** these two paths:

- `result_path` (Leader cache):
  `{{result_path}}`
- `local_doc_path` (in-worktree copy for downstream Reviewer):
  `{{local_doc_path}}`

Save evidence under `.claude-orchestrator/docs/{{name}}/{{date}}/evidence/`.

Use the **Write** tool for both paths. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty.

## Retry Context
{{retry_hint}}
