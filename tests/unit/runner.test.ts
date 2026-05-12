import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock execWithTee before importing ClaudeRunner
vi.mock("../../src/utils/exec.js", () => ({
  execWithTee: vi.fn().mockResolvedValue({ code: 0 }),
}));

import { ClaudeRunner } from "../../src/executor/runner.js";
import { execWithTee } from "../../src/utils/exec.js";

describe("ClaudeRunner", () => {
  let tmpDir: string;
  let runner: ClaudeRunner;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
    runner = new ClaudeRunner("claude", tmpDir, "leader-001", "/tmp/work");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("path methods", () => {
    it("taskDocPath returns path under tasks/YYYY-MM-DD", () => {
      const p = runner.taskDocPath("task-123");
      expect(p).toContain("tasks/");
      expect(p).toContain("task-123.md");
      expect(fs.existsSync(path.dirname(p))).toBe(true);
    });

    it("logPath returns path under logs/YYYY-MM-DD", () => {
      const p = runner.logPath("my-key");
      expect(p).toContain("logs/");
      expect(p).toContain("my-key.log");
      expect(fs.existsSync(path.dirname(p))).toBe(true);
    });

    it("resultPath returns path under results/YYYY-MM-DD", () => {
      const p = runner.resultPath("my-key");
      expect(p).toContain("results/");
      expect(p).toContain("my-key-result.md");
      expect(fs.existsSync(path.dirname(p))).toBe(true);
    });

    it("evalLogPath returns path under eval/YYYY-MM-DD", () => {
      const p = runner.evalLogPath("my-key");
      expect(p).toContain("eval/");
      expect(p).toContain("my-key-eval.log");
      expect(fs.existsSync(path.dirname(p))).toBe(true);
    });

    it("evalResultPath returns path under eval/YYYY-MM-DD", () => {
      const p = runner.evalResultPath("my-key");
      expect(p).toContain("eval/");
      expect(p).toContain("my-key-eval-result.md");
      expect(fs.existsSync(path.dirname(p))).toBe(true);
    });
  });

  describe("run", () => {
    it("calls execWithTee with command, prompt, logPath, and workDir", async () => {
      const result = await runner.run("test prompt", "/tmp/test.log");
      expect(result).toEqual({ code: 0 });
      expect(execWithTee).toHaveBeenCalledWith("claude", "test prompt", "/tmp/test.log", "/tmp/work");
    });
  });
});
