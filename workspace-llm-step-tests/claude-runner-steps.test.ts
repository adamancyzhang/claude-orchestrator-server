import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ClaudeRunner } from "../src/executor/runner.js";
import type { WorkerIdentity } from "../src/executor/runner.js";

const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude --dangerously-skip-permissions --permission-mode dontAsk";
const CACHE_DIR = process.env.STEP_CACHE_DIR || "/tmp/claude-runner-step-cache";
const TEST_TIMEOUT = Number(process.env.STEP_TIMEOUT_SEC || 120) * 1000;

function uniqueKey(): string {
  return `runner-step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const testIdentity: WorkerIdentity = {
  name: "StepTestWorker",
  role: "builder",
  worktreePath: "/tmp/step-test-worktree",
  worktreeBranch: "co-worker-StepTestWorker",
  instanceId: "step-test-instance-001",
};

// ── Path methods (no claude invocation) ──

describe("ClaudeRunner — path methods", () => {
  let tmpDir: string;
  let runner: ClaudeRunner;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-step-test-"));
    runner = new ClaudeRunner(CLAUDE_CMD, tmpDir, "leader-step-001", "/tmp/work", testIdentity);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("taskDocPath creates date-namespaced dir and returns .md path", () => {
    const p = runner.taskDocPath("task-abc123");
    expect(p).toContain("tasks/");
    expect(p).toContain("task-abc123.md");
    expect(fs.existsSync(path.dirname(p))).toBe(true);
  });

  it("logPath creates date-namespaced dir and returns .log path", () => {
    const p = runner.logPath("step-1");
    expect(p).toContain("logs/");
    expect(p).toContain("step-1.log");
    expect(fs.existsSync(path.dirname(p))).toBe(true);
  });

  it("resultPath creates date-namespaced dir and returns -result.md path", () => {
    const p = runner.resultPath("step-1");
    expect(p).toContain("results/");
    expect(p).toContain("step-1-result.md");
    expect(fs.existsSync(path.dirname(p))).toBe(true);
  });

  it("evalLogPath creates date-namespaced dir and returns -eval.log path", () => {
    const p = runner.evalLogPath("step-1");
    expect(p).toContain("eval/");
    expect(p).toContain("step-1-eval.log");
    expect(fs.existsSync(path.dirname(p))).toBe(true);
  });

  it("evalResultPath creates date-namespaced dir and returns -eval-result.md path", () => {
    const p = runner.evalResultPath("step-1");
    expect(p).toContain("eval/");
    expect(p).toContain("step-1-eval-result.md");
    expect(fs.existsSync(path.dirname(p))).toBe(true);
  });

  it("ensureDir creates nested directories", () => {
    const nested = path.join(tmpDir, "a", "b", "c");
    runner.ensureDir(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

// ── buildIdentityPrompt (no claude invocation) ──

describe("ClaudeRunner — buildIdentityPrompt", () => {
  it("returns empty string when no template provided", () => {
    const runner = new ClaudeRunner(CLAUDE_CMD, "/tmp", "leader-1", "/tmp", testIdentity);
    expect(runner.buildIdentityPrompt()).toBe("");
  });

  it("renders all identity fields", () => {
    const tmpl = [
      "## Worker Identity",
      "You are **{{name}}**, a **{{role}}**.",
      "- Worktree: {{worktreePath}}",
      "- Branch: {{worktreeBranch}}",
      "- Instance: {{instanceId}}",
    ].join("\n");

    const runner = new ClaudeRunner(CLAUDE_CMD, "/tmp", "leader-1", "/tmp/work", testIdentity, tmpl);
    const prompt = runner.buildIdentityPrompt();

    expect(prompt).toContain("StepTestWorker");
    expect(prompt).toContain("builder");
    expect(prompt).toContain("/tmp/step-test-worktree");
    expect(prompt).toContain("co-worker-StepTestWorker");
    expect(prompt).toContain("step-test-instance-001");
    expect(prompt).not.toContain("{{name}}");
    expect(prompt).not.toContain("{{role}}");
    expect(prompt).not.toContain("{{worktreePath}}");
    expect(prompt).not.toContain("{{worktreeBranch}}");
    expect(prompt).not.toContain("{{instanceId}}");
  });
});

// ── Real claude-cli run tests ──

describe("ClaudeRunner — run (real claude-cli)", () => {
  let runner: ClaudeRunner;
  let logDir: string;

  beforeAll(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-real-test-"));
    runner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, "leader-step-001", process.cwd(), testIdentity);
  });

  afterAll(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it(
    "invokes claude -p and writes output to log file",
    { timeout: TEST_TIMEOUT },
    async () => {
      const key = uniqueKey();
      const logPath = path.join(logDir, `${key}.log`);
      const prompt = "Reply with exactly this single line of text and nothing else: CLAUDE_RUNNER_OK";

      const t0 = Date.now();
      const result = await runner.run(prompt, logPath);
      const elapsed = Date.now() - t0;

      console.log(`  Exit code: ${result.code}, elapsed: ${elapsed}ms`);
      console.log(`  Session ID: ${result.sessionId ?? "none"}`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(logPath)).toBe(true);

      const content = fs.readFileSync(logPath, "utf-8");
      console.log(`  Log size: ${content.length} bytes`);

      // stream-json output contains the actual response text
      expect(content.length).toBeGreaterThan(0);
      expect(content).toMatch(/CLAUDE_RUNNER_OK/);
    },
  );

  it(
    "returns a session_id in stream-json output",
    { timeout: TEST_TIMEOUT },
    async () => {
      const key = uniqueKey();
      const logPath = path.join(logDir, `${key}.log`);

      const result = await runner.run(
        "Say hello in one short sentence.",
        logPath,
      );

      console.log(`  Session ID: ${result.sessionId ?? "none"}`);
      expect(result.code).toBe(0);
      // sessionId should be present from stream-json output
      expect(result.sessionId).toBeTruthy();
      expect(typeof result.sessionId).toBe("string");
    },
  );

  it(
    "passes identity prompt via systemPrompt flag and claude references it",
    { timeout: TEST_TIMEOUT },
    async () => {
      const identityTmpl = "You are **{{name}}**, a **{{role}}** working in {{worktreePath}}.";
      const idRunner = new ClaudeRunner(
        CLAUDE_CMD, CACHE_DIR, "leader-step-001", process.cwd(), testIdentity, identityTmpl,
      );

      const key = uniqueKey();
      const logPath = path.join(logDir, `${key}.log`);

      const idPrompt = idRunner.buildIdentityPrompt();
      const fullPrompt = "What is your name and role? Answer in one sentence.";

      const result = await idRunner.run(fullPrompt, logPath, {
        systemPrompt: idPrompt,
      });

      console.log(`  Exit code: ${result.code}, session: ${result.sessionId ?? "none"}`);
      expect(result.code).toBe(0);

      const content = fs.readFileSync(logPath, "utf-8");
      // Claude should mention the worker name from system prompt
      expect(content).toMatch(/StepTestWorker/);
      expect(content).toMatch(/builder/);
    },
  );

  it(
    "creates log file with tee and captures full streaming output",
    { timeout: TEST_TIMEOUT },
    async () => {
      const key = uniqueKey();
      const logPath = path.join(logDir, `${key}.log`);
      const marker = `MARKER_${uniqueKey()}`;

      await runner.run(
        `Echo back this exact marker: ${marker}. Reply with only the marker text.`,
        logPath,
      );

      expect(fs.existsSync(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf-8");

      // stream-json lines each have a "type" field
      const lines = content.split("\n").filter((l) => l.trim());
      const jsonLines = lines.filter((l) => {
        try { JSON.parse(l); return true; } catch { return false; }
      });

      console.log(`  Total lines: ${lines.length}, JSON lines: ${jsonLines.length}`);
      expect(jsonLines.length).toBeGreaterThan(0);

      // At least one JSON line should be an assistant message with content
      const hasAssistantMsg = jsonLines.some((l) => {
        const obj = JSON.parse(l);
        return obj.type === "assistant" || obj.type === "result";
      });
      expect(hasAssistantMsg).toBe(true);
    },
  );
});
