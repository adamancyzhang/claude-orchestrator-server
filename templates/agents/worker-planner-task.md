## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Origin
The user's original requirement is preserved verbatim at `{{original_requirement_path}}`. Read it first whenever the task description feels under-specified — the authoritative intent lives there, not in the description above.

## Workspace Memory (fast reference)
Before designing changes against a source file, check `{{workspace_memory_path}}/<relative-source-path>.md` (per-file summary) and the `CLAUDE.md` in its parent directory (directory overview). They mirror the project's source tree and capture purpose, public exports, key invariants, and cross-file dependencies — useful to scope the blueprint without reading every file in full. Treat them as **hints, not ground truth** — if a memory file is missing or its `source_hash` is stale, fall back to the source file.

## Intent
The Leader needs a blueprint that downstream Executor / Verifier / Reviewer / Accepter can execute in sequence. Produce a self-contained design document — architecture, interfaces, data flow, concrete Execute steps with verifiable acceptance criteria — so each downstream link can ground its work in this one file.

## Required Output Files
You MUST write your blueprint to **exactly** these two paths:

- `result_path` (Leader cache, authoritative cross-worktree source):
  `{{result_path}}`
- `local_doc_path` (in-worktree copy):
  `{{local_doc_path}}`

Use the **Write** tool for both. Both paths are non-negotiable. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty.

## Retry Context
{{retry_hint}}
