## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Origin
The user's original requirement is preserved verbatim at `{{original_requirement_path}}`. The GO/NO-GO call must be made against this file — not the Planner blueprint, not the Reviewer judgment. If the chain has drifted from the original intent, that alone is grounds for NO-GO.

## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Builder traceability map: `{{upstream_build_artifact}}`
3. Verifier verification map: `{{upstream_verify_artifact}}`
4. Reviewer judgment: `{{upstream_review_artifact}}`

If any of the four upstream artifacts is missing, write a single-line BLOCKED report to `result_path` naming the missing artifact and stop.

## Workspace Memory (fast reference)
Before validating that a deliverable file actually exists or behaves as claimed, check `{{workspace_memory_path}}/<relative-source-path>.md` (per-file summary) and the `CLAUDE.md` in its parent directory (directory overview). They mirror the project's source tree and capture purpose, public exports, key invariants, and cross-file dependencies. Treat them as **hints, not ground truth** — if a memory file is missing or its `source_hash` is stale, fall back to the source file.

## Intent
Make a binary GO / NO-GO call. For each acceptance criterion: does the deliverable exist? Are Verifier FAILUREs resolved? Are Reviewer CONCERNs addressed? Is evidence independently verifiable?

- **GO**: All criteria met. Zero unresolved issues.
- **NO-GO**: Any criterion unmet — list every failed criterion and which link must address it. No conditional pass.

## Required Output Files
You MUST write your acceptance report to **exactly** these two paths:

- `result_path` (Leader cache):
  `{{result_path}}`
- `local_doc_path` (in-worktree copy):
  `{{local_doc_path}}`

Use the **Write** tool for both paths. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty.

## Retry Context
{{retry_hint}}
