## IMPORTANT: Format Correction
Your previous output was invalid JSON or did not match the required schema.

The schema is a discriminated union on the `decision` field. You MUST use **snake_case** field names exactly as listed and emit ONLY the fields for the selected branch:

```json
// activate_next
{"decision": "activate_next", "reason": "<string>", "next_link": "build|verify|review|accept", "suggested_worker": null}

// feedback
{"decision": "feedback", "reason": "<string>", "feedback_to_worker": "<string>", "feedback_target": null}

// reject
{"decision": "reject", "reason": "<string>"}

// close_chain
{"decision": "close_chain", "reason": "<string>"}
```

No markdown fences, no extra text, no trailing commas, no extra fields (e.g. NOT `nextLink`, NOT `feedback`, NOT `suggestedWorker`). Pure JSON only.
