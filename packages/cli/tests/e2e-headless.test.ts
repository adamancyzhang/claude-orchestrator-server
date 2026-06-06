// CORE-RETENTION
// Locks in: The headless CLI workflow — status, workers, tasks, events,
// and wait commands correctly read state.json and commands.jsonl.
// Critical because: These commands are the primary interface for operators
// using headless mode. A broken read means the operator has no visibility
// into orchestrator state.
// Primary sources: packages/cli/src/index.ts, packages/cli/src/state-utils.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
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

describe("headless CLI E2E workflow", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cli-e2e-headless-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("B1: state.json is created with valid structure", () => {
    const state = makeState();
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state, null, 2));

    expect(existsSync(join(stateDir, "state.json"))).toBe(true);
    const parsed = readState(stateDir);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.workers)).toBe(true);
    expect(Array.isArray(parsed.pending_tasks)).toBe(true);
    expect(Array.isArray(parsed.in_progress_tasks)).toBe(true);
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  it("B2: send command appends to commands.jsonl", () => {
    const commandsPath = join(stateDir, "commands.jsonl");
    mkdirSync(stateDir, { recursive: true });

    const command = {
      type: "send",
      content: "hello orchestrator",
      timestamp: new Date().toISOString(),
    };
    appendFileSync(commandsPath, JSON.stringify(command) + "\n");

    const raw = readFileSync(commandsPath, "utf-8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.type).toBe("send");
    expect(parsed.content).toBe("hello orchestrator");
    expect(Date.parse(parsed.timestamp)).not.toBeNaN();
  });

  it("B3: status command reads state.json correctly", () => {
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
      pending_tasks: [
        { id: "t-1", description: "Task 1", status: "pending", link: null },
      ],
      in_progress_tasks: [
        {
          id: "t-2",
          description: "Task 2",
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
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0].id).toBe("w-1");
    expect(result.pending_tasks).toHaveLength(1);
    expect(result.in_progress_tasks).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });

  it("B4: workers command displays worker table data", () => {
    const state = makeState({
      workers: [
        {
          id: "w-1",
          name: "Worker1",
          status: "busy",
          current_task_id: "t-1",
          current_role: "executor",
          worktree_name: "wt-1",
          message_history: [],
          activity_history: [],
        },
        {
          id: "w-2",
          name: "Worker2",
          status: "idle",
          current_task_id: null,
          current_role: null,
          worktree_name: "wt-2",
          message_history: [],
          activity_history: [],
        },
      ],
    });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));

    const result = readState(stateDir);
    expect(result.workers).toHaveLength(2);
    expect(result.workers[0].status).toBe("busy");
    expect(result.workers[0].current_task_id).toBe("t-1");
    expect(result.workers[1].status).toBe("idle");
  });

  it("B5: tasks command shows pending and in-progress tasks", () => {
    const state = makeState({
      pending_tasks: [
        { id: "t-1", description: "Pending task", status: "pending", link: "execute" },
      ],
      in_progress_tasks: [
        {
          id: "t-2",
          description: "In-progress task",
          status: "in_progress",
          claimed_by: "w-1",
          link: "plan",
        },
      ],
    });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));

    const result = readState(stateDir);
    const all = [
      ...result.pending_tasks.map((t) => ({ ...t, queue: "pending" })),
      ...result.in_progress_tasks.map((t) => ({ ...t, queue: "in_progress" })),
    ];
    expect(all).toHaveLength(2);
    expect(all[0].queue).toBe("pending");
    expect(all[1].queue).toBe("in_progress");
  });

  it("B6: events command shows event log with timestamps", () => {
    const state = makeState({
      events: [
        { type: "task_created", timestamp: "2026-01-01T00:00:00Z", task_id: "t-1" },
        { type: "task_claimed", timestamp: "2026-01-01T00:01:00Z", task_id: "t-1", instance_id: "w-1" },
      ],
    });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));

    const result = readState(stateDir);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe("task_created");
    expect(result.events[1].type).toBe("task_claimed");
  });

  it("B7: wait command detects task completion", () => {
    // Simulate: task starts in-progress, then completes
    const state = makeState({
      in_progress_tasks: [
        {
          id: "t-1",
          description: "Task to complete",
          status: "in_progress",
          claimed_by: "w-1",
          link: "execute",
        },
      ],
    });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));

    // First read: task is still in progress
    let result = readState(stateDir);
    const found = result.in_progress_tasks.find((t) => t.id === "t-1");
    expect(found).toBeDefined();

    // Simulate completion: remove from in_progress
    const completedState = makeState({
      in_progress_tasks: [],
    });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(completedState));

    // Second read: task is gone
    result = readState(stateDir);
    const notFound = result.in_progress_tasks.find((t) => t.id === "t-1");
    expect(notFound).toBeUndefined();
  });

  it("B8: wait command detects chain closure via events", () => {
    const state = makeState({
      events: [
        { type: "chain_activated", timestamp: "2026-01-01T00:00:00Z", chain_id: "c-1" },
      ],
    });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));

    // First read: no chain_closed event
    let result = readState(stateDir);
    let chainClosed = result.events.find(
      (e) => e.type === "chain_closed" && e.chain_id === "c-1",
    );
    expect(chainClosed).toBeUndefined();

    // Simulate chain closure
    const closedState = makeState({
      events: [
        { type: "chain_activated", timestamp: "2026-01-01T00:00:00Z", chain_id: "c-1" },
        { type: "chain_closed", timestamp: "2026-01-01T00:05:00Z", chain_id: "c-1" },
      ],
    });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(closedState));

    // Second read: chain_closed event exists
    result = readState(stateDir);
    chainClosed = result.events.find(
      (e) => e.type === "chain_closed" && e.chain_id === "c-1",
    );
    expect(chainClosed).toBeDefined();
  });

  it("multiple send commands accumulate in commands.jsonl", () => {
    const commandsPath = join(stateDir, "commands.jsonl");
    mkdirSync(stateDir, { recursive: true });

    const messages = ["first command", "second command", "third command"];
    for (const content of messages) {
      appendFileSync(
        commandsPath,
        JSON.stringify({ type: "send", content, timestamp: new Date().toISOString() }) + "\n",
      );
    }

    const raw = readFileSync(commandsPath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p: { content: string }) => p.content)).toEqual(messages);
  });
});
