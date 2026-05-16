## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Origin
The user's original requirement is preserved verbatim at `{{original_requirement_path}}`. Anchor your ACCEPT/CONCERN/REJECT judgments to whether the original intent is satisfied — not merely whether each upstream link agrees with the one before it.

## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Builder traceability map: `{{upstream_build_artifact}}`
3. Verifier verification map: `{{upstream_verify_artifact}}`

If any of the three upstream artifacts is missing, write a single-line BLOCKED report to `result_path` naming the missing artifact and stop.

## Workspace Memory (fast reference)
Before judging changes to a source file, check `{{workspace_memory_path}}/<relative-source-path>.md` (per-file summary) and the `CLAUDE.md` in its parent directory (directory overview). They mirror the project's source tree and capture purpose, public exports, key invariants, and cross-file dependencies. Treat them as **hints, not ground truth** — if a memory file is missing or its `source_hash` is stale, fall back to the source file.

## Intent
Judge whether the combined Plan + Build + Verify output aligns with the Planner's intent. For each checklist item, output ACCEPT / CONCERN (state which link addresses it) / REJECT (state why fundamentally fails).

## Required Output Files
You MUST write your review judgment to **exactly** these two paths:

- `result_path` (Leader cache):
  `{{result_path}}`
- `local_doc_path` (in-worktree copy for downstream Accepter):
  `{{local_doc_path}}`

Use the **Write** tool for both paths. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty.

## Retry Context
{{retry_hint}}
