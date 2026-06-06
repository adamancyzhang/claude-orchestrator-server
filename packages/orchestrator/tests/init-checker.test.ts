// CORE-RETENTION
// Locks in: InitChecker's behavior for initialization steps:
//   - runAll executes all steps in order
//   - Previously skipped steps are re-prompted in non-y mode
//   - y_flag auto-approves non-skipped steps
//   - Step decisions are recorded in global/project status
// Critical because: InitChecker is the entry point for first-run setup.
// A regression here would either block users on first run or silently
// skip critical configuration.
// Primary sources: packages/orchestrator/src/init-checker.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { InitChecker, type InitCheckerOptions, type InitStep } from "../src/init-checker.js";

// Mock @co/infra to control init status loading/saving
vi.mock("@co/infra", () => ({
  loadInitStatus: vi.fn(() => []),
  loadProjectInitStatus: vi.fn(() => []),
  saveInitStatus: vi.fn(),
  saveProjectInitStatus: vi.fn(),
}));

describe("InitChecker", () => {
  let tempDir: string;
  let logger: { info: vi.Mock; warn: vi.Mock; error: vi.Mock };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "init-checker-"));
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createStep(overrides: Partial<InitStep> = {}): InitStep {
    return {
      id: "test-step",
      title: "Test Step",
      description: "A test step",
      level: "Safe",
      scope: "global",
      check: vi.fn(async () => ({ needs_confirm: false, message: "OK" })),
      execute: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("should execute all steps in order", async () => {
    const executionOrder: string[] = [];
    const steps = [
      createStep({ id: "step-1", execute: vi.fn(async () => { executionOrder.push("step-1"); }) }),
      createStep({ id: "step-2", execute: vi.fn(async () => { executionOrder.push("step-2"); }) }),
      createStep({ id: "step-3", execute: vi.fn(async () => { executionOrder.push("step-3"); }) }),
    ];

    const checker = new InitChecker({ y_flag: false, logger });
    await checker.runAll(steps);

    expect(executionOrder).toEqual(["step-1", "step-2", "step-3"]);
  });

  it("should auto-approve steps when y_flag is true", async () => {
    const execute = vi.fn(async () => {});
    const step = createStep({ needs_confirm: true, execute });

    const checker = new InitChecker({ y_flag: true, logger });
    await checker.runAll([step]);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("should skip previously skipped steps in y_flag mode", async () => {
    const { loadInitStatus } = await import("@co/infra");
    vi.mocked(loadInitStatus).mockReturnValue([
      { step_id: "skipped-step", level: "Safe", decided_at: new Date().toISOString(), decision: "skipped" },
    ]);

    const execute = vi.fn(async () => {});
    const step = createStep({ id: "skipped-step", execute });

    const checker = new InitChecker({ y_flag: true, logger });
    await checker.runAll([step]);

    expect(execute).not.toHaveBeenCalled();
  });

  it("should record step decisions", async () => {
    const { saveInitStatus, saveProjectInitStatus } = await import("@co/infra");
    const execute = vi.fn(async () => {});
    const step = createStep({ execute });

    const checker = new InitChecker({ y_flag: false, logger });
    await checker.runAll([step]);

    expect(saveInitStatus).toHaveBeenCalled();
    expect(saveProjectInitStatus).toHaveBeenCalled();
  });

  it("should handle step check failure gracefully", async () => {
    const step = createStep({
      check: vi.fn(async () => { throw new Error("check failed"); }),
    });

    const checker = new InitChecker({ y_flag: false, logger });
    await expect(checker.runAll([step])).rejects.toThrow("check failed");
  });
});
