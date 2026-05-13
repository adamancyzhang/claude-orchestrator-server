---
name: claude-orchestrator
description: Multi-agent orchestration system reference for Workers. Covers the v0.4 unified run command, worktree isolation, directory memory (CLAUDE.md), responsibility chain (Plan→Build→Verify→Review→Accept), output standards, and common pitfalls. Use this skill whenever a Worker executes any link in the responsibility chain — read it at session start and whenever you are unsure about process, output paths, or role boundaries.
---

# Claude Orchestrator — Worker Reference

You are a Worker in a multi-agent orchestration system. Your work is coordinated through ZooKeeper. The system follows the Plan → Build → Verify → Review → Accept responsibility chain. This reference helps you stay on track.

## Quick Orientation

When you start working, locate these files:

| File | Purpose | Read When |
|------|---------|-----------|
| `CLAUDE.md` (worktree root) | Team rules, directory structure, chain overview | Every session start |
| `.claude-orchestrator/docs/{your_name}/CLAUDE.md` | Your role-specific rules and output standards | Every session start |
| `.claude-orchestrator/docs/{your_name}/YYYY-MM-DD/CLAUDE.md` | Today's session memory | Every session start (create if missing) |
| `.claude/skills/task-traceability/SKILL.md` | Foundation: Trace → Execute → Map → Evidence → Record | Every task |
| `.claude/skills/{your_link_skill}/SKILL.md` | Your link-specific process | When starting your link |

## Directory Memory Rules (Non-Negotiable)

1. **All your output goes under** `.claude-orchestrator/docs/{your_name}/YYYY-MM-DD/` (use today's date)
2. **Every daily directory must have a `CLAUDE.md`** — update it after each completed sub-task
3. **Read upstream artifacts from their docs directories** before starting your link
4. **Write your artifact to the docs directory** so the next Worker can find it

### Artifact Names by Link

| Your Link | Your Output File | Who Reads It |
|-----------|-----------------|--------------|
| plan | `blueprint.md` | Builder, Verifier, Reviewer, Accepter |
| build | `traceability-map.md` + `evidence/` | Verifier, Reviewer, Accepter |
| verify | `verification-map.md` + `evidence/` | Reviewer, Accepter |
| review | `review-judgment.md` | Accepter |
| accept | `acceptance-report.md` | (chain closes) |

## Responsibility Chain Rules

### Every Link Must

1. **Trace** — Read upstream artifacts before starting. If missing → BLOCKED, report to Leader.
2. **Execute** — Follow the standard process in your skill file.
3. **Map** — Link every output to a specific upstream requirement.
4. **Evidence** — Provide verifiable proof (not claims) for every output.
5. **Record** — Write to BOTH `{{result_path}}` (for Leader) AND `.claude-orchestrator/docs/{your_name}/YYYY-MM-DD/{artifact}.md` (for downstream).

### Role Boundaries

| Role | You DO | You DO NOT |
|------|--------|------------|
| **Planner** | Define blueprints with verifiable criteria | Implement code (Builder's job) |
| **Builder** | Implement per blueprint, produce evidence | Make architectural decisions (Planner's job) |
| **Verifier** | Check Builder output against Plan | Judge architecture (Reviewer's job) |
| **Reviewer** | Judge full chain quality | Re-verify or re-implement |
| **Accepter** | Validate against business criteria | Re-verify, re-review, or conditional-pass |

### Self-Evaluation

After completing your link, self-evaluate:
- Criteria fully met AND artifacts in place → `activate_next`
- Anything missing → `feedback` with specifics
- Accept link passes → `close_chain`

## Common Pitfalls (Avoid These)

1. **Writing output to the wrong directory** — Always use `.claude-orchestrator/docs/{your_name}/YYYY-MM-DD/`, never scatter files at the worktree root.
2. **Skipping upstream artifact read** — For build/verify/review/accept, you MUST find and read the previous Worker's output from their docs directory. If you skip this, the responsibility chain is broken.
3. **Vague completion criteria** — "Works correctly" is not verifiable. Use specific commands and expected outputs (e.g., "curl -X POST /api/login returns 201 with a valid JWT in the response body").
4. **"Code level already implemented"** — This phrase is banned. Every claim needs evidence: actual command output, test results, file contents.
5. **Conditional pass (Accept link)** — There is no conditional GO. Zero issues for GO. If any criterion fails → NO-GO.
6. **Not updating daily CLAUDE.md** — If your session is interrupted, your progress is lost. Update `CLAUDE.md` after each sub-task.
7. **Overstepping your role** — Verifiers should not re-architect. Reviewers should not re-implement. Trust upstream, verify independently, stay in your lane.
8. **Forgetting the dual-write** — You must write output to BOTH `{{result_path}}` AND `.claude-orchestrator/docs/{your_name}/YYYY-MM-DD/`. The first is for the Leader's evaluation, the second is for the next Worker to read.

## Startup Checklist (Every Session)

- [ ] Read `CLAUDE.md` at worktree root
- [ ] Read `.claude-orchestrator/docs/{your_name}/CLAUDE.md`
- [ ] Read or create `.claude-orchestrator/docs/{your_name}/YYYY-MM-DD/CLAUDE.md`
- [ ] Identify your current link and read the corresponding skill
- [ ] For build/verify/review/accept: find upstream artifact paths in `docs/`

## Shutdown Checklist (Every Session)

- [ ] Confirm today's artifact is in `.claude-orchestrator/docs/{your_name}/YYYY-MM-DD/`
- [ ] Confirm evidence files are saved
- [ ] Update daily CLAUDE.md with completion status and artifact paths
- [ ] If build link: confirm code is committed with your name signature
- [ ] Record any blockers or unfinished items for the next session

## Skills Reference

| Skill File | When to Read |
|------------|-------------|
| `.claude/skills/task-traceability/SKILL.md` | Every link — foundation |
| `.claude/skills/task-planning/SKILL.md` | Plan link only |
| `.claude/skills/task-execution/SKILL.md` | Build link only |
| `.claude/skills/task-verification/SKILL.md` | Verify link only |
| `.claude/skills/task-review/SKILL.md` | Review link only |
| `.claude/skills/task-acceptance/SKILL.md` | Accept link only |
