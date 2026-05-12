// Real claude -p invocation: Worker Self-Evaluate
// Run via: bash workspace-llm-tests/run-all.sh

import { renderTemplate, runClaude, validateEvalDecision, projectPath, runScenario, assert } from "../lib/llm-helpers.js";

await runScenario("07 — Worker: Self-Evaluate (claude -p)", async () => {
  const templatePath = projectPath(".claude-orchestrator", "agents", "worker-evaluate.md");

  const vars = {
    name: "Bob",
    preset_role: "builder",
    link: "build",
    task_title: "Build countLines CLI",
    task_description: "Implement a CLI tool that counts lines of code in a directory, excluding binaries",
    task_criteria: "CLI accepts --dir and --exclude flags; handles empty dirs; skips binary files; outputs file:lines format",
    task_result_path: "/tmp/countlines-build-result.md",
    result_path: "/tmp/countlines-eval-result.md",
    work_dir: process.cwd(),
    time: new Date().toISOString(),
    content: "Build task completed",
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
  const result = validateEvalDecision(stdout);
  for (const e of result.errors) console.error(`  VALIDATION ERROR: ${e}`);
  for (const w of result.warnings) console.log(`  VALIDATION WARNING: ${w}`);
  if (result.parsed) {
    console.log(`  Parsed decision: ${result.parsed.decision}`);
    console.log(`  Reason: ${result.parsed.reason}`);
  }
  assert(result.valid, `Eval decision validation failed: ${result.errors.join("; ")}`);
  assert(result.parsed !== null, "Should extract valid JSON from output");
});
