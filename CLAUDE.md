# CLAUDE.md

Project-specific instructions. For behavioral guidelines, see global `~/.claude/CLAUDE.md`.

---

## 1. Team Management

This project uses an agent team for development.

### Team Members

| Member | Role | Scope | Prohibited |
|--------|------|-------|------------|
| team-lead | Planning & coordination | Task planning, assignment, verification | No code, no tests |
| product-manager | Product planning | Requirements, priorities, roadmap | No code, no architecture decisions |
| dev-1/2/3 | Developer | Code, scoped tests, commits | No full tests, no .claude/ changes |
| architect | Architecture review | Layer boundaries, design decisions | No code, no style reviews |
| qa-engineer | Quality verification | Scoped tests, boundary checks | No full tests, no code changes |
| tdd-guardian | Test discipline | Run full tests on command, report results | No test standards, no code changes |
| verifier | Sign-off | Verify commits, changes, test coverage | No code, no unverified PASS |
| team-coach | Collaboration discipline | Check compliance, record violations | No code, no task assignment |
| cxo | Chief Experience Officer | Real-world testing, user experience reports | No code fixes, no implementation |

### Team Recovery (New Session)

1. Read all agent definitions from `.claude/agents/`
2. Clean old team config: keep only team-lead in `~/.claude/teams/orch-dev/config.json` members
3. For each member, call Agent tool with `.claude/agents/<role>.md` content (remove YAML frontmatter) as prompt
4. Set `team_name: "orch-dev"`, `mode: "bypassPermissions"`, `run_in_background: true`
5. Wait for all members to come online, then verify rules are loaded

### Key Constraints

- `.claude/agents/*.md` is the only source for agent definitions (content in English)
- When spawning, pass file content directly without translation
- Team config path: `~/.claude/teams/orch-dev/config.json`
- Max 3 developers (dev-1/2/3) to avoid conflicts

### File Access Boundaries (Iron Rules)

| Rule | Description |
|------|-------------|
| **Workspace limit** | All agents except team-lead can only access files within project workspace |
| **No system files** | Cannot access `~/.claude/`, `/tmp/`, or other system directories |
| **No agent inboxes** | Cannot read `~/.claude/teams/orch-dev/inboxes/` |
| **team-lead privilege** | Only team-lead can access team config and agent definition files |

**Project workspace:** `/mnt/c/Users/adama/Documents/projects/claude-orchestrator-server`

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

### team-lead Responsibilities

- Check unfinished logs at session start
- Update daily records at session end
- Ensure all tasks have documentation
- Tasks must be recorded in plans/ before assignment

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
