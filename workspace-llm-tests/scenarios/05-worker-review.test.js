// Real claude -p invocation: Reviewer role
// Run via: bash workspace-llm-tests/run-all.sh

import { renderTemplate, runClaude, validateWorkerOutput, projectPath, runScenario, assert } from "../lib/llm-helpers.js";

await runScenario("05 — Worker: Review (claude -p)", async () => {
  const templatePath = projectPath(".claude-orchestrator", "agents", "worker-review.md");

  const chainContext = `
=== PLAN (Blueprint) ===
Design a countLines CLI: traverse dirs, count lines per file, output JSON. Accept --dir and --exclude flags.

=== BUILD (Implementation) ===
Implemented using commander, fs.readdirSync, fs.readFileSync. Binary detection via null-byte check.
Deviations: Used sync APIs.

=== VERIFY (Findings) ===
Plan Req 1 (--dir flag): PASS — commander handles this
Plan Req 2 (--exclude flag): PASS — comma-separated exclusion list
Plan Req 3 (JSON output): PASS — console.log(JSON.stringify(results))
Plan Req 4 (binary files): PASS — null-byte detection implemented
Plan Req 5 (recursive): PASS — recursive readdirSync
Recommendation: PASS — all 5 requirements verified
`.trim();

  const vars = {
    name: "Frank",
    preset_role: "reviewer",
    work_dir: projectPath(),
    time: new Date().toISOString(),
    task_title: "Review countLines delivery chain",
    task_description: `Review the full Plan → Build → Verify chain for the countLines CLI tool.\n\nFull chain context:\n${chainContext}\n\nMake a judgment: PASS, FEEDBACK, or REJECT.`,
    task_criteria: "1. Each chain artifact reviewed\n2. Concerns documented with evidence\n3. Clear decision: PASS / FEEDBACK / REJECT",
    task_doc_path: "",
    result_path: "/tmp/countlines-review-result.md",
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
  const result = validateWorkerOutput(stdout, "review");
  for (const e of result.errors) console.error(`  VALIDATION ERROR: ${e}`);
  for (const w of result.warnings) console.log(`  VALIDATION WARNING: ${w}`);
  assert(result.valid, `Review output validation failed: ${result.errors.join("; ")}`);
});
