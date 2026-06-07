// CORE-RETENTION
// Locks in: StreamTailer's file-polling behavior — reads new content
// from a tracked file position, invokes the callback for each new line,
// handles file-not-found gracefully, and resets position when the file
// shrinks (e.g., truncated by an external tool).
// Critical because: StreamTailer is used to tail log files from Worker
// child processes. A bug in position tracking would either miss lines
// (skip new content) or re-deliver old lines (duplicate output in TUI).
// Primary sources: packages/leader/src/stream-tailer.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StreamTailer } from "../src/stream-tailer.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tailer-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function waitPoll(): Promise<void> {
  // Default poll interval is 200ms; wait slightly longer.
  return new Promise((r) => setTimeout(r, 250));
}

describe("StreamTailer", () => {
  it("starts and stops cleanly", () => {
    const tailer = new StreamTailer(200);
    expect(tailer.isActive).toBe(false);

    tailer.start(join(stateDir, "log.txt"), () => {});
    expect(tailer.isActive).toBe(true);

    tailer.stop();
    expect(tailer.isActive).toBe(false);
  });

  it("detects new lines appended after start", async () => {
    const filePath = join(stateDir, "output.log");
    writeFileSync(filePath, "initial\n");

    const lines: string[] = [];
    const tailer = new StreamTailer(50);
    tailer.start(filePath, (line) => lines.push(line));

    await waitPoll();

    appendFileSync(filePath, "hello\n");
    await waitPoll();

    expect(lines).toContain("initial");
    expect(lines).toContain("hello");

    tailer.stop();
  });

  it("does not re-deliver already-read lines", async () => {
    const filePath = join(stateDir, "dedup.log");
    writeFileSync(filePath, "line1\nline2\n");

    const lines: string[] = [];
    const tailer = new StreamTailer(50);
    tailer.start(filePath, (line) => lines.push(line));

    await waitPoll();
    expect(lines).toEqual(["line1", "line2"]);

    // No new writes — callback should not fire again.
    await waitPoll();
    expect(lines).toEqual(["line1", "line2"]);

    tailer.stop();
  });

  it("handles file not found gracefully (no crash)", async () => {
    const filePath = join(stateDir, "nonexistent.log");
    const tailer = new StreamTailer(50);
    tailer.start(filePath, () => {});

    // Should not throw.
    await waitPoll();

    tailer.stop();
  });

  it("resets position when file shrinks", async () => {
    const filePath = join(stateDir, "shrink.log");
    writeFileSync(filePath, "original\n");

    const lines: string[] = [];
    const tailer = new StreamTailer(50);
    tailer.start(filePath, (line) => lines.push(line));

    await waitPoll();
    expect(lines).toContain("original");

    // Simulate truncation by overwriting with shorter content.
    writeFileSync(filePath, "short\n");
    await waitPoll();

    // The tailer should read the new content from position 0.
    expect(lines).toContain("short");

    tailer.stop();
  });

  it("stop() prevents further callbacks", async () => {
    const filePath = join(stateDir, "stop.log");
    writeFileSync(filePath, "before\n");

    const lines: string[] = [];
    const tailer = new StreamTailer(50);
    tailer.start(filePath, (line) => lines.push(line));

    await waitPoll();
    expect(lines).toContain("before");

    tailer.stop();
    lines.length = 0;

    appendFileSync(filePath, "after\n");
    await waitPoll();

    // No new lines delivered after stop.
    expect(lines).toHaveLength(0);
  });
});
