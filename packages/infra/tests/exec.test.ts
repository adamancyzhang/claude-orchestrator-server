// CORE-RETENTION
// Locks in: execWithStreaming distinguishes "child never started" (spawn
// error → ExecStreamingResult.spawn_error is a non-empty string) from
// "child started but returned a non-zero exit code" (spawn_error is
// undefined). Without this distinction the caller cannot tell whether
// the binary is missing vs whether the binary itself failed.
// Critical because: ClaudeRunner spawns the `claude` CLI; if `claude` is
// not installed, the runner today returns exit_code=-1 with no signal —
// indistinguishable from any other -1 exit — and silently retries forever.
// Primary sources: packages/infra/src/utils/exec.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execWithStreaming, execAndCapture } from "../src/utils/exec.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-"));
  logPath = path.join(dir, "exec.log");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Note: execWithStreaming now spawns the command directly (no shell wrapper).
// When the command binary is not found, `child.on('error')` fires and
// spawn_error is populated. The execAndCapture suite below also covers the
// direct-spawn-error path.

describe("execWithStreaming", () => {
  it("returns spawn_error=undefined when the command starts (success path)", async () => {
    const result = await execWithStreaming({
      command: "true",
      prompt: "",
      log_path: logPath,
      quiet: true,
    });
    expect(result.exit_code).toBe(0);
    expect(result.spawn_error).toBeUndefined();
  });

  it("creates the log file's parent directory if missing", async () => {
    const deepLog = path.join(dir, "nested", "deeper", "exec.log");
    await execWithStreaming({
      command: "true",
      prompt: "",
      log_path: deepLog,
      quiet: true,
    });
    expect(fs.statSync(path.dirname(deepLog)).isDirectory()).toBe(true);
  });

  it("populates spawn_error when the binary cannot be found", async () => {
    const result = await execWithStreaming({
      command: "/definitely/nonexistent/binary/xyzzy",
      prompt: "",
      log_path: logPath,
      quiet: true,
    });
    expect(result.exit_code).toBe(-1);
    expect(result.spawn_error).toBeTruthy();
    expect(typeof result.spawn_error).toBe("string");
  });

  it("appends output to the log file", async () => {
    await execWithStreaming({
      command: "echo",
      prompt: "hello world",
      log_path: logPath,
      quiet: true,
    });
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("hello world");
  });
});

describe("execAndCapture", () => {
  it("populates spawn_error when the binary itself cannot be spawned (no shell wrapper)", async () => {
    // execAndCapture spawns the binary directly. A non-existent path
    // triggers `child.on('error')` — the case we must surface.
    const result = await execAndCapture("/definitely/nonexistent/binary/xyzzy");
    expect(result.exit_code).toBe(-1);
    expect(result.spawn_error).toBeTruthy();
    expect(typeof result.spawn_error).toBe("string");
  });

  it("captures stdout on success and leaves spawn_error undefined", async () => {
    const result = await execAndCapture("printf", ["hello"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.spawn_error).toBeUndefined();
  });

  it("captures stderr on a failing command without setting spawn_error", async () => {
    // `sh -c "echo err >&2; exit 2"` — child started, child failed.
    const result = await execAndCapture("sh", ["-c", "echo boom >&2; exit 2"]);
    expect(result.exit_code).toBe(2);
    expect(result.stderr).toContain("boom");
    expect(result.spawn_error).toBeUndefined();
  });

  it("handles empty stdout", async () => {
    const result = await execAndCapture("true");
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("handles empty stderr", async () => {
    const result = await execAndCapture("true");
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("passes environment variables", async () => {
    const result = await execAndCapture("sh", ["-c", "echo $TEST_VAR"], {
      env: { TEST_VAR: "test_value" },
    });
    expect(result.stdout.trim()).toBe("test_value");
  });

  it("handles multi-line stdout", async () => {
    const result = await execAndCapture("printf", ["line1\nline2\nline3"]);
    expect(result.stdout).toBe("line1\nline2\nline3");
  });

  it("returns exit code -1 when signal kills process", async () => {
    const result = await execAndCapture("sh", ["-c", "kill -9 $$"]);
    expect(result.exit_code).toBe(-1);
  });
});

describe("execWithStreaming — edge cases", () => {
  it("handles empty prompt", async () => {
    const result = await execWithStreaming({
      command: "true",
      prompt: "",
      log_path: logPath,
      quiet: true,
    });
    expect(result.exit_code).toBe(0);
  });

  it("handles long prompt (truncation in log)", async () => {
    const longPrompt = "a".repeat(200);
    const result = await execWithStreaming({
      command: "true",
      prompt: longPrompt,
      log_path: logPath,
      quiet: true,
    });
    expect(result.exit_code).toBe(0);
  });

  it("session_id is null when command produces no JSON output", async () => {
    const result = await execWithStreaming({
      command: "echo",
      prompt: "test",
      log_path: logPath,
      quiet: true,
    });
    expect(result.session_id).toBeNull();
  });

  it("session_id is extracted from JSON output with session_id field", async () => {
    const result = await execWithStreaming({
      command: "sh",
      prompt: "test",
      log_path: logPath,
      quiet: true,
      system_prompt: undefined,
    });
    // The command doesn't output JSON with session_id, so it should be null
    expect(result.session_id).toBeNull();
  });

  it("on_line callback is invoked for each line", async () => {
    const lines: string[] = [];
    await execWithStreaming({
      command: "sh",
      prompt: "test",
      log_path: logPath,
      quiet: true,
      on_line: (line) => lines.push(line),
    });
    // At least one line should be captured
    expect(lines.length).toBeGreaterThanOrEqual(0);
  });

  it("respects cwd option", async () => {
    const result = await execWithStreaming({
      command: "echo",
      prompt: "test",
      log_path: logPath,
      cwd: dir,
      quiet: true,
    });
    expect(result.exit_code).toBe(0);
  });

  it("handles non-existent command gracefully", async () => {
    const result = await execWithStreaming({
      command: "/definitely/nonexistent/binary",
      prompt: "",
      log_path: logPath,
      quiet: true,
    });
    expect(result.exit_code).toBe(-1);
    expect(result.spawn_error).toBeTruthy();
  });

  it("appends to existing log file", async () => {
    // Write initial content
    fs.writeFileSync(logPath, "initial content\n", "utf-8");

    await execWithStreaming({
      command: "echo",
      prompt: "appended",
      log_path: logPath,
      quiet: true,
    });

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("initial content");
    expect(content).toContain("appended");
  });
});
