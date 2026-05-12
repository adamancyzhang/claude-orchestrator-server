// Real claude -p invocation: Verifier role
// Run via: bash workspace-llm-tests/run-all.sh

import { renderTemplate, runClaude, validateWorkerOutput, projectPath, runScenario, assert } from "../lib/llm-helpers.js";

await runScenario("04 — Worker: Verify (claude -p)", async () => {
  const templatePath = projectPath(".claude-orchestrator", "agents", "worker-verify.md");

  const planAndBuildContext = `
Plan Requirements:
1. Accept --dir (required) and --exclude (optional) flags
2. Output JSON array with {path, lines} objects
3. Skip binary files gracefully
4. Exclude node_modules and .git by default
5. Recursively traverse directories

Builder Output:
- Implemented index.js with commander for CLI parsing
- Implemented traverse(dir, exclude) using fs.readdirSync recursively
- Implemented countLines(filePath) using fs.readFileSync
- Added binary file detection (checks for null bytes)
- Outputs JSON via console.log

Deviations: Used sync APIs instead of async (simpler for a CLI tool)
`.trim();

  const vars = {
    name: "Eve",
    preset_role: "verifier",
    work_dir: projectPath(),
    time: new Date().toISOString(),
    task_title: "Verify countLines implementation",
    task_description: `Verify that the Builder's implementation matches the Plan requirements.\n\nContext:\n${planAndBuildContext}\n\nCross-reference each plan requirement against the builder's output.`,
    task_criteria: "1. Each plan requirement checked against implementation\n2. Gaps documented\n3. Clear pass/fail recommendation",
    task_doc_path: "",
    result_path: "/tmp/countlines-verify-result.md",
  };

  const prompt = await renderTemplate(templatePath, vars);
  console.log(`  Prompt: ${prompt.length} chars`);

  console.log("  Calling claude -p ...");
  const { stdout, stderr, code } = await runClaude(prompt);

  console.log(`  Exit code: ${code}`);
  console.log(`  Output: ${stdout.length} chars`);
  console.log(`  --- Output preview ---`);
  console.log(stdout.slice(0, 400));
  if (stdout.length > 400) console.log("  ... (truncated)");
  console.log(`  --- End preview ---`);

  assert(code === 0, `Claude should exit 0, got ${code}`);
  const result = validateWorkerOutput(stdout, "verify");
  for (const e of result.errors) console.error(`  VALIDATION ERROR: ${e}`);
  for (const w of result.warnings) console.log(`  VALIDATION WARNING: ${w}`);
  assert(result.valid, `Verify output validation failed: ${result.errors.join("; ")}`);
});
