import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock execWithStreaming before importing ClaudeRunner
vi.mock("../../src/utils/exec.js", () => ({
  execWithStreaming: vi.fn().mockResolvedValue({ code: 0 }),
}));

import { ClaudeRunner } from "../../src/executor/runner.js";
import { execWithStreaming } from "../../src/utils/exec.js";

const testIdentity = {
  name: "TestWorker",
  role: "builder",
  worktreePath: "/tmp/work",
  worktreeBranch: "claude-orchestrator/TestWorker-workspace",
  instanceId: "test-instance-001",
};

describe("ClaudeRunner", () => {
  let tmpDir: string;
  let runner: ClaudeRunner;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
    runner = new ClaudeRunner("claude", tmpDir, "leader-001", "/tmp/work", testIdentity);
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

  describe("buildIdentityPrompt", () => {
    it("returns empty string when no identity template provided", () => {
      const prompt = runner.buildIdentityPrompt();
      expect(prompt).toBe("");
    });

    it("renders identity template with worker details", () => {
      const templateRunner = new ClaudeRunner(
        "claude", tmpDir, "leader-001", "/tmp/work", testIdentity,
        "## Worker Identity\nYou are **{{name}}**, a **{{role}}**.\n- Name: {{name}}\n- Role: {{role}}\n- Worktree: {{worktreePath}}\n- Branch: {{worktreeBranch}}\n- Instance: {{instanceId}}",
      );
      const prompt = templateRunner.buildIdentityPrompt();
      expect(prompt).toContain("TestWorker");
      expect(prompt).toContain("builder");
      expect(prompt).toContain("/tmp/work");
      expect(prompt).toContain("claude-orchestrator/TestWorker-workspace");
      expect(prompt).toContain("test-instance-001");
      expect(prompt).not.toContain("{{name}}");
      expect(prompt).not.toContain("{{role}}");
    });
  });

  describe("run", () => {
    it("calls execWithStreaming as sole execution entry", async () => {
      const result = await runner.run("test prompt", "/tmp/test.log");
      expect(result).toEqual({ code: 0 });
      expect(execWithStreaming).toHaveBeenCalledWith(
        "claude", "test prompt", "/tmp/test.log",
        undefined,  // systemPrompt
        undefined,  // onChunk
        "/tmp/work", // workDir
        false,       // quiet
      );
    });

    it("passes systemPrompt to execWithStreaming", async () => {
      await runner.run("test prompt", "/tmp/test.log", {
        systemPrompt: "You are a helper.",
      });
      expect(execWithStreaming).toHaveBeenCalledWith(
        "claude", "test prompt", "/tmp/test.log",
        "You are a helper.",
        undefined,
        "/tmp/work",
        false,
      );
    });

    it("appends --resume and --fork-session to command", async () => {
      await runner.run("test prompt", "/tmp/test.log", {
        resumeSessionId: "abc123",
        forkSession: true,
      });
      expect(execWithStreaming).toHaveBeenCalledWith(
        "claude --resume abc123 --fork-session", "test prompt", "/tmp/test.log",
        undefined, undefined, "/tmp/work", false,
      );
    });

    it("passes onChunk when configured in constructor", async () => {
      const onChunk = vi.fn();
      const streamingRunner = new ClaudeRunner(
        "claude", tmpDir, "leader-001", "/tmp/work", testIdentity, undefined, onChunk,
      );
      await streamingRunner.run("test prompt", "/tmp/test.log");
      expect(execWithStreaming).toHaveBeenCalledWith(
        "claude", "test prompt", "/tmp/test.log",
        undefined,
        onChunk,
        "/tmp/work",
        false,
      );
    });
  });
});
