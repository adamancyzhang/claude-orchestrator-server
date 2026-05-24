## Task: Summarize a directory into workspace memory

You are generating a directory-level index (`CLAUDE.md`) for workspace memory. Workers read it to orient themselves at a directory level before drilling into individual files.

### Source

- **Directory**: `{{dir_path}}` (relative to the project workspace root)
- **Working dir**: `{{work_dir}}` (you can `Read` `{{work_dir}}/{{dir_path}}/...`)
- **Already-generated file summaries in this directory**:

{{file_summaries_block}}

(Each entry above is `<filename>: <Purpose section>`. Use these — do not re-read the underlying source files unless an entry is missing or clearly insufficient.)

### Required output

Write **exactly** to `{{result_path}}` using the **Write** tool. The file MUST be:

```markdown
---
dir: {{dir_path}}
updated_at: {{date}}
---

## 目录职责
(1–2 sentences — what role this directory plays in the system as a whole.)

## 入口文件
- `<file>.ts` — <one-line description of why a reader should start here>
- ...

(List 2–4 files that a new reader should open first to understand this directory. If the directory is a leaf with no obvious entry point, write "(no single entry point — read files in alphabetical order)".)

## 子目录
- `<subdir>/` — <one-line role>
- ...

(Omit the section if there are no subdirectories.)

## 关键文件清单
| 文件 | 一句话摘要 |
|------|-----------|
| <file>.md → <file>.ts | <one-line from the file's Purpose> |
| ...
```

### Constraints

- **Be terse.** A reader should grasp this directory in under 30 seconds.
- **Do NOT** invent files that are not in the input list.
- **Do NOT** add commentary outside the schema above.
- After writing, use the **Read** tool on `{{result_path}}` to confirm the file exists and is non-empty.
