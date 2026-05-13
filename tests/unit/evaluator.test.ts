import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SelfEvaluator } from "../../src/worker/evaluator.js";
import { TemplateEngine } from "../../src/executor/template.js";
import { ClaudeRunner } from "../../src/executor/runner.js";

function makeMockTemplateEngine() {
  const engine = {
    loadFile: vi.fn(),
    render: vi.fn(),
  } as any as TemplateEngine;
  // Default: loadFile returns appropriate content based on filename
  engine.loadFile.mockImplementation((filename: string) => {
    if (filename === "worker-evaluate-format-hint.md") {
      return "## IMPORTANT: Format Correction\nYour previous output was invalid.";
    }
    return "Eval template: {{name}} {{link}} {{task_title}}";
  });
  engine.render.mockReturnValue("rendered eval prompt");
  return engine;
}

function makeMockRunner() {
  return {
    run: vi.fn().mockResolvedValue({ code: 0, sessionId: "mock-session-001" }),
    evalResultPath: vi.fn().mockReturnValue("/tmp/eval-result.json"),
    evalLogPath: vi.fn().mockReturnValue("/tmp/eval.log"),
    buildIdentityPrompt: vi.fn().mockReturnValue("## Worker Identity\nYou are **TestWorker**, a **builder**..."),
  } as any as ClaudeRunner;
}

// Write a result file that the evaluator will read
function writeResultFile(uniqueKey: string, attempt: number, content: string) {
  const runner = makeMockRunner();
  runner.evalResultPath.mockReturnValue(`/tmp/eval-${uniqueKey}-${attempt}.json`);
  fs.writeFileSync(`/tmp/eval-${uniqueKey}-${attempt}.json`, content);
}

describe("SelfEvaluator", () => {
  let engine: ReturnType<typeof makeMockTemplateEngine>;
  let runner: ReturnType<typeof makeMockRunner>;
  let evaluator: SelfEvaluator;
  let tmpDir: string;

  beforeEach(() => {
    engine = makeMockTemplateEngine();
    runner = makeMockRunner();
    evaluator = new SelfEvaluator(engine, runner);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    // Clean up any temp result files
    try { fs.unlinkSync("/tmp/eval-test-0.json"); } catch {}
    try { fs.unlinkSync("/tmp/eval-test-1.json"); } catch {}
    try { fs.unlinkSync("/tmp/eval-test-2.json"); } catch {}
  });

  describe("evaluate — basic flow", () => {
    it("loads eval template, renders, runs, reads result, returns validated JSON", async () => {
      engine.loadFile.mockResolvedValue("Eval: {{name}} {{link}} {{task_title}}");
      engine.render.mockReturnValue("rendered prompt");
      runner.evalResultPath.mockReturnValue(path.join(tmpDir, "eval-result.json"));

      // Write a valid result file that the evaluator will read
      fs.writeFileSync(
        path.join(tmpDir, "eval-result.json"),
        JSON.stringify({ decision: "activate_next", reason: "Looks good", nextLink: "build" })
      );

      const result = await evaluator.evaluate("plan", { task_title: "Test task" }, "/tmp/result.md", "test");
      const parsed = JSON.parse(result);
      expect(parsed.decision).toBe("activate_next");
      expect(parsed.reason).toBe("Looks good");
      expect(parsed.nextLink).toBe("build");
      expect(engine.loadFile).toHaveBeenCalledWith("worker-evaluate.md");
      expect(runner.run).toHaveBeenCalled();
    });

    it("cleans markdown fences from result before parsing", async () => {
      engine.render.mockReturnValue("rendered prompt");
      runner.evalResultPath.mockReturnValue(path.join(tmpDir, "eval-result.json"));

      fs.writeFileSync(
        path.join(tmpDir, "eval-result.json"),
        '```json\n{"decision": "activate_next", "reason": "done", "nextLink": "build"}\n```'
      );

      const result = await evaluator.evaluate("plan", {}, "/tmp/result.md", "test");
      const parsed = JSON.parse(result);
      expect(parsed.decision).toBe("activate_next");
    });

    it("throws when worker-evaluate.md not found and no builtin fallback", async () => {
      engine.loadFile.mockRejectedValue(new Error("Template worker-evaluate.md not found"));
      await expect(evaluator.evaluate("accept", {}, "/tmp/result.md", "test"))
        .rejects.toThrow("not found");
    });
  });

  describe("evaluate — retry loop", () => {
    it("retries on invalid JSON output", async () => {
      runner.evalResultPath
        .mockReturnValueOnce(path.join(tmpDir, "eval-0.json"))
        .mockReturnValueOnce(path.join(tmpDir, "eval-1.json"))
        .mockReturnValueOnce(path.join(tmpDir, "eval-2.json"));

      // First attempt: invalid JSON
      fs.writeFileSync(path.join(tmpDir, "eval-0.json"), "not valid json");

      // Second attempt: valid JSON
      fs.writeFileSync(
        path.join(tmpDir, "eval-1.json"),
        JSON.stringify({ decision: "activate_next", reason: "fixed", nextLink: "verify" })
      );

      const result = await evaluator.evaluate("build", {}, "/tmp/result.md", "test");
      const parsed = JSON.parse(result);
      expect(parsed.decision).toBe("activate_next");
      expect(runner.run).toHaveBeenCalledTimes(2);
    });

    it("appends format correction hint after first failure", async () => {
      runner.evalResultPath
        .mockReturnValueOnce(path.join(tmpDir, "eval-0.json"))
        .mockReturnValueOnce(path.join(tmpDir, "eval-1.json"));

      fs.writeFileSync(path.join(tmpDir, "eval-0.json"), "bad json");
      fs.writeFileSync(
        path.join(tmpDir, "eval-1.json"),
        JSON.stringify({ decision: "activate_next", reason: "ok", nextLink: "build" })
      );

      await evaluator.evaluate("plan", {}, "/tmp/result.md", "test");

      // The second run call (attempt 1) should include format correction in the prompt
      expect(runner.run).toHaveBeenCalledTimes(2);
      const secondRunPrompt = (runner.run as any).mock.calls[1][0];
      expect(secondRunPrompt).toContain("Format Correction");
    });
  });

  describe("evaluate — fallback on all failures", () => {
    it("auto-advances after all retries fail (non-terminal link)", async () => {
      // All 3 attempts return invalid JSON
      runner.evalResultPath
        .mockReturnValueOnce(path.join(tmpDir, "eval-bad-0.json"))
        .mockReturnValueOnce(path.join(tmpDir, "eval-bad-1.json"))
        .mockReturnValueOnce(path.join(tmpDir, "eval-bad-2.json"));

      fs.writeFileSync(path.join(tmpDir, "eval-bad-0.json"), "garbage");
      fs.writeFileSync(path.join(tmpDir, "eval-bad-1.json"), "more garbage");
      fs.writeFileSync(path.join(tmpDir, "eval-bad-2.json"), "still garbage");

      const result = await evaluator.evaluate("plan", {}, "/tmp/result.md", "test");
      const parsed = JSON.parse(result);
      expect(parsed.decision).toBe("activate_next");
      expect(parsed.nextLink).toBe("build");
      expect(parsed.reason).toContain("Auto-advance");
      expect(runner.run).toHaveBeenCalledTimes(3);
    });

    it("closes chain after all retries fail (terminal accept link)", async () => {
      runner.evalResultPath
        .mockReturnValueOnce(path.join(tmpDir, "eval-term-0.json"))
        .mockReturnValueOnce(path.join(tmpDir, "eval-term-1.json"))
        .mockReturnValueOnce(path.join(tmpDir, "eval-term-2.json"));

      fs.writeFileSync(path.join(tmpDir, "eval-term-0.json"), "garbage");
      fs.writeFileSync(path.join(tmpDir, "eval-term-1.json"), "garbage");
      fs.writeFileSync(path.join(tmpDir, "eval-term-2.json"), "garbage");

      const result = await evaluator.evaluate("accept", {}, "/tmp/result.md", "test");
      const parsed = JSON.parse(result);
      expect(parsed.decision).toBe("close_chain");
      expect(parsed.reason).toContain("Accept link completed");
    });
  });

  describe("evaluate — empty result file", () => {
    it("skips empty result files and continues to next attempt", async () => {
      runner.evalResultPath
        .mockReturnValueOnce(path.join(tmpDir, "eval-empty-0.json"))
        .mockReturnValueOnce(path.join(tmpDir, "eval-empty-1.json"));

      fs.writeFileSync(path.join(tmpDir, "eval-empty-0.json"), "");
      fs.writeFileSync(
        path.join(tmpDir, "eval-empty-1.json"),
        JSON.stringify({ decision: "activate_next", reason: "ok", nextLink: "build" })
      );

      const result = await evaluator.evaluate("plan", {}, "/tmp/result.md", "test");
      const parsed = JSON.parse(result);
      expect(parsed.decision).toBe("activate_next");
      expect(runner.run).toHaveBeenCalledTimes(2);
    });
  });
});
