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
  name: "BuildTester",
  role: "builder",
  worktreePath: "/tmp/build-test-worktree",
  worktreeBranch: "co-worker-BuildTester",
  instanceId: "build-test-001",
};

describe("Build Prompt (worker-build.md)", () => {
  const engine = new TemplateEngine(TEMPLATES_DIR);
  const runner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, "leader-step", process.cwd(), identity);

  it(
    "renders template, runs claude, and writes traceability map to result_path",
    { timeout: TEST_TIMEOUT },
    async () => {
      const template = await engine.loadFile("worker-build.md");
      expect(template.length).toBeGreaterThan(0);

      const resultPath = runner.resultPath("build-trace-map");

      const rendered = engine.render(template, {
        name: identity.name,
        preset_role: "builder",
        task_title: "Implement Email Validator",
        task_description: "Implement a TypeScript function isValidEmail(email: string): boolean following RFC 5322.",
        task_criteria: "Function returns true for valid emails, false for invalid. Handle edge cases: empty, null, special chars.",
        task_doc_path: runner.taskDocPath("build-task-001"),
        result_path: resultPath,
        work_dir: process.cwd(),
        time: new Date().toISOString(),
        content: "Implement email validation function",
      });

      const unreplaced = rendered.match(/\{\{(\w+)\}\}/g);
      expect(unreplaced).toBeNull();

      const logPath = runner.logPath("build-trace-map");
      const t0 = Date.now();
      const result = await runner.run(rendered, logPath);
      console.log(`  Exit: ${result.code}, elapsed: ${Date.now() - t0}ms`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(resultPath)).toBe(true);

      const content = fs.readFileSync(resultPath, "utf-8");
      console.log(`  Result size: ${content.length} bytes`);

      expect(content.length).toBeGreaterThan(200);

      // Should contain traceability content
      expect(content).toMatch(/traceability|requirement|checklist|implement|evidence/i);

      // Completion report is in stdout (log file)
      const logContent = fs.readFileSync(logPath, "utf-8");
      expect(logContent).toMatch(/Link:\s*build|Status:\s*completed|Implemented:|Next Link Ready/i);
    },
  );
});
