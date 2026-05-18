---
name: task-exploration
description: Magic-loop terminator. Use when a chain reaches the explore link (only present under `--magic`) and the Explorer must decide between `spawn_chain` (open a follow-up chain with a concrete `next_requirement`) and `close_chain` (terminate the autonomous loop). Triggers on keywords like "explore link", "spawn_chain", "magic loop", "next iteration", "autonomous follow-up". The skill enforces evidence-traced reasoning over speculation and respects the `--magic-max-chains` depth cap.
---

# Task Exploration

> Exploration is not brainstorming. Every spawn must trace to evidence in the just-completed chain — never invent next steps the upstream artifacts do not support. This skill works alongside [[task-traceability]] so each spawn/close decision is auditable.

---

## When to trigger

- The orchestrator runs with `--magic` and the chain reached the **explore** link.
- The previous five links (plan / execute / verify / review / accept) all produced result.md files in `<cache>/tasks/<task_id>/`.
- The Leader dispatches an `explore` task with `chain_id`, `chain_depth`, and `magic_max_chains` populated.
- (Re-entry case) A previous explore task was re-dispatched as feedback; re-read the prior `exploration-report.md` to avoid contradicting yourself.

---

## Six-step process (Trace → Survey → Map → Evidence → Record → Decide)

Execute in order. Each step must pass before continuing; a failure at any step short-circuits to `close_chain` with a rationale (never silently to `spawn_chain`).

### 1. Trace — read every non-empty upstream artifact

Read in order:

1. `{{upstream_plan_artifact}}` (skip if null)
2. `{{upstream_execute_artifact}}`
3. `{{upstream_verify_artifact}}`
4. `{{upstream_review_artifact}}`
5. `{{upstream_accept_artifact}}` — this is the most recent ground truth; start with the GO/NO-GO line.

If every artifact is empty or missing → write `BLOCKED: no upstream artifacts` to `result_path` and stop. The SelfEvaluator's fallback will emit `reject`.

### 2. Survey — read the cross-chain context

- Read the original requirement at `{{original_requirement_path}}`. Look for chain drift: did the chain ship something materially different from what was asked?
- If `parent_chain_summary` is non-empty (`chain_depth > 0`), read it. Note the parent's accept result so you don't recommend reverting the parent's own work.
- Compare `chain_depth + 1` against `magic_max_chains`:
  - `magic_max_chains` is `unlimited` → no cap; freely consider spawn.
  - `chain_depth + 1 >= magic_max_chains` → the Leader will demote any spawn to close. Prefer `close_chain` with a clarifying note over a wasted spawn.

### 3. Map — write the one-paragraph chain summary

A single paragraph (3–5 sentences) recapping:

- What the chain set out to do (from the original requirement).
- What it actually shipped (from the accept report).
- Where it diverged from plan, if at all (from the executor traceability map + verifier verification map).

This paragraph goes into `result.md` as the "Chain summary" section.

### 4. Evidence — anchor every claim to an upstream artifact

For each finding you raise:

```
- <finding>  ← `path/to/upstream_artifact.md` §<section> "<quoted phrase>"
```

If you cannot cite the upstream artifact, the finding is speculation — drop it.

### 5. Record — write the rationale + decision-prefix to `result_path`

The body must match the template:

```
# Explorer Result — chain {{chain_id}} (depth {{chain_depth}})

## Chain summary
<one paragraph from step 3>

## Decision: spawn_chain | close_chain

## Rationale
<two to five lines; each claim carries an evidence anchor from step 4>

## Next requirement (if spawn_chain)
<verbatim next_requirement; non-empty>
```

Write to both `{{result_path}}` (Leader cache, authoritative) and `{{local_doc_path}}` (in-worktree copy for parity with other links). Then `Read` `result_path` to confirm the file is non-empty.

### 6. Decide — emit one EvalDecision

Pass the rationale to the SelfEvaluator. It emits ONE of:

- **`spawn_chain`** — `next_requirement` is non-empty, traces to evidence, and is decomposable into a full P→E→V→R→A→Explore chain. Cap-aware: only emit this when `chain_depth + 1 < magic_max_chains` (or when `magic_max_chains` is unlimited).
- **`close_chain`** — the project is done, OR the cap is hit, OR you cannot articulate a concrete next step in one sentence.
- (Rare) **`feedback`** — route a retry back to the Accepter. Use only when the Accepter's output itself is questionable.
- (Rare) **`reject`** — fundamental failure that cannot be retried.

`activate_next` is **illegal** at the explore link (no link follows). The Leader audits any such emission as `invalid_decision` and aborts the chain.

---

## Tone & calibration

- Optimism bias is the failure mode. Default toward `close_chain` unless the next step is obvious.
- Length budget: `next_requirement` is one or two sentences; longer = the decompose template will struggle to split it.
- "We could also add tests" is not a next requirement; "Add an integration test that exercises the new endpoint under 5k concurrent connections" is.

---

## Cross-skill collaboration

- **task-traceability** — every claim's evidence anchor follows the traceability map convention.
- **task-acceptance** — the Accepter's GO/NO-GO line is your primary input; treat it as authoritative unless the upstream verify/review artifacts contradict it.
