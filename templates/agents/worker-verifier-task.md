## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Origin
The user's original requirement is preserved verbatim at `{{original_requirement_path}}`. Use it as the ground-truth when judging whether Plan↔Execute coverage is actually complete — items the Plan omits but the original requirement demands must be flagged as GAP.

## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Executor traceability map: `{{upstream_execute_artifact}}`

If either upstream artifact is missing, write a single-line BLOCKED report to `result_path` naming the missing artifact and stop — do not invent results.

## Upstream Commits
Your worktree has been rebased onto the latest upstream link. Hashes:
- Plan: `{{upstream_plan_commit}}`
- Execute: `{{upstream_execute_commit}}`

Use `git show <hash>` / `git log <a>..<b>` when you need to inspect the upstream commits directly.

## Workspace Memory (fast reference)
Before walking through a source file referenced by Plan/Execute, check `{{workspace_memory_path}}/<relative-source-path>.md` (per-file summary) and the `CLAUDE.md` in its parent directory (directory overview). They mirror the project's source tree and capture purpose, public exports, key invariants, and cross-file dependencies. Treat them as **hints, not ground truth** — if a memory file is missing or its `source_hash` is stale, fall back to the source file.

## Intent
Cross-reference Plan ↔ Execute to build a verification checklist. Classify every item: PASS, GAP, FAILURE, DEVIATION. Be terse but unambiguous; the Reviewer will use this map verbatim.

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
