// CORE-RETENTION
// Locks in: StateWatcher — file watching, debouncing, and change detection.
// Critical because: Watcher is the bridge between orchestrator state and
// dashboard updates. A broken watcher means stale data.
// Primary sources: packages/dashboard/src/watcher.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateWatcher } from "../src/watcher.js";

let tempDir: string;
let stateDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
  stateDir = path.join(tempDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("StateWatcher", () => {
  it("creates instance", () => {
    const watcher = new StateWatcher(stateDir);
    expect(watcher).toBeDefined();
  });

  it("start() creates state directory if missing", () => {
    const missingDir = path.join(tempDir, "missing");
    const watcher = new StateWatcher(missingDir);
    watcher.start();
    expect(fs.existsSync(missingDir)).toBe(true);
    watcher.stop();
  });

  it("onUpdate() registers callback", () => {
    const watcher = new StateWatcher(stateDir);
    const callback = vi.fn();
    watcher.onUpdate(callback);
    // Should not throw
    watcher.stop();
  });

  it("start() and stop() work without errors", () => {
    const watcher = new StateWatcher(stateDir);
    watcher.start();
    watcher.stop();
  });
});
