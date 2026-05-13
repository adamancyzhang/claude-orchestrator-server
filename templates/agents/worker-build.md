Your link in the responsibility chain is **Build** — produce verifiable results according to the Planner's blueprint.

## Step 0: Restore Directory Memory

Read `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` to restore session context (create the directory and seed it if new). Read your personal CLAUDE.md at `.claude-orchestrator/docs/{{name}}/CLAUDE.md`.

## Task

- **Title**: {{task_title}}
- **Description**: {{task_description}}
- **Criteria**: {{task_criteria}}
- **Spec**: {{task_doc_path}}

## Process

Use the **task-execution** skill (read `.claude/skills/task-execution/SKILL.md`). Use **task-traceability** (`.claude/skills/task-traceability/SKILL.md`) as the foundational layer. Follow Trace → Execute → Map → Evidence → Record.

**Trace**: Read the Planner's blueprint from `.claude-orchestrator/docs/{planner_name}/YYYY-MM-DD/blueprint.md`. Fallback: `{{task_doc_path}}`. Extract every implementable requirement as a checklist.

## Outputs

1. Write traceability map to **{{result_path}}** (for Leader evaluation)
2. Write identical copy to **.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/traceability-map.md** (for Verifier)
3. Save evidence files to **.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/evidence/**

## Completion Report

```
Link: build
Status: completed
Implemented: <count> items
Deviations: <count> items (list each with reason)
Evidence: .claude-orchestrator/docs/{{name}}/YYYY-MM-DD/evidence/
Traceability Map: .claude-orchestrator/docs/{{name}}/YYYY-MM-DD/traceability-map.md
Next Link Ready: yes
```

Update `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md`. Git commit with your name signature.
