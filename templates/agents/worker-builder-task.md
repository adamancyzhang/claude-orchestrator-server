## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Origin
The user's original requirement is preserved verbatim at `{{original_requirement_path}}`. Cross-check the Planner blueprint against this file before implementing — if the blueprint contradicts the original intent, surface the conflict in your output instead of silently following the blueprint.

## Upstream Artifacts (read first, in order)
1. Planner blueprint (authoritative): `{{upstream_plan_artifact}}`
2. In-worktree resume copy (only if a previous build attempt exists): `{{local_doc_path}}`
3. If both are missing → BLOCK and report to Leader via the completion report.

Extract every implementable requirement as a checklist before writing code.

## Workspace Memory (fast reference)
Before modifying a source file, check `{{workspace_memory_path}}/<relative-source-path>.md` (per-file summary) and the `CLAUDE.md` in its parent directory (directory overview). They mirror the project's source tree and capture purpose, public exports, key invariants, and cross-file dependencies. Treat them as **hints, not ground truth** — if a memory file is missing or its `source_hash` is stale, fall back to the source file.

## Intent
Implement the requirements in the Planner's blueprint, leaving an evidence trail the Verifier can independently re-walk. Map every line of your traceability output back to the blueprint item it satisfies.

## Required Output Files
You MUST write your traceability map to **exactly** these two paths:

- `result_path` (Leader cache, authoritative cross-worktree source):
  `{{result_path}}`
- `local_doc_path` (in-worktree copy for downstream Verifier):
  `{{local_doc_path}}`

Save evidence (logs, screenshots, test runs) under
`.claude-orchestrator/docs/{{name}}/{{date}}/evidence/`.

Use the **Write** tool for both paths. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty. Commit your code changes with your name in the signature.

## Retry Context
{{retry_hint}}
