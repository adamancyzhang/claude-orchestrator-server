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
  name: "PlanTester",
  role: "planner",
  worktreePath: "/tmp/plan-test-worktree",
  worktreeBranch: "co-worker-PlanTester",
  instanceId: "plan-test-001",
};

describe("Plan Prompt (worker-plan.md)", () => {
  const engine = new TemplateEngine(TEMPLATES_DIR);
  const runner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, "leader-step", process.cwd(), identity);

  it(
    "renders template, runs claude, and writes blueprint to result_path",
    { timeout: TEST_TIMEOUT },
    async () => {
      const template = await engine.loadFile("worker-plan.md");
      expect(template.length).toBeGreaterThan(0);

      const resultPath = runner.resultPath("plan-blueprint");

      const rendered = engine.render(template, {
        name: identity.name,
        preset_role: "planner",
        task_title: "Design Email Validator Module",
        task_description: "Design a TypeScript module that validates email addresses against RFC 5322.",
        task_criteria: "Blueprint must define architecture, interfaces, data flow, and concrete build steps.",
        task_doc_path: runner.taskDocPath("plan-task-001"),
        result_path: resultPath,
        work_dir: process.cwd(),
        time: new Date().toISOString(),
        content: "Design email validation module",
      });

      const unreplaced = rendered.match(/\{\{(\w+)\}\}/g);
      expect(unreplaced).toBeNull();

      const logPath = runner.logPath("plan-blueprint");
      const t0 = Date.now();
      const result = await runner.run(rendered, logPath);
      console.log(`  Exit: ${result.code}, elapsed: ${Date.now() - t0}ms`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(resultPath)).toBe(true);

      const content = fs.readFileSync(resultPath, "utf-8");
      console.log(`  Result size: ${content.length} bytes`);

      // Blueprint should contain design/architecture content
      expect(content.length).toBeGreaterThan(200);
      expect(content).toMatch(/blueprint|architecture|design|build step|component|interface|data flow/i);

      // Completion report is in stdout, not the result file.
      // Verify the log contains the completion report.
      expect(fs.existsSync(logPath)).toBe(true);
      const logContent = fs.readFileSync(logPath, "utf-8");
      expect(logContent).toMatch(/Link:\s*plan|Status:\s*completed|Blueprint Summary/i);
    },
  );
});
