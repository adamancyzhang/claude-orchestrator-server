## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Origin
The user's original requirement is at `{{original_requirement_path}}`. Anchor your judgments to the original intent, not to intermediate re-interpretations.

## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Executor traceability map: `{{upstream_execute_artifact}}`
3. Verifier verification map: `{{upstream_verify_artifact}}`

If any is missing, write a single-line BLOCKED report to `result_path` naming the missing artifact and stop.

## Upstream Commits
- Plan: `{{upstream_plan_commit}}`
- Execute: `{{upstream_execute_commit}}`
- Verify: `{{upstream_verify_commit}}`

Use `git show <hash>` / `git log <a>..<b>` to inspect upstream commits.

## Intent
Judge whether the combined Plan + Execute + Verify output aligns with the Planner's intent. Classify every checklist item: ACCEPT (meets intent), CONCERN (specify which link), REJECT (fundamentally fails). Output PASS / FEEDBACK / REJECT.

## Required Output Files

- `result_path`: `{{result_path}}`
- `local_doc_path`: `{{local_doc_path}}`

After writing, use the **Read** tool on `result_path` to confirm.

{{retry_hint}}
