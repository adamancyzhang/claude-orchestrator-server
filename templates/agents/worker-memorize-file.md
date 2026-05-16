## Task: Summarize a single source file into workspace memory

You are generating a workspace-memory entry that downstream Workers will read **before** opening the source file itself, to save reading the file in full when a short reference suffices.

### Source

- **File**: `{{source_path}}` (path is relative to the project workspace root)
- **Working dir**: `{{work_dir}}` (you can `Read` `{{work_dir}}/{{source_path}}`)
- **Source hash**: `{{source_hash}}` — embed verbatim in the front-matter so consumers can detect staleness later

### Required output

Write **exactly** to `{{result_path}}` using the **Write** tool. The file MUST be:

```markdown
---
source: {{source_path}}
source_hash: {{source_hash}}
updated_at: {{date}}
---

## Purpose
(1–2 sentences — why this file exists. Concrete, not generic.)

## Public exports
- `<symbol name>` — <one-line description>
- ...

(If the file has no exports — e.g. an entry script or test — omit the list and write a single line describing what it does at the top level.)

## Key invariants / non-obvious behavior
- <invariants that aren't obvious from reading the signatures>
- <ordering constraints, side effects, hidden state>
- (omit the section if there are none)

## Depends on
- `<other source path>` — <why>
- ...

(List only **non-trivial** internal dependencies — packages within this monorepo. Skip stdlib and well-known third-party libraries.)

## Touched by chain links
- <plan | build | verify | review | accept> — <when>
```

### Constraints

- **Be terse.** A reader should grasp this file in under 30 seconds.
- **Do NOT** copy-paste the source. Summarize, do not quote.
- **Do NOT** speculate about future changes or design alternatives.
- **Do NOT** add introductions, conclusions, or commentary outside the schema above.
- After writing, use the **Read** tool on `{{result_path}}` to confirm the file exists and is non-empty.
