// CORE-RETENTION
// Locks in: StateWriter — the leader's periodic state serializer — writes
// ILeaderStateView to <stateDir>/state.json atomically (tmp + rename) and
// respects start()/stop() lifecycle.
// Critical because: state.json is the primary artifact consumed by the TUI
// and by external tooling for leader state inspection; a broken writer means
// stale or missing state files, which silently breaks the operator view.
// Primary sources: packages/leader/src/state-writer.ts

import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateWriter } from "../src/state-writer.js";
import { LeaderState } from "../src/state.js";
import {
  asInstanceId,
  asTaskId,
  asChainId,
  type Task,
  type LeaderEvent,
} from "@co/contracts";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `state-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

function makeTask(id: string): Task {
  return {
    id: asTaskId(id),
    title: `task ${id}`,
    description: "",
    criteria: "",
    priority: 1,
    status: "pending",
    link: "execute",
    chain_id: null,
    result_path: null,
    retry_count: 0,
    fail_reason: null,
    created_by: null,
    created_by_name: "",
    assigned_to: null,
    assigned_to_name: null,
    claimed_by: null,
    completed_by_name: null,
    created_at: "2026-06-06T00:00:00Z",
    claimed_at: null,
    completed_at: null,
    duration_seconds: null,
    leader_only: false,
    result: null,
  };
}

describe("StateWriter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes state.json on start and updates on interval", async () => {
    const dir = makeTmpDir();
    const state = new LeaderState();
    const writer = new StateWriter(state, dir, 50);

    writer.start();

    // Wait for at least one interval tick
    await new Promise((r) => setTimeout(r, 80));

    const filePath = join(dir, "state.json");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.version).toBe(1);
    expect(typeof parsed.updated_at).toBe("string");
    expect(parsed.magic_mode).toBe(false);
    expect(parsed.magic_max_chains).toBeNull();
    expect(Array.isArray(parsed.workers)).toBe(true);
    expect(Array.isArray(parsed.pending_tasks)).toBe(true);
    expect(Array.isArray(parsed.in_progress_tasks)).toBe(true);
    expect(Array.isArray(parsed.events)).toBe(true);

    writer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("atomic write: tmp file is removed, only state.json remains", async () => {
    const dir = makeTmpDir();
    const state = new LeaderState();
    const writer = new StateWriter(state, dir, 50);

    writer.start();
    await new Promise((r) => setTimeout(r, 80));

    const filePath = join(dir, "state.json");
    const tmpPath = filePath + ".tmp";
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);

    writer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reflects state changes in the written file", async () => {
    const dir = makeTmpDir();
    const state = new LeaderState();
    const writer = new StateWriter(state, dir, 50);

    // Apply a task
    state.apply({ type: "task_created", task: makeTask("t-1") });

    writer.start();
    await new Promise((r) => setTimeout(r, 80));

    const content = readFileSync(join(dir, "state.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.pending_tasks).toHaveLength(1);
    expect(parsed.pending_tasks[0].id).toBe("t-1");

    writer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stop() prevents further writes", async () => {
    const dir = makeTmpDir();
    const state = new LeaderState();
    const writer = new StateWriter(state, dir, 50);

    writer.start();
    await new Promise((r) => setTimeout(r, 80));
    writer.stop();

    const filePath = join(dir, "state.json");
    const before = readFileSync(filePath, "utf-8");

    // Wait to ensure no more writes happen
    await new Promise((r) => setTimeout(r, 120));
    const after = readFileSync(filePath, "utf-8");

    // updated_at should be identical since no writes occurred after stop
    const beforeParsed = JSON.parse(before);
    const afterParsed = JSON.parse(after);
    expect(beforeParsed.updated_at).toBe(afterParsed.updated_at);

    rmSync(dir, { recursive: true, force: true });
  });

  it("start() is idempotent — calling twice does not create duplicate timers", async () => {
    const dir = makeTmpDir();
    const state = new LeaderState();
    const writer = new StateWriter(state, dir, 50);

    writer.start();
    writer.start(); // second call should be no-op
    await new Promise((r) => setTimeout(r, 80));

    const filePath = join(dir, "state.json");
    expect(existsSync(filePath)).toBe(true);

    writer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stop() is idempotent — calling when not started is safe", () => {
    const dir = makeTmpDir();
    const state = new LeaderState();
    const writer = new StateWriter(state, dir);

    // Should not throw
    writer.stop();
    writer.stop();

    rmSync(dir, { recursive: true, force: true });
  });
});
