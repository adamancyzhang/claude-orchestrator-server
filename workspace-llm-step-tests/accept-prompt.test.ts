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
  name: "AcceptTester",
  role: "accepter",
  worktreePath: "/tmp/accept-test-worktree",
  worktreeBranch: "co-worker-AcceptTester",
  instanceId: "accept-test-001",
};

describe("Accept Prompt (worker-accept.md)", () => {
  const engine = new TemplateEngine(TEMPLATES_DIR);
  const runner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, "leader-step", process.cwd(), identity);

  it(
    "renders template, runs claude, and writes acceptance report to result_path",
    { timeout: TEST_TIMEOUT },
    async () => {
      const template = await engine.loadFile("worker-accept.md");
      expect(template.length).toBeGreaterThan(0);

      const resultPath = runner.resultPath("accept-report");

      const rendered = engine.render(template, {
        name: identity.name,
        preset_role: "accepter",
        task_title: "Accept Email Validator",
        task_description: "Final validation of the email validator deliverable. Make Go/No-Go decision.",
        task_criteria: "1) isValidEmail returns correct boolean. 2) Edge cases handled. 3) Unit tests pass. 4) Code review approved. 5) All issues resolved.",
        task_doc_path: runner.taskDocPath("accept-task-001"),
        result_path: resultPath,
        work_dir: process.cwd(),
        time: new Date().toISOString(),
        content: "Accept or reject email validator deliverable",
      });

      const unreplaced = rendered.match(/\{\{(\w+)\}\}/g);
      expect(unreplaced).toBeNull();

      const logPath = runner.logPath("accept-report");
      const t0 = Date.now();
      const result = await runner.run(rendered, logPath);
      console.log(`  Exit: ${result.code}, elapsed: ${Date.now() - t0}ms`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(resultPath)).toBe(true);

      const content = fs.readFileSync(resultPath, "utf-8");
      console.log(`  Result size: ${content.length} bytes`);

      expect(content.length).toBeGreaterThan(200);

      // Should contain GO/NO-GO decision
      expect(content).toMatch(/GO|NO-GO|acceptance|final|decision/i);
      const logContent = fs.readFileSync(logPath, "utf-8");
      expect(logContent).toMatch(/Link:\s*accept|Status:\s*completed|Decision:\s*(GO|NO-GO)|Criteria Checked:|Acceptance Report/i);
    },
  );
});
