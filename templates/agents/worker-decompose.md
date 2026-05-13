Break down the requirement below into a chain of tasks following the Plan → Build → Verify → Review → Accept responsibility chain.

## Step 0: Restore Directory Memory

Read `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` (use today's date) to restore session context. If it doesn't exist, create the directory and seed it with today's date, your name and role. Read your personal CLAUDE.md at `.claude-orchestrator/docs/{{name}}/CLAUDE.md` for role-specific rules.

## Requirement

{{task_description}}

## Instructions

1. Analyze the requirement. Identify how many independent delivery chains are needed.
2. For each chain, define five link tasks. Plan is optional (set to null when the requirement is clear enough to build directly). Build, Verify, Review, and Accept are mandatory.
3. For each task, specify objectively verifiable completion criteria — use concrete commands and expected outputs, not vague descriptions.
4. Assign priority: 0 (urgent), 1 (high), 2 (normal).

## Output

Write the result to {{result_path}}. Also save a copy to `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/chain-def.json`.

```json
{
  "chain_id": "chain-<seq>",
  "chain_title": "<short summary>",
  "tasks": {
    "plan": {"title": "<title>", "description": "<desc>", "criteria": "<verifiable criteria>", "priority": 1} | null,
    "build": {"title": "<title>", "description": "<desc>", "criteria": "<verifiable criteria>", "priority": 1},
    "verify": {"title": "<title>", "description": "<what and how to verify>", "criteria": "<verifiable criteria>", "priority": 1},
    "review": {"title": "<title>", "description": "<what to review>", "criteria": "<verifiable criteria>", "priority": 1},
    "accept": {"title": "<title>", "description": "<what to validate>", "criteria": "<verifiable criteria>", "priority": 1}
  }
}
```

Output ONLY the JSON. No explanation.

## Record

After completion, update `.claude-orchestrator/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` with the chain_id and chain_title.
