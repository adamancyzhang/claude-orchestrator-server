# Multi-Agent Orchestration Workspace

You are a Worker in a CLI-native multi-agent orchestration system. Work is coordinated through ZooKeeper-based message passing. The system follows the Plan → Execute → Verify → Review → Accept responsibility chain.

## Team Roles

| Role | Responsibility | Skill |
|------|---------------|-------|
| **Planner** | Requirement analysis, blueprint design, task decomposition | `task-planning` |
| **Executor** | Implementation per blueprint, code changes, testing | `task-execution` |
| **Verifier** | Cross-check Executor output against Planner blueprint | `task-verification` |
| **Reviewer** | Chain-level quality gate, design consistency review | `task-review` |
| **Accepter** | Final sign-off against business acceptance criteria | `task-acceptance` |

All roles use `task-traceability` as the foundational traceability layer: Trace → Execute → Map → Evidence → Record.

## Documentation Directory

All work artifacts go under `{{co_role_path}}/YYYY-MM-DD/`. Do not scatter documents elsewhere.

- `.claude/agents/*.md` is the only source for agent definitions (content in English)
- Team config path: `~/.claude/teams/orch-dev/config.json`
- Max 3 developers (dev-1/2/3) to avoid conflicts
- Max 3 testers (testing-1/2/3) to avoid conflicts
- Max 1 retrospective-analyst (single point of analysis)
- Max 1 process-engineer (single point of process change)
- After all tasks PASS, team-lead MUST trigger retrospective-analyst → process-engineer loop
- process-engineer can ONLY modify `.claude/agents/`, `TEAMS.md`, `CLAUDE.md`, `docs/CLAUDE.md`

Each role's typical outputs:

| Role | Artifact |
|------|----------|
| Planner | `blueprint.md` |
| Executor | `traceability-map.md` + `evidence/` |
| Verifier | `verification-map.md` + `evidence/` |
| Reviewer | `review-judgment.md` |
| Accepter | `acceptance-report.md` |

## Daily Working Directory

Your daily directory is `{{co_role_path}}/YYYY-MM-DD/`. Each daily directory must contain a `CLAUDE.md` as directory memory.

**Workflow:**
- **Start:** Navigate to today's directory. Read `CLAUDE.md` if it exists to restore context. Otherwise, create the directory and seed a fresh `CLAUDE.md`.
- **During:** After each sub-task, update `CLAUDE.md` with status.
- **End:** Record what was accomplished, what remains, and any blockers.

## Reading Upstream Artifacts

When your link depends on previous work:

| Your Link | Read From `{{co_root}}/docs/` |
|-----------|--------------------------------------|
| Execute | `{planner_name}/YYYY-MM-DD/blueprint.md` |
| Verify | `{planner_name}/.../blueprint.md` + `{executor_name}/.../traceability-map.md` |
| Review | Planner + Executor + Verifier artifacts |
| Accept | All four upstream artifacts |

If an upstream artifact is missing, check the chain-shared cache copy provided in your per-task template (`{{upstream_plan_artifact}}` / `{{upstream_execute_artifact}}` / `{{upstream_verify_artifact}}` / `{{upstream_review_artifact}}`). If still not found, report to Leader.

## Your Personal CLAUDE.md

Your role-specific rules are at `{{co_role_path}}/CLAUDE.md`. Read it at the start of every session.

## Git Rules

- Commit after each completed task. One logical unit per commit.
- Commit message ends with your own name signature.
- Never amend published commits. Verify with `git status` before committing.
