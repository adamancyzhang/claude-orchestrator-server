## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Origin
The user's original requirement is at `{{original_requirement_path}}`. Cross-check the Planner blueprint against this file before implementing — if the blueprint contradicts the original intent, surface the conflict in your output.

## Upstream Artifacts (read first, in order)
1. Planner blueprint (authoritative): `{{upstream_plan_artifact}}`
2. In-worktree resume copy: `{{local_doc_path}}`
3. If both are missing → BLOCK and report to Leader.

Extract every implementable requirement as a checklist before writing code.

## Upstream Commits
Your worktree has been rebased onto the immediate predecessor.
- Plan: `{{upstream_plan_commit}}`

Use `git show <hash>` / `git log --oneline <hash>` to inspect upstream commits. Your execute commit will land on top of plan.

## Intent
Implement the requirements in the Planner's blueprint, leaving an evidence trail the Verifier can independently re-walk. Map every line of your traceability output back to the blueprint item it satisfies.

## Required Output Files

- `result_path`: `{{result_path}}`
- `local_doc_path`: `{{local_doc_path}}`

Save evidence under `{{co_root}}/docs/{{name}}/{{date}}/evidence/`. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty. Commit your code changes with your name in the signature.

{{retry_hint}}
