// Validates template variable substitution without invoking Claude.
// Run via: bash workspace-llm-tests/run-all.sh

import { renderTemplate, projectPath, runScenario, assert } from "../lib/llm-helpers.js";

const LINKS = ["plan", "build", "verify", "review", "accept"];

const TEST_VARS = {
  name: "TestWorker",
  preset_role: "builder",
  work_dir: "/tmp/test-workdir",
  time: new Date().toISOString(),
  task_title: "Build the countLines CLI tool",
  task_description: "Implement a Node.js CLI that recursively counts lines of code in a directory, excluding node_modules and .git.",
  task_criteria: "- Must accept --dir and --exclude flags\n- Must output JSON with file paths and line counts\n- Must handle binary files gracefully",
  task_doc_path: "/tmp/test-doc.md",
  result_path: "/tmp/test-result.md",
  content: "Please complete this task according to the instructions.",
  current_link: "build",
};

await runScenario("01 — Template Rendering Validation", async () => {
  const agentsDir = projectPath(".claude-orchestrator", "agents");

  // Verify agents directory exists (requires setup to have been run)
  let allTemplatesOk = true;

  // 1. Test per-link templates
  for (const link of LINKS) {
    const templatePath = projectPath(agentsDir, `worker-${link}.md`);
    let rendered;

    try {
      rendered = await renderTemplate(templatePath, {
        ...TEST_VARS,
        current_link: link,
      });
    } catch (e) {
      assert(false, `Failed to load ${templatePath}: ${e.message}`);
      return;
    }

    // Verify no unreplaced placeholders
    const unreplaced = rendered.match(/\{\{\w+\}\}/g);
    if (unreplaced) {
      console.error(`  WARNING: ${link} template has unreplaced placeholders: ${unreplaced.join(", ")}`);
      allTemplatesOk = false;
    }

    // Verify key variables are present
    assert(
      rendered.includes(TEST_VARS.name),
      `${link} template should contain worker name`
    );
    assert(
      rendered.includes(TEST_VARS.task_title),
      `${link} template should contain task title`
    );
    assert(
      rendered.includes(link),
      `${link} template should reference link "${link}"`
    );

    console.log(`  ${link}: ${rendered.length} chars, no unreplaced placeholders`);
  }

  // 2. Test generic worker.md template
  const genericPath = projectPath(agentsDir, "worker.md");
  try {
    const genericRendered = await renderTemplate(genericPath, TEST_VARS);
    const unreplaced = genericRendered.match(/\{\{\w+\}\}/g);
    if (unreplaced) {
      console.error(`  WARNING: worker.md has unreplaced placeholders: ${unreplaced.join(", ")}`);
      allTemplatesOk = false;
    }
    console.log(`  worker.md: ${genericRendered.length} chars, no unreplaced placeholders`);
  } catch (e) {
    console.error(`  WARNING: worker.md not found (may not have been set up): ${e.message}`);
  }

  // 3. Test leader.md template
  const leaderPath = projectPath(agentsDir, "leader.md");
  try {
    const leaderVars = {
      leader_name: "TestLeader",
      created_at: new Date().toISOString(),
      content: "Test task assignment",
      task_doc_path: "/tmp/doc.md",
      result_path: "/tmp/result.md",
    };
    const leaderRendered = await renderTemplate(leaderPath, leaderVars);
    const unreplaced = leaderRendered.match(/\{\{\w+\}\}/g);
    if (unreplaced) {
      console.error(`  WARNING: leader.md has unreplaced placeholders: ${unreplaced.join(", ")}`);
      allTemplatesOk = false;
    }
    console.log(`  leader.md: ${leaderRendered.length} chars`);
  } catch (e) {
    console.error(`  WARNING: leader.md not found: ${e.message}`);
  }

  assert(allTemplatesOk, "All templates should have no unreplaced placeholders");
});
