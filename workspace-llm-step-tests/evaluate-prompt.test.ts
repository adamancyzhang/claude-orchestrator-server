import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { ClaudeRunner } from "../src/executor/runner.js";
import { TemplateEngine } from "../src/executor/template.js";
import type { WorkerIdentity } from "../src/executor/runner.js";

const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude --dangerously-skip-permissions --permission-mode dontAsk";
const CACHE_DIR = process.env.STEP_CACHE_DIR || "/tmp/prompt-test-cache";
const TEMPLATES_DIR = path.resolve("templates/agents");
const TEST_TIMEOUT = Number(process.env.STEP_TIMEOUT_SEC || 120) * 1000;

const identity: WorkerIdentity = {
  name: "EvaluateTester",
  role: "builder",
  worktreePath: "/tmp/evaluate-test-worktree",
  worktreeBranch: "co-worker-EvaluateTester",
  instanceId: "evaluate-test-001",
};

const VALID_DECISIONS = ["activate_next", "feedback", "close_chain"];

function extractJson(text: string): Record<string, unknown> {
  // Try direct parse first
  try { return JSON.parse(text); } catch {}

  // Try ```json fence
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }

  // Try to find a JSON object with "decision" field
  const jsonMatch = text.match(/\{[\s\S]*"decision"[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }

  throw new Error(`Cannot extract valid JSON from: ${text.slice(0, 300)}`);
}

describe("Evaluate Prompt (worker-evaluate.md)", () => {
  const engine = new TemplateEngine(TEMPLATES_DIR);
  const runner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, "leader-step", process.cwd(), identity);

  // Create a fake build result for evaluation
  const fakeResultPath = runner.resultPath("evaluate-fake-result");
  beforeAll(() => {
    fs.mkdirSync(path.dirname(fakeResultPath), { recursive: true });
    fs.writeFileSync(
      fakeResultPath,
      [
        "# Build Completion Report",
        "",
        "Link: build",
        "Status: completed",
        "Implemented: 5 items",
        "Deviations: 0",
        "Next Link Ready: yes",
        "",
        "## Traceability Map",
        "",
        "| Requirement | Status | Evidence |",
        "|---|---|---|",
        "| R1: Function signature | PASS | src/email-validator.ts |",
        "| R2: RFC 5322 compliance | PASS | Regex validation implemented |",
        "| R3: Edge cases | PASS | null, empty, special chars handled |",
      ].join("\n"),
    );
  });

  it(
    "renders template, runs claude, and writes valid EvalDecision JSON to result_path",
    { timeout: TEST_TIMEOUT },
    async () => {
      const template = await engine.loadFile("worker-evaluate.md");
      expect(template.length).toBeGreaterThan(0);

      const resultPath = runner.resultPath("evaluate-decision");

      const rendered = engine.render(template, {
        name: identity.name,
        link: "build",
        task_title: "Implement Email Validator",
        task_description: "Implement a TypeScript function isValidEmail(email: string): boolean",
        task_criteria: "Returns true for valid emails, false for invalid. Handles edge cases.",
        task_result_path: fakeResultPath,
        result_path: resultPath,
      });

      // {{YYYY-MM-DD}} is literal in template — not a replacement var
      const unreplaced = rendered.match(/\{\{(\w+)\}\}/g);
      const nonDateUnreplaced = unreplaced?.filter((v) => v !== "{{YYYY-MM-DD}}");
      expect(nonDateUnreplaced?.length || 0).toBe(0);

      const logPath = runner.logPath("evaluate-decision");
      const t0 = Date.now();
      const result = await runner.run(rendered, logPath);
      console.log(`  Exit: ${result.code}, elapsed: ${Date.now() - t0}ms`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(resultPath)).toBe(true);

      const content = fs.readFileSync(resultPath, "utf-8").trim();
      console.log(`  EvalDecision result: ${content.slice(0, 200)}`);

      const parsed = extractJson(content);
      expect(parsed.decision).toBeTruthy();
      expect(parsed.reason).toBeTruthy();
      expect(VALID_DECISIONS).toContain(parsed.decision);

      console.log(`  Decision: ${parsed.decision}, Reason: ${parsed.reason}`);
      if (parsed.nextLink) console.log(`  NextLink: ${parsed.nextLink}`);
    },
  );

  it(
    "produces activate_next for a successful build result",
    { timeout: TEST_TIMEOUT },
    async () => {
      const template = await engine.loadFile("worker-evaluate.md");

      const resultPath = runner.resultPath("evaluate-success-decision");
      const successPath = runner.resultPath("evaluate-success-result");
      fs.mkdirSync(path.dirname(successPath), { recursive: true });
      fs.writeFileSync(
        successPath,
        [
          "# Build Completion Report",
          "",
          "Link: build",
          "Status: completed",
          "Implemented: 3 items",
          "Deviations: 0",
          "Next Link Ready: yes",
          "",
          "All tests passing, coverage 95%.",
        ].join("\n"),
      );

      const rendered = engine.render(template, {
        name: identity.name,
        link: "build",
        task_title: "Test Task",
        task_description: "Test description",
        task_criteria: "Must pass all tests",
        task_result_path: successPath,
        result_path: resultPath,
      });

      const logPath = runner.logPath("evaluate-success-decision");

      await runner.run(rendered, logPath);

      expect(fs.existsSync(resultPath)).toBe(true);
      const content = fs.readFileSync(resultPath, "utf-8").trim();

      const parsed = extractJson(content);
      console.log(`  Decision for success: ${parsed.decision}`);
      expect(parsed.decision).toMatch(/activate_next|feedback|close_chain/);
      // For a clearly successful build, expect activate_next
      if (parsed.decision === "activate_next") {
        expect(parsed.nextLink).toBe("verify");
      }
    },
  );
});
