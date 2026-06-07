# CLAUDE.md

Project-specific instructions. For behavioral guidelines, see global `~/.claude/CLAUDE.md`.

---

## 1. Team Management

This project uses an agent team for development. See [TEAMS.md](TEAMS.md) for complete team structure, workflow, and agent definitions.

### Quick Reference

| Member | Role | Scope |
|--------|------|-------|
| team-lead | Planning & coordination | Task planning, assignment, verification |
| product-manager | Product planning | Requirements, priorities, roadmap |
| dev-1 | Developer | Code, scoped tests, commits |
| dev-2 | Developer | Code, scoped tests, commits |
| dev-3 | Developer | Code, scoped tests, commits |
| code-reviewer | Code review | Code quality, architecture compliance |
| testing-1 | Testing | Scoped tests, boundary checks, regression |
| testing-2 | Testing | Scoped tests, boundary checks, regression |
| testing-3 | Testing | Scoped tests, boundary checks, regression |
| verifier | Sign-off | Verify commits, changes, test coverage |
| architect | Architecture review | Layer boundaries, design decisions |
| cxo | User experience | Real-world UX testing, experience reports |

### Key Constraints

- `.claude/agents/*.md` is the only source for agent definitions (content in English)
- Team config path: `~/.claude/teams/orch-dev/config.json`
- Max 3 developers (dev-1/2/3) to avoid conflicts
- Max 3 testers (testing-1/2/3) to avoid conflicts

---

## 2. Collaboration Rules (Iron Rules)

### 2.1 Testing Discipline (Anti-Test Mud)

**Core principle: Testing is a means, not an end.**

| Rule | Description | Consequence |
|------|-------------|-------------|
| **No full tests** | dev/qa-engineer only run scoped tests: `cd packages/<pkg> && npx vitest run` | Immediate task termination |
| **Full tests need authorization** | Only tdd-guardian can run `pnpm test`, must be explicitly instructed | Unauthorized run = violation |
| **Tests ≠ verification** | Tests passing ≠ correct. Must verify against expected outcomes | verifier won't give unverified PASS |
| **No repeated tests** | Same test run > 3 times in session = mud | team-lead should terminate and replan |

### 2.2 Task Discipline

| Rule | Description |
|------|-------------|
| **Plan before execute** | Tasks must be recorded in `docs/plans/` before assignment |
| **Single responsibility** | Each task does one thing only |
| **Report immediately** | Report commit hash + changed files + test results on completion |
| **Stop when blocked** | Stop immediately and ask team-lead when unclear |
| **No scope creep** | Don't do work outside task scope |

### 2.3 Collaboration Discipline

| Rule | Description |
|------|-------------|
| **Role boundaries** | Each role only does its scope, overstepping = violation |
| **No decision substitution** | dev doesn't make architecture decisions, architect doesn't write code |
| **Evidence chain** | All work must have commit hash as evidence |
| **Sign-off flow** | All developer work must go through verifier sign-off |

### 2.4 team-coach Role (Enforcer, Not Advisor)

team-coach is the enforcer of collaboration discipline:

1. **Check compliance** after each task completion
2. **Record violations** immediately and report to team-lead
3. **Report facts only** (who, when, what violation), no improvement suggestions
4. **Don't define rules** - rules are set by team-lead, team-coach only checks

---

## 3. Work Documentation

See `docs/CLAUDE.md` for detailed standards.

### Core Requirements

| Item | Requirement |
|------|-------------|
| **Log location** | `docs/daily-log/YYYY-MM-DD/work-log.md` |
| **Plan location** | `docs/plans/YYYY-MM-DD/iteration-N-*.md` |
| **Evidence chain** | Each record must include: Task #, Commit, Changed files, Test results, Verification status |
| **Member records** | Each dev/verifier/architect has separate section |
| **Sequential numbering** | iteration-0, iteration-1, iteration-2... no gaps |

### Iteration Plan Format

Every iteration plan MUST have:

1. **Status header** with:
   - `Overall:` in_progress | completed | blocked
   - `Progress:` X/Y tasks completed
   - `Last Updated:` YYYY-MM-DD HH:MM

2. **Checklist** with commit hash tracking:
   - Pending: `- [ ] Task N: description`
   - Completed: `- [x] Task N: description — commit: <hash>`
   - Failed: `- [~] Task N: description — <reason>`

### team-lead Responsibilities

- Check unfinished logs at session start
- Update daily records at session end
- Ensure all tasks have documentation
- Tasks must be recorded in plans/ before assignment
- **Update checklist in iteration plan when tasks complete**
- **Never mark checklist item complete without commit hash**

---

## 4. Compact Instructions (Context Compression)

When context usage exceeds 80%, preserve by priority:

### Must Preserve (Cannot Lose)

1. **Current task status**: All in_progress and pending tasks from TaskList
2. **Team member status**: Who's doing what, recent commit hashes
3. **Key decisions**: Important technical decisions from this iteration
4. **Unfinished work**: Pending task list

### Can Compress

1. **Completed task details**: Keep only commit hash and summary
2. **Test output**: Keep only pass/fail counts
3. **Code review details**: Keep only conclusion (PASS/FAIL)
4. **Log history**: Keep only last 2 days

### Compression Format

```markdown
## Compressed Summary (YYYY-MM-DD)

### Completed (This Round)
- #XX task name — commit: abc1234

### In Progress
- #YY task name — owner: dev-1 — status: in progress

### Pending
- #ZZ task name — priority: high

### Key Decisions
- Decision 1: description
- Decision 2: description

### Team Status
- dev-1: working (Task #YY)
- dev-2: idle
- dev-3: working (Task #ZZ)
```

### Compression Triggers

- Context usage > 80%: compress immediately
- Every 5 tasks completed: check if compression needed
- Session > 30 minutes: check if compression needed
