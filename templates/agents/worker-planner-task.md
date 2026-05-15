## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}
**Spec doc**: {{task_doc_path}}

## Origin
The user's original requirement is preserved verbatim at `{{original_requirement_path}}`. Read it first whenever the task description feels under-specified — the authoritative intent lives there, not in the description above.

## Intent
The Leader needs a blueprint that downstream Builder / Verifier / Reviewer / Accepter can execute in sequence. Produce a self-contained design document — architecture, interfaces, data flow, concrete Build steps with verifiable acceptance criteria — so each downstream link can ground its work in this one file.

## Required Output Files
You MUST write your blueprint to **exactly** these two paths:

- `result_path` (Leader cache, authoritative cross-worktree source):
  `{{result_path}}`
- `local_doc_path` (in-worktree copy):
  `{{local_doc_path}}`

Use the **Write** tool for both. Both paths are non-negotiable. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty.

## Retry Context
{{retry_hint}}
