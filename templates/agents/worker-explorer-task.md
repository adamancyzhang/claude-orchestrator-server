## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Magic Loop Context

- `chain_id`: `{{chain_id}}`
- `chain_depth`: `{{chain_depth}}` (root chains are depth=0; each spawn increments by 1)
- `magic_max_chains`: `{{magic_max_chains}}` (the hard depth cap; `unlimited` means no cap)
- `parent_chain_summary`:

```
{{parent_chain_summary}}
```

If `parent_chain_summary` is empty, this is a root magic chain (depth=0). When `chain_depth + 1 >= magic_max_chains`, ANY `spawn_chain` decision will be silently demoted to `close_chain` by the Leader — pick spawn only when you can also articulate why iterating further is worthwhile within the cap.

## Origin

The user's original requirement is preserved verbatim at `{{original_requirement_path}}`. Cross-check the chain's outputs against this file: did the deliverable address the original intent, or did the chain drift? Drift alone is grounds for a `close_chain` with a clarifying rationale rather than a speculative spawn.

## Upstream Artifacts (read every non-empty one, in order)

1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Executor traceability map: `{{upstream_execute_artifact}}`
3. Verifier verification map: `{{upstream_verify_artifact}}`
4. Reviewer judgment: `{{upstream_review_artifact}}`
5. Accepter acceptance report: `{{upstream_accept_artifact}}`

The Accepter's report (`upstream_accept_artifact`) is the most recent ground truth — start there. The earlier links explain the path the chain took.

If every artifact is empty / missing, write a single-line `BLOCKED: no upstream artifacts` to `result_path` and stop.

## Intent

Decide whether the magic loop should spawn a child chain or terminate.

- **`spawn_chain`** — emit a concrete `next_requirement` that builds directly on what just shipped. Examples: "Add an integration test that exercises the new /api/users endpoint under 5k concurrent connections"; "Migrate the existing customer table to the new schema (no behavior change)"; "Extend the export to support CSV alongside JSON." The Leader will close the current chain, run merge validation, and bootstrap a child chain with `next_requirement` as the new top-level requirement.
- **`close_chain`** — the iteration loop is done. Examples: the chain reached the acceptance criteria with margin, OR the Accepter said NO-GO and additional iteration would not move the deliverable forward (the original requirement is no longer reachable from here).

## Required Output Files

You MUST write your rationale to **exactly** these two paths:

- `result_path` (Leader cache, authoritative):
  `{{result_path}}`
- `local_doc_path` (in-worktree copy):
  `{{local_doc_path}}`

The file structure:

```
# Explorer Result — chain {{chain_id}} (depth {{chain_depth}})

## Chain summary
<one-paragraph recap of plan/execute/verify/review/accept outputs>

## Decision: spawn_chain | close_chain

## Rationale
<two-to-five lines explaining why; reference specific upstream artifact paragraphs>

## Next requirement (if spawn_chain)
<the verbatim next_requirement that will go to the SelfEvaluator JSON; non-empty>
```

The SelfEvaluator that follows will emit the actual `spawn_chain` / `close_chain` decision JSON to its own result path — the body above is its raw input.

Use the **Write** tool for both paths. After writing, use the **Read** tool on `result_path` to confirm the file exists and is non-empty.

## Retry Context

{{retry_hint}}
