import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SelfEvaluator } from "../../../src/worker/evaluator.js";
import { MockClaudeRunner } from "../../fixtures/mock-runner.js";
import { MockTemplateEngine } from "../../fixtures/mock-template.js";
import type { ClaudeRunner } from "../../../src/executor/runner.js";
import type { TemplateEngine } from "../../../src/executor/template.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evaluator-"));
}

describe("SelfEvaluator.evaluate", () => {
  let runner: MockClaudeRunner;
  let templates: MockTemplateEngine;
  let evaluator: SelfEvaluator;

  beforeEach(() => {
    runner = new MockClaudeRunner(tmp());
    templates = new MockTemplateEngine();
    templates.setFile("worker-evaluate.md", "EVAL TEMPLATE");
    templates.setFile("worker-evaluate-format-hint.md", "FORMAT HINT");
    evaluator = new SelfEvaluator(
      templates as unknown as TemplateEngine,
      runner as unknown as ClaudeRunner,
    );
  });

  it("returns the decision JSON on a valid first attempt", async () => {
    const decision = { decision: "activate_next" as const, reason: "ok" };

    runner.run = vi.fn(async () => {
      const resultPath = runner.evalResultPath.mock.results.at(-1)?.value as string;
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, JSON.stringify(decision));
      return { code: 0, sessionId: "s" };
    });

    const out = await evaluator.evaluate("plan", {}, "/tmp/result.md", "key-1");
    expect(JSON.parse(out)).toMatchObject({ decision: "activate_next", reason: "ok" });
  });

  it("retries on malformed JSON and uses fallback after 3 failures", async () => {
    runner.run = vi.fn(async () => {
      const resultPath = runner.evalResultPath.mock.results.at(-1)?.value as string;
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, "garbage not json");
      return { code: 0, sessionId: "s" };
    });

    const out = await evaluator.evaluate("plan", {}, "/tmp/result.md", "key-2");
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe("activate_next");
    expect(parsed.nextLink).toBe("build");
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it("for the final 'accept' link, fallback closes the chain", async () => {
    runner.run = vi.fn(async () => {
      const resultPath = runner.evalResultPath.mock.results.at(-1)?.value as string;
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, "");
      return { code: 0, sessionId: "s" };
    });

    const out = await evaluator.evaluate("accept", {}, "/tmp/result.md", "key-3");
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe("close_chain");
  });
});
