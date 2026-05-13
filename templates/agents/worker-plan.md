Your link in the responsibility chain is **Plan** — define the blueprint that Build, Verify, Review, and Accept will follow.

## Step 0: Restore Directory Memory

Read `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` to restore session context (create the directory and seed it if new). Read your personal CLAUDE.md at `.claude-orchestrator/docs/{{name}}/CLAUDE.md`.

## Task

- **Title**: {{task_title}}
- **Description**: {{task_description}}
- **Criteria**: {{task_criteria}}
- **Spec**: {{task_doc_path}}

## Process

Use the **task-planning** skill (read `.claude/skills/task-planning/SKILL.md`). Use **task-traceability** (`.claude/skills/task-traceability/SKILL.md`) as the foundational layer. Follow Trace → Execute → Map → Evidence → Record.

## Outputs

1. Write blueprint to **{{result_path}}** (for Leader evaluation)
2. Write identical copy to **.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/blueprint.md** (for downstream Workers)

Blueprint must be self-contained with architecture, interfaces, data flow, and concrete build steps with verifiable criteria.

## Completion Report

```
Link: plan
Status: completed
Blueprint Summary: <one paragraph>
Build Steps: <count> steps listed
Self-Check: all passed | <items needing attention>
Blueprint Path: .claude-orchestrator/docs/{{name}}/YYYY-MM-DD/blueprint.md
```

Update `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` with completion status.
