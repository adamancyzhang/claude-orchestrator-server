You just completed a task in the Plan → Execute → Verify → Review → Accept responsibility chain. Evaluate your own output and decide the next action.

## Task Context

- **Link**: {{link}}
- **Title**: {{task_title}}
- **Description**: {{task_description}}
- **Criteria**: {{task_criteria}}

## Your Result

Review your work at {{task_result_path}}.

## Directory Memory Check

Before evaluating, verify:
1. Does `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/` contain the expected artifact for your link?
   - plan → `blueprint.md`
   - execute → `traceability-map.md` + `evidence/`
   - verify → `verification-map.md` + `evidence/`
   - review → `review-judgment.md`
   - accept → `acceptance-report.md`
   - explore → `result.md` (Explorer's spawn-or-close decision rationale; magic mode only)
2. Has `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` been updated?
3. For verify/review/accept: did you successfully read upstream artifacts from `.claude-orchestrator/docs/`?

## Decision Rules

1. **Criteria fully met** AND output artifacts are in place → `activate_next`
2. **Criteria partially met** OR artifacts missing from docs → `feedback` (describe what's missing)
3. **Criteria not met** → `feedback` with clear explanation
4. **Fundamental failure** (implementation diverges from blueprint, restart required) → `reject`
5. **Accept link passes**: in default mode → `close_chain`; in magic mode → `activate_next` (next_link=explore)
6. **Explore link (magic mode only)**: emit `spawn_chain` with `next_requirement` to derive a child chain, or `close_chain` to terminate the magic loop. `activate_next` is illegal at explore (the chain has no further link).

For verify/review/accept: if upstream artifacts were missing from `.claude-orchestrator/docs/` → `feedback` specifying which artifacts and from which Worker.

## Output

Output exactly one JSON. Write to {{result_path}}.

Use **snake_case** field names exactly as listed. The schema is a discriminated union on `decision`; only emit the fields for the selected branch.

```json
// decision: "activate_next" — proceed to the next link
{
  "decision": "activate_next",
  "reason": "<one-line explanation>",
  "next_link": "execute" | "verify" | "review" | "accept" | "explore",
  "suggested_worker": null
}

// decision: "feedback" — caller (Leader) routes the message to feedback_target
{
  "decision": "feedback",
  "reason": "<one-line explanation>",
  "feedback_to_worker": "<what to improve or which artifact is missing>",
  "feedback_target": null
}

// decision: "reject" — fundamental failure, no auto-retry
{
  "decision": "reject",
  "reason": "<one-line explanation>"
}

// decision: "close_chain" — accept passed (or chain consciously aborted)
{
  "decision": "close_chain",
  "reason": "<one-line explanation>"
}

// decision: "spawn_chain" — explore link only, magic mode only.
// Closes the current chain and bootstraps a child chain with `next_requirement`
// as the new user requirement. Subject to --magic-max-chains cap.
{
  "decision": "spawn_chain",
  "reason": "<one-line explanation>",
  "next_requirement": "<concrete next-iteration requirement, non-empty>"
}
```

Output ONLY the JSON for the selected branch. No explanation, no markdown fences.
