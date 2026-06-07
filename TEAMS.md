# TEAMS.md

Team management patterns for the orch-dev team. Referenced by CLAUDE.md.

---

## 1. Team Structure

| Member | Role | Scope | Prohibited |
|--------|------|-------|------------|
| team-lead | Planning & coordination | Task planning, assignment, verification | No code, no tests |
| product-manager | Product planning | Requirements, priorities, roadmap | No code, no architecture decisions |
| dev-1 | Developer | Code, scoped tests, commits | No full tests, no .claude/ changes |
| dev-2 | Developer | Code, scoped tests, commits | No full tests, no .claude/ changes |
| dev-3 | Developer | Code, scoped tests, commits | No full tests, no .claude/ changes |
| code-reviewer | Code review | Code quality, architecture compliance | No code changes, no style nitpicks |
| testing-1 | Testing | Scoped tests, boundary checks, regression | No code changes |
| testing-2 | Testing | Scoped tests, boundary checks, regression | No code changes |
| testing-3 | Testing | Scoped tests, boundary checks, regression | No code changes |
| verifier | Sign-off | Verify commits, changes, test coverage | No code, no unverified PASS |
| architect | Architecture review | Layer boundaries, design decisions | No code, no style reviews |
| cxo | User experience | Real-world UX testing, experience reports | No code fixes, no implementation |
| product-manager | Product planning | Requirements, priorities, roadmap | No code, no architecture decisions |

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
2. Create iteration plan with checklist in `docs/plans/YYYY-MM-DD/iteration-N-*.md`
3. Create tasks with TaskCreate (clear title, description, acceptance criteria)
4. Assign tasks to appropriate teammates via TaskUpdate (set owner)
5. Send task instructions via SendMessage (reference task ID)
6. Wait for teammate reports → review results
7. Update checklist with commit hash when task completes
8. If issues found → create fix tasks and reassign
9. When all tasks pass → report completion to user

### Iteration Plan Format

Every iteration plan MUST have:

```markdown
# Iteration N - Title — YYYY-MM-DD

## Status
- **Overall:** in_progress | completed | blocked
- **Progress:** X/Y tasks completed
- **Last Updated:** YYYY-MM-DD HH:MM

## 目标
Description of iteration goals.

## Checklist

- [ ] Task 1: description
- [ ] Task 2: description
- [ ] Task 3: description

## 详细设计
Task details...
```

### Checklist Tracking Rules
- Each task starts as `- [ ] Task N: description`
- When dev reports completion: `- [x] Task N: description — commit: <hash>`
- When verification fails: `- [~] Task N: description — NEEDS_WORK: <reason>` (then fix and update)
- Update `Status` section header after each change
- Never mark complete without commit hash evidence

### Task Assignment Rules
- Dev tasks → dev-1, dev-2, or dev-3 (max 3 developers to avoid conflicts)
- Code review → code-reviewer
- Testing tasks → testing-1, testing-2, or testing-3
- Architecture review → architect
- Final sign-off → verifier
- Product requirements → product-manager
- User experience testing → cxo

### Decision Making
- When architect reports issues → create fix tasks for the responsible dev
- When code-reviewer reports issues → create fix tasks for the responsible dev
- When testing reports failures → create fix tasks, re-run verification
- When verifier gives NEEDS_WORK → create fix tasks, re-submit for sign-off
- When verifier gives PASS → mark task complete, report to user

### Report Format to User
When reporting progress, always include:
1. Current checklist status (how many done, how many remaining)
2. List of completed items with commit hashes
3. List of pending/blocked items with reasons

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

---

## 5. File Access Boundaries

| Rule | Description |
|------|-------------|
| **Workspace limit** | All agents except team-lead can only access files within project workspace |
| **No system files** | Cannot access `~/.claude/`, `/tmp/`, or other system directories |
| **No agent inboxes** | Cannot read `~/.claude/teams/orch-dev/inboxes/` |
| **team-lead privilege** | Only team-lead can access team config and agent definition files |

**Project workspace:** `/mnt/c/Users/adama/Documents/projects/claude-orchestrator-server`
