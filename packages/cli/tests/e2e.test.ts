// CORE-RETENTION
// Locks in: CLI E2E integration — command parsing, state file handling,
// and end-to-end user flows for all state inspection commands.
// Critical because: CLI is the primary user interface. A broken command
// means users cannot inspect or interact with the orchestrator.
// Primary sources: packages/cli/src/index.ts, packages/cli/src/state-utils.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readState, getStateDir, type StateData } from "../src/state-utils.js";

// Mock dependencies
vi.mock("@co/infra", () => ({
  loadConfig: vi.fn(() => ({
    zk: { hosts: "127.0.0.1:2181", session_timeout_ms: 30000 },
    projects_root: "/tmp/projects",
    commands: { claude_cli: "claude", git: "git" },
    hooks: [],
    init_status: [],
    instance_id: null,
    name: null,
    role: null,
    debug: false,
    git: { remote: "origin", merge_target_branch: null, auto_commit_init_files: true, auto_commit_init_files_branch: null },
  })),
  output: vi.fn(),
}));

vi.mock("@co/orchestrator", () => ({
  runOrchestrator: vi.fn(async () => {}),
}));

vi.mock("@co/contracts", () => ({
  PROTOCOL_VERSION: 1,
}));

let tempDir: string;
let stateDir: string;
let originalCwd: () => string;

function createMockState(overrides: Partial<StateData> = {}): StateData {
  return {
    version: 1,
    workers: [],
    pending_tasks: [],
    in_progress_tasks: [],
    events: [],
    ...overrides,
  };
}

function writeState(state: StateData): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify(state),
    "utf-8",
  );
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-e2e-"));
  stateDir = path.join(tempDir, "state");
  originalCwd = process.cwd;
  process.cwd = () => tempDir;
});

afterEach(() => {
  process.cwd = originalCwd;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("CLI — state-utils", () => {
  it("readState returns valid state data", () => {
    const state = createMockState({ version: 1 });
    writeState(state);
    const loaded = readState(stateDir);
    expect(loaded.version).toBe(1);
    expect(loaded.workers).toEqual([]);
  });

  it("readState throws when state file does not exist", () => {
    expect(() => {
      readState(path.join(tempDir, "nonexistent"));
    }).toThrow("State file not found");
  });

  it("readState throws when state version is unsupported", () => {
    writeState({ version: 999, workers: [], pending_tasks: [], in_progress_tasks: [], events: [] } as any);
    expect(() => {
      readState(stateDir);
    }).toThrow("Unsupported state version");
  });

  it("getStateDir returns default when no option provided", () => {
    expect(getStateDir({})).toContain(".claude-orchestrator");
  });

  it("getStateDir returns custom dir when provided", () => {
    expect(getStateDir({ stateDir: "/custom/path" })).toBe("/custom/path");
  });
});

describe("CLI — state data structures", () => {
  it("state with workers", () => {
    const state = createMockState({
      workers: [
        {
          id: "w1",
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
    writeState(state);
    expect(state.workers).toHaveLength(1);
    expect(state.workers[0].name).toBe("Worker1");
  });

  it("state with pending tasks", () => {
    const state = createMockState({
      pending_tasks: [
        {
          id: "t1",
          description: "Test task",
          status: "pending",
          link: "plan",
          chain_id: null,
          assigned_to: null,
          assigned_to_name: null,
        },
      ],
    });
    writeState(state);
    expect(state.pending_tasks).toHaveLength(1);
    expect(state.pending_tasks[0].description).toBe("Test task");
  });

  it("state with in_progress tasks", () => {
    const state = createMockState({
      in_progress_tasks: [
        {
          id: "t2",
          description: "Active task",
          status: "in_progress",
          claimed_by: "w1",
          link: "execute",
          chain_id: "chain-1",
          assigned_to: "w1",
          assigned_to_name: "Worker1",
        },
      ],
    });
    writeState(state);
    expect(state.in_progress_tasks).toHaveLength(1);
    expect(state.in_progress_tasks[0].claimed_by).toBe("w1");
  });

  it("state with events", () => {
    const state = createMockState({
      events: [
        {
          type: "chain_activated",
          timestamp: "2026-06-06T12:00:00Z",
          chain_id: "chain-1",
        },
      ],
    });
    writeState(state);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].type).toBe("chain_activated");
  });

  it("state with workers having message history", () => {
    const state = createMockState({
      workers: [
        {
          id: "w1",
          name: "Worker1",
          status: "busy",
          current_task_id: "t1",
          current_role: "executor",
          worktree_name: "wt-1",
          message_history: [
            {
              message_id: "m1",
              content: "Hello from worker",
              link: "plan",
              timestamp: "2026-06-06T12:00:00Z",
            },
          ],
          activity_history: [],
        },
      ],
    });
    writeState(state);
    expect(state.workers[0].message_history).toHaveLength(1);
    expect(state.workers[0].message_history[0].content).toBe("Hello from worker");
  });

  it("state with workers having activity history", () => {
    const state = createMockState({
      workers: [
        {
          id: "w1",
          name: "Worker1",
          status: "idle",
          current_task_id: null,
          current_role: null,
          worktree_name: null,
          message_history: [],
          activity_history: [
            {
              phase: "setup",
              action: "initialize",
              detail: "Worker started",
              timestamp: "2026-06-06T12:00:00Z",
            },
          ],
        },
      ],
    });
    writeState(state);
    expect(state.workers[0].activity_history).toHaveLength(1);
    expect(state.workers[0].activity_history[0].phase).toBe("setup");
  });
});

describe("CLI — command integration", () => {
  it("state file round-trips correctly", () => {
    const original = createMockState({
      workers: [
        {
          id: "w1",
          name: "Worker1",
          status: "idle",
          current_task_id: null,
          current_role: null,
          worktree_name: null,
          message_history: [],
          activity_history: [],
        },
      ],
      pending_tasks: [
        {
          id: "t1",
          description: "Task 1",
          status: "pending",
          link: null,
          chain_id: "chain-1",
          assigned_to: null,
          assigned_to_name: null,
        },
      ],
    });
    writeState(original);
    const loaded = readState(stateDir);
    expect(loaded).toEqual(original);
  });

  it("empty state file is valid", () => {
    writeState(createMockState());
    const loaded = readState(stateDir);
    expect(loaded.workers).toEqual([]);
    expect(loaded.pending_tasks).toEqual([]);
    expect(loaded.in_progress_tasks).toEqual([]);
    expect(loaded.events).toEqual([]);
  });

  it("state with multiple chain events", () => {
    const state = createMockState({
      events: [
        { type: "chain_activated", timestamp: "2026-06-06T12:00:00Z", chain_id: "c1" },
        { type: "chain_activated", timestamp: "2026-06-06T12:01:00Z", chain_id: "c2" },
        { type: "chain_closed", timestamp: "2026-06-06T12:02:00Z", chain_id: "c1" },
      ],
    });
    writeState(state);
    const loaded = readState(stateDir);
    expect(loaded.events).toHaveLength(3);
  });

  it("state with chain_spawned events", () => {
    const state = createMockState({
      events: [
        {
          type: "chain_spawned",
          timestamp: "2026-06-06T12:00:00Z",
          parent_chain_id: "p1",
          child_chain_id: "c1",
          chain_depth: 1,
        },
      ],
    });
    writeState(state);
    const loaded = readState(stateDir);
    expect(loaded.events[0]).toMatchObject({
      type: "chain_spawned",
      parent_chain_id: "p1",
      child_chain_id: "c1",
      chain_depth: 1,
    });
  });

  it("state with merge_failed events", () => {
    const state = createMockState({
      events: [
        { type: "chain_merge_failed", timestamp: "2026-06-06T12:00:00Z", chain_id: "c1" },
      ],
    });
    writeState(state);
    const loaded = readState(stateDir);
    expect(loaded.events[0].type).toBe("chain_merge_failed");
  });
});

describe("CLI — edge cases", () => {
  it("state file with invalid JSON throws", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), "not json", "utf-8");
    expect(() => {
      readState(stateDir);
    }).toThrow();
  });

  it("state file with missing version field throws", () => {
    writeState({ workers: [], pending_tasks: [], in_progress_tasks: [], events: [] } as any);
    expect(() => {
      readState(stateDir);
    }).toThrow("Unsupported state version");
  });

  it("getStateDir handles path with trailing slash", () => {
    expect(getStateDir({ stateDir: "/path/to/dir/" })).toBe("/path/to/dir/");
  });

  it("getStateDir handles relative path", () => {
    expect(getStateDir({ stateDir: "relative/path" })).toBe("relative/path");
  });
});
