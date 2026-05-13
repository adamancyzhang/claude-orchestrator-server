import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { ClaudeRunner } from "../src/executor/runner.js";
import { TemplateEngine } from "../src/executor/template.js";
import type { WorkerIdentity } from "../src/executor/runner.js";

const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude --dangerously-skip-permissions --permission-mode dontAsk";
const CACHE_DIR = process.env.STEP_CACHE_DIR || "/tmp/prompt-test-cache";
const TEMPLATES_DIR = path.resolve("templates/agents");
const TEST_TIMEOUT = Number(process.env.STEP_TIMEOUT_SEC || 300) * 1000;

const identity: WorkerIdentity = {
  name: "VerifyTester",
  role: "verifier",
  worktreePath: "/tmp/verify-test-worktree",
  worktreeBranch: "co-worker-VerifyTester",
  instanceId: "verify-test-001",
};

describe("Verify Prompt (worker-verify.md)", () => {
  const engine = new TemplateEngine(TEMPLATES_DIR);
  const runner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, "leader-step", process.cwd(), identity);

  it(
    "renders template, runs claude, and writes verification map to result_path",
    { timeout: TEST_TIMEOUT },
    async () => {
      const template = await engine.loadFile("worker-verify.md");
      expect(template.length).toBeGreaterThan(0);

      const resultPath = runner.resultPath("verify-map");

      const rendered = engine.render(template, {
        name: identity.name,
        preset_role: "verifier",
        task_title: "Verify Email Validator",
        task_description: "Verify the Builder's isValidEmail() implementation against the Planner's blueprint.",
        task_criteria: "Classify each item: PASS (meets criteria), GAP (missing), FAILURE (doesn't meet), DEVIATION (intentional).",
        task_doc_path: runner.taskDocPath("verify-task-001"),
        result_path: resultPath,
        work_dir: process.cwd(),
        time: new Date().toISOString(),
        content: "Verify email validation implementation",
      });

      const unreplaced = rendered.match(/\{\{(\w+)\}\}/g);
      expect(unreplaced).toBeNull();

      const logPath = runner.logPath("verify-map");
      const t0 = Date.now();
      const result = await runner.run(rendered, logPath);
      console.log(`  Exit: ${result.code}, elapsed: ${Date.now() - t0}ms`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(resultPath)).toBe(true);

      const content = fs.readFileSync(resultPath, "utf-8");
      console.log(`  Result size: ${content.length} bytes`);

      expect(content.length).toBeGreaterThan(200);

      // Should contain verification classification
      expect(content).toMatch(/PASS|GAP|FAILURE|DEVIATION|verification|checklist/i);
      const logContent = fs.readFileSync(logPath, "utf-8");
      expect(logContent).toMatch(/Link:\s*verify|Status:\s*completed|Verified:|Recommendation/i);
    },
  );
});
