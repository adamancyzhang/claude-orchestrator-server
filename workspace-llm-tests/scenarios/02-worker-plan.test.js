// Real claude -p invocation: Planner role
// Run via: bash workspace-llm-tests/run-all.sh

import { renderTemplate, runClaude, validateWorkerOutput, projectPath, runScenario, assert } from "../lib/llm-helpers.js";

await runScenario("02 — Worker: Plan (claude -p)", async () => {
  const templatePath = projectPath(".claude-orchestrator", "agents", "worker-plan.md");
  const vars = {
    name: "Alice",
    preset_role: "planner",
    work_dir: projectPath(),
    time: new Date().toISOString(),
    task_title: "Design countLines CLI tool",
    task_description: "Design a Node.js CLI tool that recursively counts lines of code in a directory. Requirements: accepts --dir and --exclude flags, outputs JSON, handles binary files gracefully, excludes node_modules and .git by default.",
    task_criteria: "1. Architecture diagram or description\n2. List of modules/functions with signatures\n3. Input/output format specification\n4. Error handling strategy\n5. Build steps numbered",
    task_doc_path: "",
    result_path: "/tmp/countlines-plan-result.md",
  };

  const prompt = await renderTemplate(templatePath, vars);
  console.log(`  Prompt: ${prompt.length} chars`);

  console.log("  Calling claude -p ...");
  const { stdout, stderr, code } = await runClaude(prompt);

  console.log(`  Exit code: ${code}`);
  console.log(`  Output: ${stdout.length} chars`);
  if (stderr) console.log(`  Stderr: ${stderr.slice(0, 200)}`);

  // Print first 300 chars for manual inspection
  console.log(`  --- Output preview ---`);
  console.log(stdout.slice(0, 400));
  if (stdout.length > 400) console.log("  ... (truncated)");
  console.log(`  --- End preview ---`);

  assert(code === 0, `Claude should exit 0, got ${code}`);
  const result = validateWorkerOutput(stdout, "plan");
  if (!result.valid) {
    for (const e of result.errors) console.error(`  VALIDATION ERROR: ${e}`);
  }
  for (const w of result.warnings) console.log(`  VALIDATION WARNING: ${w}`);
  assert(result.valid, `Plan output validation failed: ${result.errors.join("; ")}`);
});
