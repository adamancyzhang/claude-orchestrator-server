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

// Note: execWithStreaming wraps the command in `sh -c "exec ..."`. Since `sh`
// is always available, `child.on('error')` is unreachable through that path;
// the command-not-found case is delivered as a non-zero exit code from the
// shell. The execAndCapture suite below covers the direct-spawn-error path
// where spawn_error must be populated.

describe("execWithStreaming", () => {
  it("returns spawn_error=undefined when the shell wrapper itself starts (success path)", async () => {
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
});
