# Data Flow

Detailed diagrams of message passing, task lifecycle, and chain management.

---

## Task Lifecycle

```
                    +-----------------+
                    | User types in   |
                    | TUI input line  |
                    +--------+--------+
                             |
                             v
                    +--------+--------+
                    | ChainRouter     |
                    | .route(msg)     |
                    +--------+--------+
                             |
                    +--------v--------+
                    | ClaudeRunner    |
                    | (decompose)     |
                    | -> ChainDef     |
                    +--------+--------+
                             |
              +--------------+--------------+
              |              |              |
              v              v              v
        +-----+-----+ +-----+-----+ +-----+-----+
        | TaskQueue   | | TaskQueue   | | TaskQueue   |
        | .push(plan) | | .push(exec) | | .push(verify)|
        +-----+------+ +-----+------+ +-----+------+
              |              |              |
              v              v              v
        +-----+-----+ +-----+-----+ +-----+-----+
        | pending    | | pending    | | pending    |
        +-----+------+ +-----+------+ +-----+------+
              |              |              |
              v              |              |
        +-----+------+      |              |
        | MessageRouter     |              |
        | .send(dispatch)   |              |
        +-----+------+      |              |
              |              |              |
              v              |              |
        +-----+------+      |              |
        | Worker (planner)   |              |
        | claims plan task   |              |
        +-----+------+      |              |
              |              |              |
              v              |              |
        +-----+------+      |              |
        | 8-step pipeline    |              |
        | execute -> commit  |              |
        | -> evaluate        |              |
        +-----+------+      |              |
              |              |              |
              v              |              |
        +-----+------+      |              |
        | completion_report  |              |
        | (EvalDecision)     |              |
        +-----+------+      |              |
              |              |              |
              v              |              |
        +-----+------+      |              |
        | ChainRouter       |              |
        | activate_next     |              |
        +-----+------+      |              |
              |              |              |
              v              v              |
        +-----+------+ +-----+------+      |
        | Worker (executor)| | pending    | |
        | claims exec task | | (verify)   | |
        +-----+------+ +-----+------+      |
              |              |              |
              v              v              v
              ... (continues through chain)
              |
              v
        +-----+------+
        | close_chain |
        +-----+------+
              |
              v
        +-----+------+
        | MergeValidator|
        | .validate()  |
        +-----+------+
              |
        +-----v------+
        | merge to   |
        | main branch|
        +-----+------+
              |
              v
        +-----+------+
        | chain_closed|
        +------------+
```

---

## Message Types and Routing

```
+------------------+     +------------------+     +------------------+
|     Leader       |     |  MessageRouter   |     |     Worker       |
+--------+---------+     +--------+---------+     +--------+---------+
         |                       |                       |
         |  task_dispatch        |                       |
         |---------------------->|---------------------->|
         |                       |                       |
         |                       |     worker_activity   |
         |<----------------------|<----------------------|
         |                       |                       |
         |  completion_report    |                       |
         |<----------------------|<----------------------|
         |                       |                       |
         |  user_input           |                       |
         |<----------------------|  (self-directed)      |
         |                       |                       |
         |  memory_refresh       |                       |
         |<----------------------|<----------------------|
         |                       |                       |
         |  broadcast            |                       |
         |---------------------->|---------------------->|
         |                       |  (all instances)      |
```

### Message Types

| Type | From | To | Purpose |
|------|------|----|---------|
| `task_dispatch` | Leader | Worker | Assign a task to a Worker |
| `completion_report` | Worker | Leader | Report task completion with EvalDecision |
| `worker_activity` | Worker | Leader | Report pipeline phase progress |
| `user_input` | TUI/CLI | Leader | New requirement or slash command |
| `memory_refresh` | Worker | Leader | Notify of changed files for memory update |
| `direct` | Any | Any | Point-to-point message |
| `broadcast` | Any | All | Broadcast to all instances |
| `help` | Worker | Leader | Request assistance |

---

## Chain Lifecycle

```
+-------------------+
| requirement typed |
+--------+----------+
         |
         v
+--------+----------+
| decompose (Leader |
| + ClaudeRunner)   |
+--------+----------+
         |
         v
+--------+----------+      +-------------------+
| ChainDef created  |----->| chain_audit       |
| plan->exec->verify|      | .openChain()      |
| ->review->accept  |      +-------------------+
+--------+----------+
         |
         v
+--------+----------+
| chain_activated   |
| event emitted     |
+--------+----------+
         |
         v
+--------+----------+
| plan task created |
| + dispatched to   |
| planner Worker    |
+--------+----------+
         |
         v
+--------+----------+
| Worker completes  |
| plan link         |
+--------+----------+
         |
         v
+--------+----------+
| EvalDecision:     |
| activate_next     |
+--------+----------+
         |
         v
+--------+----------+
| execute task      |
| created +         |
| dispatched to     |
| executor Worker   |
+--------+----------+
         |
         v
        ... (verify -> review -> accept)
         |
         v
+--------+----------+
| accept link       |
| completes with    |
| close_chain       |
+--------+----------+
         |
         v
+--------+----------+
| MergeValidator    |
| .validate()       |
+--------+----------+
         |
    +----+----+
    |         |
    v         v
+---+---+ +---+--------+
| merge | | conflict   |
| success| | or failure |
+---+---+ +---+--------+
    |         |
    v         v
+---+---+ +---+--------+
| chain | | retry with |
| closed| | conflict   |
| (done)| | fix tasks  |
+-------+ +------------+
```

---

## EvalDecision Impact Matrix

| Decision | Source Link | Target | Effect |
|----------|------------|--------|--------|
| `activate_next` | plan | execute Worker | Create execute task, dispatch |
| `activate_next` | execute | verify Worker | Create verify task, dispatch |
| `activate_next` | verify | review Worker | Create review task, dispatch |
| `activate_next` | review | accept Worker | Create accept task, dispatch |
| `activate_next` | accept | (magic mode) | Create explore task, dispatch |
| `feedback` | any | prev link Worker | Create retry task with feedback text |
| `close_chain` | accept | Leader | Merge all commits, close chain |
| `reject` | any | Leader | Abort chain |
| `spawn_chain` | explore | Leader | Close parent, create child chain |

---

## Worker 8-Step Pipeline Detail

```
+-------------------+
| 1. Parse message  |
| Extract: link,    |
| task_id, chain_id |
+--------+----------+
         |
         v
+--------+----------+
| 2. Select template|
| worker-{link}.md  |
+--------+----------+
         |
         v
+--------+----------+
| 3. Fire hook      |
| worker_message    |
| _start            |
+--------+----------+
         |
         v
+--------+----------+
| 4. Render prompt  |
| TemplateEngine    |
| .render() +       |
| identity prompt   |
+--------+----------+
         |
         v
+--------+----------+
| 5. Execute task   |
| ClaudeRunner.run()|
| -> sessionId      |
+--------+----------+
         |
         v
+--------+----------+
| 6. Commit check   |
| CommitChecker     |
| .check(sessionId) |
| auto-commit       |
+--------+----------+
         |
         v
+--------+----------+
| 7. Self-evaluate  |
| SelfEvaluator     |
| .evaluate()       |
| --fork-session    |
| -> EvalDecision   |
+--------+----------+
         |
         v
+--------+----------+
| 8. Report         |
| send completion   |
| _report to Leader |
| (EvalDecision +   |
|  commit info)     |
+-------------------+
```

---

## Merge Validation Flow

```
+-------------------+
| chain close       |
| requested         |
+--------+----------+
         |
         v
+--------+----------+
| MergeValidator    |
| .validate(commit, |
|  chainId, mode)   |
+--------+----------+
         |
         v
+--------+----------+
| Check if commit   |
| already merged    |
| (git merge-base   |
| --is-ancestor)    |
+--------+----------+
         |
    +----+----+
    |         |
    v         v
+---+---+ +---+--------+
| merged| | not merged |
| skip  | |            |
+-------+ +---+--------+
                |
                v
        +-------+--------+
        | Ask Claude for |
        | merge decision |
        | (template)     |
        +-------+--------+
                |
                v
        +-------+--------+
        | MergeDecision: |
        | merge/skip/    |
        | review_first   |
        +---+----+---+---+
            |    |   |
            v    v   v
        +---+ +---+ +---+
        | m | | s | | r |
        | e | | k | | e |
        | r | | i | | v |
        | g | | p | | i |
        | e | |   | | e |
        +---+ +---+ +---+
            |       |
            v       v
        +---+---+ +---+---+
        | git   | | return|
        | merge | | skip/ |
        | --no- | | review|
        | ff    | +-------+
        +---+---+
            |
       +----+----+
       |         |
       v         v
   +---+---+ +---+--------+
   | success| | conflict   |
   | return | | abort +    |
   | merge  | | throw      |
   +--------+ +------------+
```
