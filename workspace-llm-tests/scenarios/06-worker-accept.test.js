// Real claude -p invocation: Accepter role
// Run via: bash workspace-llm-tests/run-all.sh

import { renderTemplate, runClaude, validateWorkerOutput, projectPath, runScenario, assert } from "../lib/llm-helpers.js";

await runScenario("06 — Worker: Accept (claude -p)", async () => {
  const templatePath = projectPath(".claude-orchestrator", "agents", "worker-accept.md");

  const fullChainContext = `
=== PLAN ===
Blueprint: countLines CLI — traverse dirs, count lines, JSON output. Flags: --dir, --exclude.

=== BUILD ===
Implemented: index.js with commander, traverse(), countLines(). Binary detection via null-byte check. Sync APIs used.

=== VERIFY ===
All 5 requirements pass: --dir flag, --exclude flag, JSON output, binary handling, recursive traversal.
Recommendation: PASS.

=== REVIEW ===
Decision: PASS. No concerns. All artifacts consistent. Implementation matches plan. Verification confirms all requirements met.
`.trim();

  const vars = {
    name: "Grace",
    preset_role: "accepter",
    work_dir: projectPath(),
    time: new Date().toISOString(),
    task_title: "Accept countLines delivery",
    task_description: `Make the final GO/NO-GO decision for the countLines CLI tool.\n\nFull chain context:\n${fullChainContext}\n\nRead all artifacts and make your final decision.`,
    task_criteria: "1. All chain outputs reviewed\n2. Each criteria checked\n3. Clear GO/NO-GO decision with evidence",
    task_doc_path: "",
    result_path: "/tmp/countlines-accept-result.md",
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
  const result = validateWorkerOutput(stdout, "accept");
  for (const e of result.errors) console.error(`  VALIDATION ERROR: ${e}`);
  for (const w of result.warnings) console.log(`  VALIDATION WARNING: ${w}`);
  assert(result.valid, `Accept output validation failed: ${result.errors.join("; ")}`);
});
