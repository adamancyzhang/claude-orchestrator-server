// Real claude -p invocation: Leader Decide
// Run via: bash workspace-llm-tests/run-all.sh

import { renderTemplate, runClaude, validateLeaderDecision, projectPath, runScenario, assert } from "../lib/llm-helpers.js";

await runScenario("07 — Leader: Decide (claude -p)", async () => {
  const templatePath = projectPath(".claude-orchestrator", "agents", "leader-decide.md");

  const teamStatus = `
Active Workers:
- Alice (planner) — idle
- Bob (builder) — busy (task: Build countLines)
- Eve (verifier) — idle
- Frank (reviewer) — idle
- Grace (accepter) — idle
`.trim();

  const taskQueues = `
PENDING: 0 tasks
IN PROGRESS: 1 task (Build countLines, claimed by Bob)
COMPLETED: 1 task (Plan countLines, completed by Alice)
`.trim();

  const chainStatus = `
Chain: countLines-v1
Plan: COMPLETED
Build: IN PROGRESS (Bob)
Verify: WAITING
Review: WAITING
Accept: WAITING
`.trim();

  const workerReport = `
Link: build
Status: completed
Summary: Implemented countLines CLI with all plan requirements. Used commander for CLI, sync fs APIs for traversal and counting. Binary detection added.
Result Path: /tmp/countlines-build-result.md
Task completed. Leader, please review and decide next step.
`.trim();

  const vars = {
    team_status: teamStatus,
    task_queues: taskQueues,
    chain_status: chainStatus,
    content: workerReport,
  };

  const prompt = await renderTemplate(templatePath, vars);
  console.log(`  Prompt: ${prompt.length} chars`);

  console.log("  Calling claude -p ...");
  const { stdout, stderr, code } = await runClaude(prompt);

  console.log(`  Exit code: ${code}`);
  console.log(`  Output: ${stdout.length} chars`);
  console.log(`  --- Output preview ---`);
  console.log(stdout.slice(0, 600));
  if (stdout.length > 600) console.log("  ... (truncated)");
  console.log(`  --- End preview ---`);

  assert(code === 0, `Claude should exit 0, got ${code}`);
  const result = validateLeaderDecision(stdout);
  for (const e of result.errors) console.error(`  VALIDATION ERROR: ${e}`);
  for (const w of result.warnings) console.log(`  VALIDATION WARNING: ${w}`);
  if (result.parsed) {
    console.log(`  Parsed decision: ${result.parsed.decision}`);
    console.log(`  Next action: ${JSON.stringify(result.parsed.next_action)}`);
  }
  assert(result.valid, `Leader decide validation failed: ${result.errors.join("; ")}`);
  assert(result.parsed !== null, "Should extract valid JSON from output");
});
