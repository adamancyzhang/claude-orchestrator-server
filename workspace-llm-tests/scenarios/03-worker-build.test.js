// Real claude -p invocation: Builder role
// Run via: bash workspace-llm-tests/run-all.sh

import { renderTemplate, runClaude, validateWorkerOutput, projectPath, runScenario, assert } from "../lib/llm-helpers.js";

await runScenario("03 — Worker: Build (claude -p)", async () => {
  const templatePath = projectPath(".claude-orchestrator", "agents", "worker-build.md");

  const planSummary = `
Blueprint: countLines CLI tool
Architecture: Single entry point (index.js) → traverse directories → filter files → count lines → output JSON
Modules: traverse(dir, exclude), countLines(filePath), formatOutput(results)
I/O: Input: --dir (required), --exclude (optional, comma-separated). Output: JSON array [{path, lines}]
Error handling: Skip unreadable files, warn on binary files, fail on missing --dir
Build steps: 1. Create project with package.json 2. Implement traverse 3. Implement countLines 4. Implement CLI parsing 5. Wire together 6. Test
`.trim();

  const vars = {
    name: "Bob",
    preset_role: "builder",
    work_dir: projectPath(),
    time: new Date().toISOString(),
    task_title: "Implement countLines CLI tool",
    task_description: `Implement the countLines CLI tool based on this plan:\n\n${planSummary}\n\nWrite the actual code. Create the files with full implementations.`,
    task_criteria: "1. All build steps completed\n2. Each function matches the plan specification\n3. Evidence provided for each step",
    task_doc_path: "",
    result_path: "/tmp/countlines-build-result.md",
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
  const result = validateWorkerOutput(stdout, "build");
  for (const e of result.errors) console.error(`  VALIDATION ERROR: ${e}`);
  for (const w of result.warnings) console.log(`  VALIDATION WARNING: ${w}`);
  assert(result.valid, `Build output validation failed: ${result.errors.join("; ")}`);
});
