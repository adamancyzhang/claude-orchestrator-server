---
name: orchestrator-help
description: Request help from other instances in the orchestrator when blocked, uncertain, or needing review. Use when stuck on a task, encountering an unfamiliar area of code, needing architectural input, or when the user says "ask for help", "request review", "broadcast question", or "求助".
---

# Request Help from Orchestrator

When you're blocked or need input from other instances, broadcast a help request to the entire orchestrator.

## When to Use

- You encounter an error you can't resolve after 2-3 attempts
- You need domain knowledge about a part of the codebase you haven't worked on
- You need architectural validation before making a significant change
- Another instance has relevant expertise (check their declared role via `claude-orchestrator list-instances`)
- You're asked to review someone else's code and need context

## Steps

### 1. Gather context

Before asking for help, collect:
- What you're trying to accomplish
- The exact error message or blocker
- What you've already tried (so others don't suggest the same)
- Relevant file paths and line numbers
- Any relevant shared context from `claude-orchestrator get-context --key <key>`

### 2. Formulate the question

Write a clear, specific question. The more context you provide, the faster you'll get a useful response.

Format:
```
Question: [one-line summary of what you need]

What I'm trying to do:
[1-2 sentences]

What's blocking me:
[specific error, uncertainty, or decision point]

What I've tried:
[list approaches you've already attempted]

Relevant files:
- path/to/file.py:123
```

### 3. Broadcast the help request

```bash
claude-orchestrator request-help --question "<formatted question>" --context "<additional context>"
```

The `--context` flag is optional — use it for code snippets, stack traces, or logs.

### 4. Wait for responses

Run `claude-orchestrator poll-messages` to check for replies. Poll periodically until you get a useful response.

### 5. Process responses

- When you receive a reply, acknowledge it with `claude-orchestrator send-message --to <responder> --content "Thanks, that helped. ..."`
- If the response resolves your issue, proceed with the task.
- If unclear, ask a follow-up question (direct message to the responder).
- If multiple instances respond, synthesize the advice and proceed.

## Responding to Help Requests

When you receive a help request (via `claude-orchestrator poll-messages`, type=help):

1. If you have relevant expertise, respond via `claude-orchestrator send-message` directly to the requesting instance.
2. Be specific — reference file paths, suggest concrete changes.
3. If you don't know, stay silent. Don't clutter the channel.
4. If the question is about code, reference line numbers from actual files.

## Shared Context for Common Knowledge

Before asking a question that others might also have, check `claude-orchestrator get-context --key <key>`. If you discover an answer that others might need, call `claude-orchestrator set-context --key <key> --value <value>` to share it persistently.
