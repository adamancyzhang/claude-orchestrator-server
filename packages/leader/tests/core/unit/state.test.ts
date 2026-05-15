// CORE-RETENTION
// Locks in: LeaderState.apply() reducer semantics for each LeaderEvent
//   variant: worker join/leave, task create/claim/complete, selected_worker
//   bounds. State is the only source of truth the TUI reads.
// Core path because: a misapplied event silently shows wrong worker counts,
//   wrong pending tasks, or stuck "claimed" tasks in the TUI.
// Owner subsystem: leader.
// Primary source files exercised:
//   - packages/leader/src/state.ts

import { describe, expect, it } from "vitest";
import { LeaderState } from "../../../src/index.js";
import {
  PROTOCOL_VERSION,
  asInstanceId,
  asTaskId,
  type Instance,
  type Task,
} from "@co/contracts";

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: asInstanceId("w1"),
    name: "Tom",
    role: "builder",
    status: "idle",
    current_task_id: null,
    connected_since: "2026-05-14T00:00:00Z",
    work_dir: null,
    worktree_name: null,
    worktree_path: null,
    worktree_branch: null,
    pid: null,
    protocol_version: PROTOCOL_VERSION,
    ...overrides,
  } as Instance;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: asTaskId("t-1"),
    title: "do thing",
    description: "",
    criteria: "",
    priority: 1,
    status: "pending",
    link: "build",
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
    created_at: "2026-05-14T00:00:00Z",
    claimed_at: null,
    completed_at: null,
    duration_seconds: null,
    leader_only: false,
    result: null,
    ...overrides,
  } as Task;
}

describe("LeaderState.apply", () => {
  it("worker_joined appends to workers", () => {
    const state = new LeaderState();
    state.apply({ type: "worker_joined", instance: instance() });
    expect(state.workers).toHaveLength(1);
    expect(state.workers[0].name).toBe("Tom");
  });

  it("worker_left removes by instance_id", () => {
    const state = new LeaderState();
    state.apply({ type: "worker_joined", instance: instance() });
    state.apply({
      type: "worker_left",
      instance_id: asInstanceId("w1"),
      name: "Tom",
    });
    expect(state.workers).toHaveLength(0);
  });

  it("task_created → task_claimed moves task from pending to in_progress", () => {
    const state = new LeaderState();
    state.apply({ type: "worker_joined", instance: instance() });
    const t = task();
    state.apply({ type: "task_created", task: t });
    expect(state.pending_tasks).toHaveLength(1);
    state.apply({
      type: "task_claimed",
      task_id: t.id,
      instance_id: asInstanceId("w1"),
    });
    expect(state.pending_tasks).toHaveLength(0);
    expect(state.in_progress_tasks).toHaveLength(1);
    expect(state.workers[0].status).toBe("busy");
    expect(state.workers[0].current_role).toBe("builder");
  });

  it("task_completed clears in_progress and idles worker", () => {
    const state = new LeaderState();
    state.apply({ type: "worker_joined", instance: instance() });
    const t = task();
    state.apply({ type: "task_created", task: t });
    state.apply({
      type: "task_claimed",
      task_id: t.id,
      instance_id: asInstanceId("w1"),
    });
    state.apply({
      type: "task_completed",
      task_id: t.id,
      instance_id: asInstanceId("w1"),
      duration_seconds: 5,
    });
    expect(state.in_progress_tasks).toHaveLength(0);
    expect(state.workers[0].status).toBe("idle");
  });

  it("setSelectedWorkerIndex clamps to bounds", () => {
    const state = new LeaderState();
    state.apply({ type: "worker_joined", instance: instance() });
    state.setSelectedWorkerIndex(99);
    expect(state.selected_worker_index).toBe(0);
    state.setSelectedWorkerIndex(-3);
    expect(state.selected_worker_index).toBe(0);
  });
});
