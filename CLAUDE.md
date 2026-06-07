# CLAUDE.md

Project-specific instructions. For behavioral guidelines, see global `~/.claude/CLAUDE.md`.

---

## 1. Team Management

This project uses an agent team for development. See [TEAMS.md](TEAMS.md) for complete team structure, workflow, agent definitions, and checklist tracking rules.

### Key Constraints

- `.claude/agents/*.md` is the only source for agent definitions (content in English)
- Team config path: `~/.claude/teams/orch-dev/config.json`
- Max 3 developers (dev-1/2/3) to avoid conflicts
- Max 3 testers (testing-1/2/3) to avoid conflicts
- Max 1 retrospective-analyst (single point of analysis)
- Max 1 process-engineer (single point of process change)
- After all tasks PASS, team-lead MUST trigger retrospective-analyst → process-engineer loop
- process-engineer can ONLY modify `.claude/agents/`, `TEAMS.md`, `CLAUDE.md`, `docs/CLAUDE.md`

---

## 2. Collaboration Rules (Iron Rules)

### 2.1 Testing Discipline

**Core principle: Testing is a means, not an end.**

| Rule | Description |
|------|-------------|
| **No full tests** | dev/testing only run scoped tests: `cd packages/<pkg> && npx vitest run` |
| **Tests ≠ verification** | Tests passing ≠ correct. Must verify against expected outcomes |
| **No repeated tests** | Same test run > 3 times in session = waste |

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
