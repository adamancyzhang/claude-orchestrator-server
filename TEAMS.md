# TEAMS.md

Team management patterns for the orch-dev team. Referenced by CLAUDE.md.

---

## 1. Team Structure

| Member | Role | Scope | Prohibited |
|--------|------|-------|------------|
| team-lead | Planning & coordination | Task planning, assignment, verification, improvement loop | No code, no tests |
| product-manager | Product planning | Requirements, priorities, roadmap | No code, no architecture decisions |
| dev-1 | Developer | Code, scoped tests, commits, feedback | No full tests, no .claude/ changes |
| dev-2 | Developer | Code, scoped tests, commits, feedback | No full tests, no .claude/ changes |
| dev-3 | Developer | Code, scoped tests, commits, feedback | No full tests, no .claude/ changes |
| code-reviewer | Code review | Code quality, architecture compliance | No code changes, no style nitpicks |
| testing-1 | Testing | Scoped tests, boundary checks, regression | No code changes |
| testing-2 | Testing | Scoped tests, boundary checks, regression | No code changes |
| testing-3 | Testing | Scoped tests, boundary checks, regression | No code changes |
| verifier | Sign-off | Verify commits, changes, test coverage | No code, no unverified PASS |
| architect | Architecture review | Layer boundaries, design decisions | No code, no style reviews |
| cxo | User experience | Real-world UX testing, experience reports | No code fixes, no implementation |
| retrospective-analyst | Retrospective | Iteration analysis, improvement suggestions | No code, no file changes |
| process-engineer | Process improvement | Agent definitions, workflow docs | No packages/ code, no templates/ |

---

## 2. Team Lead Workflow

### Session Start
1. Read all agent definitions from `.claude/agents/`
2. Clean old team config: keep only team-lead in `~/.claude/teams/orch-dev/config.json` members
3. For each member, call Agent tool with `.claude/agents/<role>.md` content (remove YAML frontmatter) as prompt
4. Set `team_name: "orch-dev"`, `mode: "bypassPermissions"`, `run_in_background: true`
5. Wait for all members to come online, then verify rules are loaded

### Task Execution Flow
1. Receive user request → break down into tasks
2. Read `docs/retrospective/` for latest retrospective report
3. Create iteration plan with checklist in `docs/plans/YYYY-MM-DD/iteration-N-*.md`
4. Create tasks with TaskCreate (clear title, description, acceptance criteria)
5. Assign tasks to appropriate teammates via TaskUpdate (set owner)
6. Send task instructions via SendMessage (reference task ID)
7. Wait for teammate reports → review results
8. Update checklist with commit hash when task completes
9. If issues found → create fix tasks and reassign
10. When all tasks pass → **trigger post-iteration improvement loop**

### Post-Iteration Improvement Loop
1. Call retrospective-analyst to produce a retrospective report
2. Read the retrospective report
3. If HIGH/MEDIUM priority improvements exist:
   - Call process-engineer to implement improvements
   - Wait for process-engineer report
4. Report to user: iteration summary + retrospective highlights + improvements applied

### Iteration Plan Format

Every iteration plan MUST have:

```markdown
# Iteration N - Title — YYYY-MM-DD

## Status
- **Overall:** in_progress | completed | blocked
- **Progress:** X/Y tasks completed
- **Last Updated:** YYYY-MM-DD HH:MM

## Goals
Description of iteration goals.

## Checklist
- [ ] Task 1: description
- [ ] Task 2: description
- [ ] Task 3: description

## Detailed Design
Task details...
```

### Checklist Tracking Rules
- Each task starts as `- [ ] Task N: description`
- When dev reports completion: `- [x] Task N: description — commit: <hash>`
- When verification fails: `- [~] Task N: description — NEEDS_WORK: <reason>`
- Update `Status` section after each change
- Never mark complete without commit hash evidence

### Task Assignment Rules

| Task Type | Assign To |
|-----------|-----------|
| Code implementation | dev-1, dev-2, or dev-3 |
| Code review | code-reviewer |
| Architecture review | architect |
| Testing | testing-1, testing-2, or testing-3 |
| Final sign-off | verifier |
| Requirements | product-manager |
| UX testing | cxo |
| Retrospective | retrospective-analyst |
| Process improvement | process-engineer |

### Decision Making
- architect reports issues → create fix tasks for the responsible dev
- code-reviewer reports issues → create fix tasks for the responsible dev
- testing reports failures → create fix tasks, re-run verification
- verifier gives NEEDS_WORK → create fix tasks, re-submit for sign-off
- verifier gives PASS → mark task complete, report to user

### Report Format to User
When reporting progress:
1. Current checklist status (how many done, how many remaining)
2. List of completed items with commit hashes
3. List of pending/blocked items with reasons

When reporting iteration completion:
1. All checklist items with commit hashes
2. Retrospective summary (data + key findings)
3. Improvements applied (if any)

---

## 3. Agent Definitions

All agent definitions are in `.claude/agents/`:

| File | Role |
|------|------|
| team-lead.md | Planning and coordination |
| dev.md | Developer (dev-1, dev-2, dev-3) |
| code-reviewer.md | Code review |
| testing.md | Testing (testing-1, testing-2, testing-3) |
| verifier.md | Final sign-off |
| architect.md | Architecture review |
| cxo.md | User experience |
| product-manager.md | Product planning |
| retrospective-analyst.md | Iteration analysis |
| process-engineer.md | Process improvement |

---

## 4. Prohibited Actions

- team-lead: No code, no tests, no source file modification
- dev: No full test suite, no .claude/ modification
- code-reviewer: No code changes, no style nitpicks
- testing: No code changes
- verifier: No code, no unverified PASS
- architect: No code, no style reviews
- cxo: No code fixes, no implementation
- product-manager: No code, no architecture decisions
- retrospective-analyst: No code, no file changes
- process-engineer: No packages/ code, no templates/ changes

---

## 5. File Access Boundaries

| Rule | Description |
|------|-------------|
| **Workspace limit** | All agents except team-lead can only access files within project workspace |
| **No system files** | Cannot access `~/.claude/`, `/tmp/`, or other system directories |
| **No agent inboxes** | Cannot read `~/.claude/teams/orch-dev/inboxes/` |
| **team-lead privilege** | Only team-lead can access team config and agent definition files |
| **process-engineer scope** | Can only modify `.claude/agents/`, `TEAMS.md`, `CLAUDE.md`, `docs/CLAUDE.md` |

**Project workspace:** `/mnt/c/Users/adama/Documents/projects/claude-orchestrator-server`

---

## 6. Self-Improvement Loop

The team has a built-in self-improvement mechanism:

```
User Request
    │
    ▼
team-lead → iteration execution → verifier PASS (all tasks)
    │
    ▼
retrospective-analyst → docs/retrospective/YYYY-MM-DD/iteration-N-retro.md
    │
    ▼ (if HIGH/MEDIUM improvements)
process-engineer → modified .claude/agents/* or TEAMS.md or CLAUDE.md
    │
    ▼
Next iteration uses improved configuration
```

### What Can Be Improved

| Target | What changes | Who changes it |
|--------|-------------|----------------|
| `.claude/agents/*.md` | Agent workflow, report format, rules | process-engineer |
| `TEAMS.md` | Assignment rules, workflow steps | process-engineer |
| `CLAUDE.md` | Collaboration rules, constraints | process-engineer |
| `packages/` | Business code, features | dev (via normal task flow) |
| `templates/agents/` | Runtime worker templates | dev (via normal task flow) |

### What Cannot Self-Improve

- The retrospective-analyst's own analysis methodology (would need a meta-retrospective)
- The process-engineer's change criteria (would need a meta-process-engineer)
- The team-lead's decision-making rules (controlled by human)

These are intentionally bounded — the human retains control over the meta-level.
