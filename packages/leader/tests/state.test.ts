// CORE-RETENTION
// Locks in: LeaderState — the leader's mutable view of workers, tasks,
// and events — applies LeaderEvent variants deterministically.
// Specifically: worker_joined/left round-trip the worker list; task_claimed
// moves a task from pending → in_progress and infers current_role from
// the chain link; task_completed clears worker state and records the
// last completed task; message_history caps at 20; events ring buffer
// caps at 100; magic_mode_configured updates both getters; stream_chunk
// concatenates onto current_message when present and replaces when null;
// setSelectedWorkerIndex clamps to bounds and fires onChange only when
// the index actually changes.
// Critical because: LeaderState is the single source of truth for the
// TUI's 7 panels (event-log, pending, in-progress, team, worker-messages,
// footer, input-line) and for the task orchestrator's local mirror.
// A regression that mis-applies an event silently corrupts the operator
// view (wrong task shown as in-progress, history truncation that drops
// the newest entry, role misinference) — the kind of bug that surfaces
// hours later as "the system seems to have lost track of worker N."
// Primary sources: packages/leader/src/state.ts

import { describe, expect, it, vi } from "vitest";
import {
  asInstanceId,
  asTaskId,
  asMessageId,
  asChainId,
  PROTOCOL_VERSION,
  type Instance,
  type LeaderEvent,
  type Task,
} from "@co/contracts";
import { LeaderState } from "../src/state.js";

function makeInstance(id: string, role: Instance["role"] = "executor"): Instance {
  return {
    id: asInstanceId(id),
    name: id.toUpperCase(),
    role,
    status: "idle",
    current_task_id: null,
    connected_since: "2026-05-25T00:00:00Z",
    work_dir: null,
    worktree_name: null,
    worktree_path: null,
    worktree_branch: null,
    pid: null,
    protocol_version: PROTOCOL_VERSION,
  };
}

function makeTask(id: string, link: Task["link"] = "execute"): Task {
  return {
    id: asTaskId(id),
    title: `task ${id}`,
    description: "",
    criteria: "",
    priority: 1,
    status: "pending",
    link,
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
    created_at: "2026-05-25T00:00:00Z",
    claimed_at: null,
    completed_at: null,
    duration_seconds: null,
    leader_only: false,
    result: null,
  };
}

describe("LeaderState — worker lifecycle", () => {
  it("worker_joined then worker_left round-trips the workers list", () => {
    const state = new LeaderState();
    expect(state.workers).toHaveLength(0);

    const inst = makeInstance("w-1", "planner");
    state.apply({ type: "worker_joined", instance: inst });
    expect(state.workers).toHaveLength(1);
    expect(state.workers[0]).toMatchObject({
      id: inst.id,
      name: "W-1",
      preset_role: "planner",
      current_role: null,
      status: "idle",
      message_history: [],
    });

    state.apply({ type: "worker_left", instance_id: inst.id, name: "W-1" });
    expect(state.workers).toHaveLength(0);
    expect(state.selected_worker_index).toBe(0);
  });

  it("worker_left shifts selected_worker_index left when a worker at-or-before selection is removed", () => {
    const state = new LeaderState();
    const a = makeInstance("a");
    const b = makeInstance("b");
    const c = makeInstance("c");
    state.apply({ type: "worker_joined", instance: a });
    state.apply({ type: "worker_joined", instance: b });
    state.apply({ type: "worker_joined", instance: c });
    state.setSelectedWorkerIndex(2);
    expect(state.selected_worker_index).toBe(2);

    state.apply({ type: "worker_left", instance_id: a.id, name: "A" });
    // a was removed (idx 0 <= selected 2), selection shifts to 1.
    expect(state.selected_worker_index).toBe(1);
    expect(state.workers.map((w) => w.id)).toEqual([b.id, c.id]);
  });
});

describe("LeaderState — task lifecycle", () => {
  it("task_claimed moves task pending → in_progress and infers current_role from link", () => {
    const state = new LeaderState();
    const w = makeInstance("worker-x", "executor");
    const t = makeTask("task-1", "plan");
    state.apply({ type: "worker_joined", instance: w });
    state.apply({ type: "task_created", task: t });

    expect(state.pending_tasks).toHaveLength(1);
    expect(state.in_progress_tasks).toHaveLength(0);

    state.apply({
      type: "task_claimed",
      task_id: t.id,
      instance_id: w.id,
    });

    expect(state.pending_tasks).toHaveLength(0);
    expect(state.in_progress_tasks).toHaveLength(1);
    expect(state.in_progress_tasks[0]).toMatchObject({
      id: t.id,
      status: "claimed",
      claimed_by: w.id,
    });

    const worker = state.workers[0];
    expect(worker.current_task_id).toBe(t.id);
    expect(worker.status).toBe("busy");
    // link=plan should map to role=planner per LINK_TO_ROLE.
    expect(worker.current_role).toBe("planner");
  });

  it("task_completed clears worker state and records last_completed_task", () => {
    const state = new LeaderState();
    const w = makeInstance("worker-y");
    const t = makeTask("task-2", "execute");
    state.apply({ type: "worker_joined", instance: w });
    state.apply({ type: "task_created", task: t });
    state.apply({ type: "task_claimed", task_id: t.id, instance_id: w.id });
    state.apply({
      type: "worker_message_received",
      instance_id: w.id,
      message_id: asMessageId("m-1"),
      content: "working on it",
      link: "execute",
      timestamp: "2026-05-25T01:00:00Z",
    });

    expect(state.workers[0].current_message).toBe("working on it");

    state.apply({
      type: "task_completed",
      task_id: t.id,
      instance_id: w.id,
      duration_seconds: 12.5,
    });

    const worker = state.workers[0];
    expect(state.in_progress_tasks).toHaveLength(0);
    expect(worker.current_task_id).toBeNull();
    expect(worker.current_role).toBeNull();
    expect(worker.status).toBe("idle");
    expect(worker.current_message).toBeNull();
    expect(worker.current_message_link).toBeNull();
    expect(worker.current_message_time).toBeNull();
    expect(worker.last_completed_task).toBe(t.id);
  });

  it("task_failed removes task from in_progress without clearing worker state", () => {
    // Lock in: task_failed only removes the task from in_progress; the
    // worker's busy/current_task_id is NOT touched here — leader's
    // recovery layer is expected to follow up. This explicit non-mutation
    // is the contract callers depend on.
    const state = new LeaderState();
    const w = makeInstance("w");
    const t = makeTask("task-3");
    state.apply({ type: "worker_joined", instance: w });
    state.apply({ type: "task_created", task: t });
    state.apply({ type: "task_claimed", task_id: t.id, instance_id: w.id });

    state.apply({ type: "task_failed", task_id: t.id, reason: "boom" });

    expect(state.in_progress_tasks).toHaveLength(0);
    // Worker still shows the failed task — recovery layer's job to reset.
    expect(state.workers[0].current_task_id).toBe(t.id);
    expect(state.workers[0].status).toBe("busy");
  });
});

describe("LeaderState — message history", () => {
  it("message_history caps at 20, keeping the newest entries", () => {
    const state = new LeaderState();
    const w = makeInstance("w");
    state.apply({ type: "worker_joined", instance: w });

    for (let i = 0; i < 25; i++) {
      state.apply({
        type: "worker_message_received",
        instance_id: w.id,
        message_id: asMessageId(`m-${i}`),
        content: `msg ${i}`,
        link: null,
        timestamp: `2026-05-25T00:00:${String(i).padStart(2, "0")}Z`,
      });
    }

    const history = state.workers[0].message_history;
    expect(history).toHaveLength(20);
    expect(history[0].content).toBe("msg 5");
    expect(history[19].content).toBe("msg 24");
  });

  it("stream_chunk appends to current_message when present, sets it when null", () => {
    const state = new LeaderState();
    const w = makeInstance("w");
    state.apply({ type: "worker_joined", instance: w });

    expect(state.workers[0].current_message).toBeNull();

    state.apply({ type: "stream_chunk", instance_id: w.id, chunk: "hello" });
    expect(state.workers[0].current_message).toBe("hello");

    state.apply({ type: "stream_chunk", instance_id: w.id, chunk: "world" });
    expect(state.workers[0].current_message).toBe("hello\nworld");
  });
});

describe("LeaderState — events ring buffer", () => {
  it("events ring caps at 100; oldest are dropped first", () => {
    const state = new LeaderState();
    for (let i = 0; i < 105; i++) {
      state.apply({ type: "debug_info", message: `evt-${i}` });
    }
    expect(state.events).toHaveLength(100);
    const first = state.events[0] as Extract<LeaderEvent, { type: "debug_info" }>;
    const last = state.events[99] as Extract<LeaderEvent, { type: "debug_info" }>;
    expect(first.message).toBe("evt-5");
    expect(last.message).toBe("evt-104");
  });

  it("worker_activity high-freq actions (tool_use/text/thinking) do NOT consume ring slots", () => {
    // Lock in: high-frequency actions update worker.current_* but must
    // not displace chain/task/phase events from the 100-entry ring.
    const state = new LeaderState();
    const w = makeInstance("w-noise");
    state.apply({ type: "worker_joined", instance: w });
    expect(state.events).toHaveLength(1); // worker_joined

    for (let i = 0; i < 200; i++) {
      state.apply({
        type: "worker_activity",
        instance_id: w.id,
        task_id: null,
        link: null,
        phase: "generate",
        action: "tool_use",
        detail: `Bash: cmd-${i}`,
        next: null,
        timestamp: "2026-05-25T00:00:00Z",
      });
    }
    // Only worker_joined entered the ring; tool_use was filtered out.
    expect(state.events).toHaveLength(1);
    // But the current_* fields still tracked the latest action.
    expect(state.workers[0].current_action).toBe("tool_use");
    expect(state.workers[0].current_detail).toBe("Bash: cmd-199");
  });
});

describe("LeaderState — worker activity", () => {
  it("worker_activity updates current_phase/action/detail and pushes history (cap 10)", () => {
    const state = new LeaderState();
    const w = makeInstance("w-act");
    state.apply({ type: "worker_joined", instance: w });

    for (let i = 0; i < 13; i++) {
      state.apply({
        type: "worker_activity",
        instance_id: w.id,
        task_id: null,
        link: "execute",
        phase: "generate",
        action: "retry",
        detail: `attempt ${i + 1}/3`,
        next: null,
        timestamp: `2026-05-25T00:00:${String(i).padStart(2, "0")}Z`,
      });
    }
    const worker = state.workers[0];
    expect(worker.current_phase).toBe("generate");
    expect(worker.current_action).toBe("retry");
    expect(worker.current_detail).toBe("attempt 13/3");
    // Cap at 10 with newest preserved.
    expect(worker.activity_history).toHaveLength(10);
    expect(worker.activity_history[0].detail).toBe("attempt 4/3");
    expect(worker.activity_history[9].detail).toBe("attempt 13/3");
  });

  it("task_completed clears all worker_activity fields", () => {
    const state = new LeaderState();
    const w = makeInstance("w-act-clear");
    const t = makeTask("t-clear", "execute");
    state.apply({ type: "worker_joined", instance: w });
    state.apply({ type: "task_created", task: t });
    state.apply({ type: "task_claimed", task_id: t.id, instance_id: w.id });
    state.apply({
      type: "worker_activity",
      instance_id: w.id,
      task_id: t.id,
      link: "execute",
      phase: "commit",
      action: "phase_end",
      detail: "sha abc12345",
      next: null,
      timestamp: "2026-05-25T00:01:00Z",
    });

    expect(state.workers[0].current_phase).toBe("commit");
    expect(state.workers[0].activity_history).toHaveLength(1);

    state.apply({
      type: "task_completed",
      task_id: t.id,
      instance_id: w.id,
      duration_seconds: 1,
    });

    const worker = state.workers[0];
    expect(worker.current_phase).toBeNull();
    expect(worker.current_action).toBeNull();
    expect(worker.current_detail).toBeNull();
    expect(worker.next_hint).toBeNull();
    expect(worker.activity_history).toHaveLength(0);
  });
});

describe("LeaderState — magic mode", () => {
  it("magic_mode_configured updates both getters", () => {
    const state = new LeaderState();
    expect(state.magic_mode).toBe(false);
    expect(state.magic_max_chains).toBeNull();

    state.apply({
      type: "magic_mode_configured",
      magic_mode: true,
      magic_max_chains: 5,
    });

    expect(state.magic_mode).toBe(true);
    expect(state.magic_max_chains).toBe(5);
  });
});

describe("LeaderState — selected worker index", () => {
  it("clamps to [0, workers.length-1] and only fires onChange when the value changes", () => {
    const state = new LeaderState();
    // TRUST-JUSTIFICATION: vi.fn() used as a callback spy.
    // Downstream: nothing — onChange is a user-supplied notification
    // sink that LeaderState's public API exposes (state.onChange(fn)).
    // Reason: the contract under test IS the invocation count — the
    // public contract is "fires onChange only when selected_worker_index
    // actually changes." Invocation count IS observable behavior, not
    // an internal call count.
    // Evidence: assertions interleave selected_worker_index reads and
    // onChange call-count reads to verify the value-change-implies-fire
    // contract; no internal state is inspected.
    const onChange = vi.fn();
    state.onChange(onChange);

    // No workers → forced to 0, no change from initial 0, no fire.
    state.setSelectedWorkerIndex(99);
    expect(state.selected_worker_index).toBe(0);
    expect(onChange).not.toHaveBeenCalled();

    state.apply({ type: "worker_joined", instance: makeInstance("a") });
    state.apply({ type: "worker_joined", instance: makeInstance("b") });
    state.apply({ type: "worker_joined", instance: makeInstance("c") });

    // setSelectedWorkerIndex(2) — change from 0 → 2 should fire.
    state.setSelectedWorkerIndex(2);
    expect(state.selected_worker_index).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    // No-op set: 2 → 2 must NOT fire.
    state.setSelectedWorkerIndex(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Above bound clamps to length-1 (2); no value change, no fire.
    state.setSelectedWorkerIndex(99);
    expect(state.selected_worker_index).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Below bound clamps to 0; fires.
    state.setSelectedWorkerIndex(-5);
    expect(state.selected_worker_index).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
