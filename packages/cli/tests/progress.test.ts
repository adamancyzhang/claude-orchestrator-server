// CORE-RETENTION
// Locks in: ProgressIndicator lifecycle — start/stop, TTY vs non-TTY
// behavior, message updates, and disabled mode.
// Critical because: Progress indicator is the primary user feedback
// mechanism during long-running operations. A broken indicator means
// users see no feedback or broken terminal output.
// Primary sources: packages/cli/src/progress.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ProgressIndicator, createProgress } from "../src/progress.js";

describe("ProgressIndicator", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    vi.useRealTimers();
    stdoutWriteSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("creates instance with default options", () => {
    const indicator = new ProgressIndicator({ message: "test" });
    expect(indicator).toBeDefined();
    expect(indicator.isRunningIndicator()).toBe(false);
  });

  it("start() begins the indicator", () => {
    const indicator = new ProgressIndicator({ message: "test" });
    indicator.start();
    expect(indicator.isRunningIndicator()).toBe(true);
    indicator.stop();
  });

  it("stop() ends the indicator", () => {
    const indicator = new ProgressIndicator({ message: "test" });
    indicator.start();
    indicator.stop();
    expect(indicator.isRunningIndicator()).toBe(false);
  });

  it("stop() is idempotent", () => {
    const indicator = new ProgressIndicator({ message: "test" });
    indicator.start();
    indicator.stop();
    indicator.stop(); // Should not throw
    expect(indicator.isRunningIndicator()).toBe(false);
  });

  it("disabled indicator does not start", () => {
    const indicator = new ProgressIndicator({ message: "test", disabled: true });
    indicator.start();
    expect(indicator.isRunningIndicator()).toBe(false);
    indicator.stop();
  });

  it("updateMessage() changes the displayed message", () => {
    const indicator = new ProgressIndicator({ message: "initial" });
    indicator.updateMessage("updated");
    indicator.start();
    // Just verify it doesn't throw
    indicator.stop();
  });

  it("TTY mode writes spinner frames", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const indicator = new ProgressIndicator({ message: "loading" });
    indicator.start();

    // Wait for at least one frame
    vi.advanceTimersByTime(100);

    expect(stdoutWriteSpy).toHaveBeenCalled();
    indicator.stop();
  });

  it("non-TTY mode writes dots", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const indicator = new ProgressIndicator({ message: "loading" });
    indicator.start();

    // Wait for dot interval
    vi.advanceTimersByTime(600);

    expect(stdoutWriteSpy).toHaveBeenCalled();
    indicator.stop();
  });

  it("stop() clears the line in TTY mode", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const indicator = new ProgressIndicator({ message: "test" });
    indicator.start();
    vi.advanceTimersByTime(100);
    indicator.stop();

    // Should have written carriage return to clear line
    const calls = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes("\r"))).toBe(true);
  });

  it("stop() with completeMessage prints final message", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const indicator = new ProgressIndicator({ message: "test" });
    indicator.start();
    vi.advanceTimersByTime(100);
    indicator.stop("Done!");

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join("");
    expect(output).toContain("Done!");

    consoleSpy.mockRestore();
  });
});

describe("createProgress", () => {
  it("creates a ProgressIndicator instance", () => {
    const indicator = createProgress("test message");
    expect(indicator).toBeInstanceOf(ProgressIndicator);
  });

  it("passes disabled option", () => {
    const indicator = createProgress("test", true);
    indicator.start();
    expect(indicator.isRunningIndicator()).toBe(false);
    indicator.stop();
  });

  it("disabled option defaults to false", () => {
    const indicator = createProgress("test");
    indicator.start();
    expect(indicator.isRunningIndicator()).toBe(true);
    indicator.stop();
  });
});

describe("ProgressIndicator — edge cases", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    vi.useRealTimers();
    stdoutWriteSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("multiple start/stop cycles work correctly", () => {
    const indicator = new ProgressIndicator({ message: "test" });

    indicator.start();
    expect(indicator.isRunningIndicator()).toBe(true);
    indicator.stop();
    expect(indicator.isRunningIndicator()).toBe(false);

    indicator.start();
    expect(indicator.isRunningIndicator()).toBe(true);
    indicator.stop();
    expect(indicator.isRunningIndicator()).toBe(false);
  });

  it("updateMessage during operation doesn't break", () => {
    const indicator = new ProgressIndicator({ message: "initial" });
    indicator.start();
    indicator.updateMessage("updated");
    vi.advanceTimersByTime(100);
    indicator.updateMessage("final");
    indicator.stop();
    expect(indicator.isRunningIndicator()).toBe(false);
  });

  it("elapsed time is displayed in TTY mode", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const indicator = new ProgressIndicator({ message: "loading" });
    indicator.start();
    vi.advanceTimersByTime(1500); // 1.5 seconds
    indicator.stop();

    const calls = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
    // Should contain elapsed time in seconds
    expect(calls.some(c => c.includes("1."))).toBe(true);
  });

  it("non-TTY mode writes newlines for each dot update", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const indicator = new ProgressIndicator({ message: "loading" });
    indicator.start();
    vi.advanceTimersByTime(1600); // Multiple dot intervals
    indicator.stop();

    const calls = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
    // Should have multiple writes with newlines
    expect(calls.filter(c => c.includes("\n")).length).toBeGreaterThan(1);
  });

  it("stop() without start() is a no-op", () => {
    const indicator = new ProgressIndicator({ message: "test" });
    // Don't start, just stop
    indicator.stop();
    expect(indicator.isRunningIndicator()).toBe(false);
  });

  it("empty message works", () => {
    const indicator = new ProgressIndicator({ message: "" });
    indicator.start();
    vi.advanceTimersByTime(100);
    indicator.stop();
    expect(indicator.isRunningIndicator()).toBe(false);
  });

  it("special characters in message work", () => {
    const indicator = new ProgressIndicator({ message: "Loading [1/3] 50%..." });
    indicator.start();
    vi.advanceTimersByTime(100);
    indicator.stop();
    expect(indicator.isRunningIndicator()).toBe(false);
  });
});
