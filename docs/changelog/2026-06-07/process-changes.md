# Process Changes — 2026-06-07

## Triggered By
- Retrospective: iteration-8 analysis
- Issues: progress tracking drift, requirement clarity not tracked, dependency workflow unclear

## Changes Made

### Change 1
- **File**: `TEAMS.md`
- **What**: Added explicit rules for updating Status section progress counter in Checklist Tracking Rules
- **Why**: Iteration-8 plan showed "6/8 tasks completed" in Status but only 4 tasks were marked `[x]` in the checklist. The existing rules said "Update Status section after each change" but didn't specify how or when to increment/decrement the counter.
- **Expected effect**: Progress counter stays in sync with actual checklist state. Team-lead must update counter on every checklist change.

### Change 2
- **File**: `TEAMS.md`
- **What**: Added Requirement Clarity Tracking section under Task Execution Flow
- **Why**: Dev agents already report requirement clarity (1-5) on every task, but team-lead had no instructions to aggregate or act on these scores. Low clarity was causing rework that went untracked.
- **Expected effect**: team-lead aggregates clarity scores in iteration reports. Average clarity < 3 triggers retrospective flag and clarification request.

### Change 3
- **File**: `TEAMS.md`
- **What**: Added Dependency Management section under Decision Making
- **Why**: Iteration-8 had Tasks 2-5 dependent on Task 1, but no clear process for unblocking tasks when dependencies complete. team-lead had to manually track which tasks were unblocked.
- **Expected effect**: When a dependency completes, team-lead immediately checks and assigns unblocked tasks. Failed dependency tasks get marked BLOCKED in checklist.

## Not Changed (with reasoning)
- `docs/CLAUDE.md`: No changes needed. The iteration plan template and dev report format there are structural definitions, not workflow rules. The workflow rules belong in TEAMS.md.
- `.claude/agents/dev.md`: Already has requirement clarity feedback. No change needed.
- `.claude/agents/team-lead.md`: Not modified because the changes are in TEAMS.md which team-lead reads.
