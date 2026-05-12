---
name: task-traceability
description: Enforce the traceable task execution workflow for every task. Every code change must be committed with the developer's own name and the commit hash recorded back in the task document so that all modifications are auditable. Use this skill whenever a team member is about to execute a documented task, start working on an assigned item, commit code changes, or complete a task. Triggers on any task execution context: task assignment documents, work plans, daily work assignments, or when the user is about to make code changes in response to a documented task.
---

# Traceable Task Execution Workflow

Every task must leave a traceable chain: **task document → code changes → commit hash → document update → document commit**. This makes every modification auditable — anyone can look at a task document and find exactly which commits implemented each item.

## The Five Steps (Must Not Skip or Reorder)

```
Step 1: Read task document
  └── Understand what's assigned, what verification is expected

Step 2: Execute the task
  └── Make code changes, write tests, produce deliverables

Step 3: Commit code changes
  └── git add + git commit, signed with your own name

Step 4: Update task document
  └── Record commit hash(es) + status next to each completed item

Step 5: Commit document update
  └── git add + git commit the document with the traceability record
```

## Why This Matters

Without recording commit hashes back in the task document, the chain is broken. A reviewer sees "done" in a document but has no way to find the actual code changes. The commit hash is the bridge — it connects the task description to the implementation.

## Step-by-Step Detail

### Step 1: Read the Task Document

Locate and read the assigned task document. Identify which items are assigned to you and what verification method is expected for each. Do not start coding until you understand what "done" looks like.

### Step 2: Execute the Task

Make the code changes as described in the task. Follow the project's existing development discipline and code conventions. Produce any required deliverables (test reports, screenshots, design docs) alongside the code.

### Step 3: Commit Code Changes

Commit in the appropriate repository. Format:

```
<type>(<scope>): <description>

<optional body>

<Your Name>
```

Example:
```
feat(frontend): add FileChangeBlock 4-state rendering tests

Implements test cases for writing/pending/accepted/rejected states.
All 4 states pass with MSW handlers.

Jerry
```

Key rules:
- Sign with **your own name** at the end of every commit message — this identifies who made the change
- One logical unit per commit — don't batch unrelated changes
- Run `git status` before committing to confirm what's staged
- Never amend a published commit

### Step 4: Update the Task Document with Commit Hash

After committing, return to the task document and update it. For each completed item, add:
- The commit hash (short form is fine as long as it's unambiguous within the repo)
- Status marker (e.g., `✅` for completed)
- Brief note if anything deviated from the plan

**Before (task as assigned):**
```markdown
| 1 | 编写 FileChangeBlock 测试 | 4 态渲染测试 | `pnpm vitest run` 通过 |
```

**After (task with traceability):**
```markdown
| 1 | 编写 FileChangeBlock 测试 | 4 态渲染测试 | `pnpm vitest run` 通过 | ✅ `a1b2c3d` |
```

If a task spans multiple commits, list all of them:
```markdown
| 3 | 重构 store 层 | 类型安全 + 单元测试覆盖 | ✅ `d4e5f6a`, `g7h8i9b` |
```

### Step 5: Commit the Document Update

The document update itself must be committed so the traceability record is persisted:

```
docs: update task document with commit hashes for completed items

Jerry
```

This closes the loop: anyone reading the document can trace each task item to its exact code changes via `git show <hash>`.

## Task Completion Checklist

```
□ Step 1: Read and understood the task document
□ Step 2: Completed code changes with verification
□ Step 3: Committed code, signed with my own name
□ Step 4: Updated task document with commit hash(es) + status
□ Step 5: Committed the document update
```

## Common Mistakes to Avoid

- **Committing without recording the hash in the document**: The most common break in traceability. Always do Step 4 immediately after Step 3.
- **Batching unrelated changes in one commit**: Makes it impossible to trace which commit corresponds to which task item.
- **Recording "done" without a hash**: "Done" without a commit hash is invisible to future readers. Always include the hash.
- **Skipping the document commit (Step 5)**: The updated document with hashes must be committed. Uncommitted document changes are lost traceability.
- **Signing with someone else's name**: Each commit must be signed with the name of the person who made the change. Traceability depends on knowing who did what.
