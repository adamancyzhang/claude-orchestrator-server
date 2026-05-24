## Task to Execute

**Title**: {{task_title}}
**Description**: {{task_description}}
**Acceptance Criteria**: {{task_criteria}}

## Magic Loop Context
- **Chain**: `{{chain_id}}`
- **Depth**: {{chain_depth}} / {{magic_max_chains}}
- **Parent summary**: {{parent_chain_summary}} (`null` for root chains)

## Origin
The user's original requirement is at `{{original_requirement_path}}`. Read it to detect chain drift — has this iteration loop stayed on target?

## Upstream Artifacts (read first, in order)
1. Planner blueprint: `{{upstream_plan_artifact}}`
2. Executor traceability map: `{{upstream_execute_artifact}}`
3. Verifier verification map: `{{upstream_verify_artifact}}`
4. Reviewer judgment: `{{upstream_review_artifact}}`
5. Accepter acceptance report: `{{upstream_accept_artifact}}`

Read all that are non-empty. If everything is empty, write a single-line BLOCKED report to `result_path` and stop.

## Intent
Survey the completed chain. Decide: **spawn_chain** (next iteration with `next_requirement`) or **close_chain** (done). Use feedback/reject only for genuine upstream failures. Cite evidence from upstream artifacts. Do not spawn when `chain_depth + 1 >= magic_max_chains`.

## Required Output Files

- `result_path`: `{{result_path}}`
- `local_doc_path`: `{{local_doc_path}}`

After writing, use the **Read** tool on `result_path` to confirm.

{{retry_hint}}
