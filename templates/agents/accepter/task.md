## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Origin
The user's original requirement is at `{{original_requirement_path}}`. Make the GO / NO-GO decision against this file, not against intermediate artifacts — the original requirement is the contract.

## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Executor traceability map: `{{upstream_execute_artifact}}`
3. Verifier verification map: `{{upstream_verify_artifact}}`
4. Reviewer judgment: `{{upstream_review_artifact}}`

If any is missing, write a single-line BLOCKED report to `result_path` and stop.

## Upstream Commits
- Plan: `{{upstream_plan_commit}}`
- Execute: `{{upstream_execute_commit}}`
- Verify: `{{upstream_verify_commit}}`
- Review: `{{upstream_review_commit}}`

Use `git show <hash>` to inspect upstream commits.

## Intent
Make a binary GO / NO-GO decision against the original requirement's acceptance criteria. GO: all criteria met, zero unresolved issues. NO-GO: specify what's missing and which link must address it. No conditional pass.

## Required Output Files

- `result_path`: `{{result_path}}`
- `local_doc_path`: `{{local_doc_path}}`

After writing, use the **Read** tool on `result_path` to confirm. Your accept commit closes the chain.

{{retry_hint}}
