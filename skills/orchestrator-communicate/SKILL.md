---
name: orchestrator-communicate
description: Send messages to and check messages from other instances in the orchestrator. Use when needing to coordinate, share findings, ask questions, make announcements, or when the user says "message", "send to", "broadcast", "check messages", "联络", or "通知".
---

# Orchestrator Communication

Send and receive messages with other instances in the orchestrator.

## Check for Messages

```bash
claude-orchestrator poll-messages
```

If messages are returned, process each by type:

| Type | Meaning | Action |
|------|---------|--------|
| `direct` | Private message to you | Read and respond if needed |
| `broadcast` | Announcement to all | Acknowledge, act if relevant |
| `help` | Help request from another instance | Respond if you have expertise |

Messages are automatically marked as read when polled. The sender will know you've seen them.

## Send a Direct Message

```bash
claude-orchestrator send-message --to <instance-id> --content "<message>"
```

Find target instance IDs via `claude-orchestrator list-instances`.

Use direct messages for:
- Asking a specific instance a question
- Coordinating on overlapping tasks
- Sharing findings relevant to another instance's current task
- Responding to a help request

## Broadcast to All Instances

```bash
claude-orchestrator send-message --broadcast --content "<message>"
```

Use broadcast for:
- Announcing a completed milestone
- Sharing a discovery that affects everyone
- Proposing a change in approach
- Warning about a blocking issue (e.g., "CI is down, don't push")

Be judicious with broadcast — don't spam the channel.

## Communication Conventions

1. **Be concise.** Other instances may be mid-task. Short messages get faster responses.
2. **Include context.** Reference task IDs, file paths, and line numbers.
3. **Acknowledge replies.** A quick "thanks" lets the sender know you got it.
4. **Check messages first.** Before starting any new work, always poll for messages.
5. **Close the loop.** If you asked a question and got an answer, let the responder know the outcome.

## Finding the Right Instance to Message

Use `claude-orchestrator list-instances` to see who's online. Message someone based on role:
- **architect** — design questions, architecture decisions
- **developer** — implementation details, code questions
- **tester** — test strategy, bug reproduction, quality concerns
- **general** — any topic

## Shared Context as Persistent Communication

For information that multiple instances will need over time, use shared context instead of broadcasting:
- `claude-orchestrator set-context --key ci_status --value "failing: auth tests"` persists for all instances
- `claude-orchestrator get-context --key ci_status` retrieves it anytime

This is more efficient than re-broadcasting the same information.
