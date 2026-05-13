Branch `{{branch}}` has unmerged commits.

- SHA: {{sha}}
- Message: {{message}}
- Task: {{task_title}} ({{task_link}})

Options:
- merge: merge into {{main_branch}}
- skip: leave unmerged
- review_first: flag for human review

Respond with JSON: {"decision": "merge|skip|review_first", "reason": "..."}
