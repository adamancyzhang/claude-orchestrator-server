## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Origin
The user's original requirement is at `{{original_requirement_path}}`. Use it as ground-truth — items the Plan omits but the original requirement demands must be flagged as GAP.

## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Executor traceability map: `{{upstream_execute_artifact}}`

If either is missing, write a single-line BLOCKED report to `result_path` naming the missing artifact and stop — do not invent results.

## Upstream Commits
- Plan: `{{upstream_plan_commit}}`
- Execute: `{{upstream_execute_commit}}`

Use `git show <hash>` / `git log <a>..<b>` to inspect upstream commits.

## Intent
Cross-reference Plan ↔ Execute to build a verification checklist. Classify every item: PASS, GAP, FAILURE, DEVIATION. Be terse but unambiguous; the Reviewer will use this map verbatim.

## Required Output Files

- `result_path`: `{{result_path}}`
- `local_doc_path`: `{{local_doc_path}}`

Save evidence under `{{co_root}}/docs/{{name}}/{{date}}/evidence/`. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty.

{{retry_hint}}
