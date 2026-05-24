Break down the requirement below into a chain of tasks following the Plan → Execute → Verify → Review → Accept responsibility chain.

## Step 0: Restore Directory Memory

Read `{{co_root}}/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` (use today's date) to restore session context. If it doesn't exist, create the directory and seed it with today's date, your name and role. Read your personal CLAUDE.md at `{{co_root}}/docs/{{name}}/CLAUDE.md` for role-specific rules.

## Requirement

{{task_description}}

## Magic Mode Context

- `magic_mode`: **{{magic_mode}}**
- `magic_max_chains`: **{{magic_max_chains}}**

When `magic_mode=true`, the chain runs under `--magic`: every chain MUST include a sixth `explore` task whose Explorer worker decides whether to spawn a follow-up chain (`spawn_chain` with `next_requirement`) or terminate the magic loop (`close_chain`).

When `magic_mode=false`, the chain MUST NOT include an `explore` task.

## Instructions

1. Analyze the requirement. Identify how many independent delivery chains are needed.
2. For each chain, define the link tasks:
   - **Plan** is optional (set to null when the requirement is clear enough to execute directly).
   - **Execute**, **Verify**, **Review**, **Accept** are mandatory.
   - **Explore** is mandatory iff `magic_mode=true` (else: omit).
3. For each task, specify objectively verifiable completion criteria — use concrete commands and expected outputs, not vague descriptions.
4. Assign priority: 0 (urgent), 1 (high), 2 (normal).
5. For Explore (magic mode only): the description should instruct the Explorer to review the full chain (plan/execute/verify/review/accept results) plus the parent chain summary, and decide between `spawn_chain` (carry a concrete `next_requirement`) or `close_chain` (terminate the magic loop).

## Output

Write the result to {{result_path}}. Also save a copy to `{{co_root}}/docs/{{name}}/YYYY-MM-DD/chain-def.json`.

```json
// magic_mode=false (default — no explore task)
{
  "chain_id": "chain-<seq>",
  "chain_title": "<short summary>",
  "tasks": {
    "plan": {"title": "<title>", "description": "<desc>", "criteria": "<verifiable criteria>", "priority": 1} | null,
    "execute": {"title": "<title>", "description": "<desc>", "criteria": "<verifiable criteria>", "priority": 1},
    "verify": {"title": "<title>", "description": "<what and how to verify>", "criteria": "<verifiable criteria>", "priority": 1},
    "review": {"title": "<title>", "description": "<what to review>", "criteria": "<verifiable criteria>", "priority": 1},
    "accept": {"title": "<title>", "description": "<what to validate>", "criteria": "<verifiable criteria>", "priority": 1}
  }
}

// magic_mode=true — include explore as the 6th task
{
  "chain_id": "chain-<seq>",
  "chain_title": "<short summary>",
  "tasks": {
    "plan": {...} | null,
    "execute": {...},
    "verify": {...},
    "review": {...},
    "accept": {...},
    "explore": {
      "title": "Explore: decide spawn vs close",
      "description": "Review the full chain context (plan/execute/verify/review/accept results) and the parent chain summary (if any). If a meaningful follow-up exists within --magic-max-chains, output spawn_chain with a concrete next_requirement; otherwise output close_chain to terminate the magic loop.",
      "criteria": "result.md contains either spawn_chain{next_requirement:<non-empty>} or close_chain with a one-line rationale",
      "priority": 1
    }
  }
}
```

Output ONLY the JSON for the active mode. No explanation.

## Record

After completion, update `{{co_root}}/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` with the chain_id and chain_title.
