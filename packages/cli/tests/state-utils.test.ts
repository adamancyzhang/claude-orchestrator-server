// CORE-RETENTION
// Locks in: readState reads and validates state.json — accepts version 1,
// rejects other versions, throws when the file is missing. getStateDir
// returns the custom path when provided, falls back to the default.
// Critical because: CLI state inspection commands depend entirely on
// readState. A broken readState means every `status`, `workers`, `tasks`,
// `events`, `messages`, and `wait` command fails silently or crashes.
// Primary sources: packages/cli/src/state-utils.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readState, getStateDir } from "../src/state-utils.js";
import type { StateData } from "../src/state-utils.js";

function makeState(overrides: Partial<StateData> = {}): StateData {
  return {
    version: 1,
    workers: [],
    pending_tasks: [],
    in_progress_tasks: [],
    events: [],
    ...overrides,
  };
}

describe("readState", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cli-test-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns parsed state when file exists and version is 1", () => {
    const state = makeState({
      workers: [
        {
          id: "w-1",
          name: "Worker1",
          status: "idle",
          current_task_id: null,
          current_role: null,
          worktree_name: null,
          message_history: [],
          activity_history: [],
        },
      ],
    });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));

    const result = readState(stateDir);
    expect(result.version).toBe(1);
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0].id).toBe("w-1");
  });

  it("throws when state.json does not exist", () => {
    expect(() => readState(stateDir)).toThrow("State file not found");
  });

  it("rejects version !== 1", () => {
    const state = makeState({ version: 2 });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));

    expect(() => readState(stateDir)).toThrow("Unsupported state version: 2");
  });

  it("rejects version 0", () => {
    const state = makeState({ version: 0 });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));

    expect(() => readState(stateDir)).toThrow("Unsupported state version: 0");
  });

  it("throws on malformed JSON", () => {
    writeFileSync(join(stateDir, "state.json"), "{invalid json");

    expect(() => readState(stateDir)).toThrow();
  });

  it("returns full state with pending and in-progress tasks", () => {
    const state = makeState({
      pending_tasks: [
        { id: "t-1", description: "Do thing", status: "pending", link: null },
      ],
      in_progress_tasks: [
        {
          id: "t-2",
          description: "Doing thing",
          status: "in_progress",
          claimed_by: "w-1",
          link: "execute",
        },
      ],
      events: [
        { type: "task_created", timestamp: "2026-01-01T00:00:00Z", task_id: "t-1" },
      ],
    });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));

    const result = readState(stateDir);
    expect(result.pending_tasks).toHaveLength(1);
    expect(result.in_progress_tasks).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });
});

describe("getStateDir", () => {
  it("returns the provided stateDir when set", () => {
    expect(getStateDir({ stateDir: "/custom/path" })).toBe("/custom/path");
  });

  it("returns default path when stateDir is undefined", () => {
    const result = getStateDir({});
    expect(result).toContain(".claude-orchestrator");
    expect(result).toContain("state");
  });
});
