import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { ClaudeRunner } from "../src/executor/runner.js";
import { TemplateEngine } from "../src/executor/template.js";
import type { WorkerIdentity } from "../src/executor/runner.js";

const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude --dangerously-skip-permissions --permission-mode dontAsk";
const CACHE_DIR = process.env.STEP_CACHE_DIR || "/tmp/prompt-test-cache";
const TEMPLATES_DIR = path.resolve("templates/agents");
const TEST_TIMEOUT = Number(process.env.STEP_TIMEOUT_SEC || 600) * 1000;

const identity: WorkerIdentity = {
  name: "ReviewTester",
  role: "reviewer",
  worktreePath: "/tmp/review-test-worktree",
  worktreeBranch: "co-worker-ReviewTester",
  instanceId: "review-test-001",
};

describe("Review Prompt (worker-review.md)", () => {
  const engine = new TemplateEngine(TEMPLATES_DIR);
  const runner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, "leader-step", process.cwd(), identity);

  it(
    "renders template, runs claude, and writes review judgment to result_path",
    { timeout: TEST_TIMEOUT },
    async () => {
      const template = await engine.loadFile("worker-review.md");
      expect(template.length).toBeGreaterThan(0);

      const resultPath = runner.resultPath("review-judgment");

      const rendered = engine.render(template, {
        name: identity.name,
        preset_role: "reviewer",
        task_title: "Review Email Validator",
        task_description: "Review the Plan + Build + Verify output. Judge alignment with planner intent.",
        task_criteria: "For each item: ACCEPT (meets intent), CONCERN (minor issue), or REJECT (fails).",
        task_doc_path: runner.taskDocPath("review-task-001"),
        result_path: resultPath,
        work_dir: process.cwd(),
        time: new Date().toISOString(),
        content: "Review email validator deliverables",
      });

      const unreplaced = rendered.match(/\{\{(\w+)\}\}/g);
      expect(unreplaced).toBeNull();

      const logPath = runner.logPath("review-judgment");
      const t0 = Date.now();
      const result = await runner.run(rendered, logPath);
      console.log(`  Exit: ${result.code}, elapsed: ${Date.now() - t0}ms`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(resultPath)).toBe(true);

      const content = fs.readFileSync(resultPath, "utf-8");
      console.log(`  Result size: ${content.length} bytes`);

      expect(content.length).toBeGreaterThan(200);

      // Should contain review classification
      expect(content).toMatch(/ACCEPT|CONCERN|REJECT|review|judgment/i);
      const logContent = fs.readFileSync(logPath, "utf-8");
      expect(logContent).toMatch(/Link:\s*review|Status:\s*completed|Decision:\s*(PASS|FEEDBACK|REJECT)|Review Judgment/i);
    },
  );
});
