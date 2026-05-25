// CORE-RETENTION
// Locks in: TaskOrchestrator's pending/claimed → bus event translation —
// initial pending list emits task_created for each id; subsequent
// watchPending firings emit task_created only for NEW ids; new claim
// records emit task_claimed; claim records that have disappeared emit
// task_completed; stop() silences further emissions; ChainAudit.record
// failures are caught and do NOT block bus emission.
// Critical because: TaskOrchestrator is the only translator between the
// raw ZK watches (children lists) and the leader's typed event stream.
// Every consumer downstream (TUI, recovery, magic mode) reads from the
// bus, so a missed task_completed leaves a ghost row in the in-progress
// panel forever; a double task_created creates a phantom pending; a
// crash here from a failed ChainAudit write blocks the entire watch
// loop and freezes the cluster.
// Primary sources: packages/leader/src/task-orchestrator.ts

import { describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  asTaskId,
  type ClaimRecord,
  type CreateTaskInput,
  type ITaskQueue,
  type Instance,
  type InstanceRole,
  type LeaderEvent,
  type Task,
  type TaskId,
} from "@co/contracts";
import { LeaderEventBus } from "../src/event-bus.js";
import { TaskOrchestrator } from "../src/task-orchestrator.js";
import type { ChainAudit } from "../src/chain-audit.js";

// TRUST-JUSTIFICATION: TestTaskQueue is a fake ITaskQueue used to drive
// TaskOrchestrator from the boundary the orchestrator actually consumes.
// Downstream: ITaskQueue is a contracts interface (@co/contracts).
// Reason: TaskOrchestrator only calls watchPending / watchClaimed /
// getPending; the leader package does not depend on @co/infra so we
// cannot reach a real InMemoryZkClient + TaskQueue here. ITaskQueue is
// the architectural seam — driving the orchestrator through that seam
// IS testing the production contract. We never assert on internal call
// counts; we observe events on a real LeaderEventBus.
// Evidence: TaskQueue's real implementation against InMemoryZkClient is
// covered by packages/coordination/tests/task-queue.test.ts (existing).
// Methods unused by TaskOrchestrator throw, so any silent reliance on
// them surfaces immediately as a thrown error in the watch loop.
class TestTaskQueue implements ITaskQueue {
  private readonly pendingById = new Map<TaskId, Task>();
  private pendingCb: ((ids: TaskId[]) => void) | null = null;
  private claimedCb: ((records: ClaimRecord[]) => void) | null = null;
  private claimedRecords: ClaimRecord[] = [];

  setPending(tasks: Task[]): void {
    this.pendingById.clear();
    for (const t of tasks) this.pendingById.set(t.id, t);
    this.pendingCb?.(tasks.map((t) => t.id));
  }

  setClaimed(records: ClaimRecord[]): void {
    this.claimedRecords = [...records];
    this.claimedCb?.([...records]);
  }

  async getPending(id: TaskId): Promise<Task | null> {
    return this.pendingById.get(id) ?? null;
  }

  async watchPending(cb: (ids: TaskId[]) => void): Promise<TaskId[]> {
    this.pendingCb = cb;
    return [...this.pendingById.keys()];
  }

  async watchClaimed(
    cb: (records: ClaimRecord[]) => void,
  ): Promise<ClaimRecord[]> {
    this.claimedCb = cb;
    return [...this.claimedRecords];
  }

  // ── unused by TaskOrchestrator: throw to surface accidental usage ──
  async push(): Promise<Task> {
    throw new Error("TestTaskQueue.push unused");
  }
  async claim(_c: InstanceId, _r: InstanceRole): Promise<Task | null> {
    throw new Error("TestTaskQueue.claim unused");
  }
  async claimById(): Promise<Task | null> {
    throw new Error("TestTaskQueue.claimById unused");
  }
  async assign(): Promise<Task | null> {
    throw new Error("TestTaskQueue.assign unused");
  }
  async complete(): Promise<void> {
    throw new Error("TestTaskQueue.complete unused");
  }
  async fail(): Promise<void> {
    throw new Error("TestTaskQueue.fail unused");
  }
  async retry(): Promise<Task> {
    throw new Error("TestTaskQueue.retry unused");
  }
  async listPending(): Promise<Task[]> {
    throw new Error("TestTaskQueue.listPending unused");
  }
  async listClaimed(): Promise<ClaimRecord[]> {
    throw new Error("TestTaskQueue.listClaimed unused");
  }
  async getCompleted(): Promise<Task | null> {
    throw new Error("TestTaskQueue.getCompleted unused");
  }
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

function makeClaim(
  taskId: string,
  instId: string,
  chainId: string | null = null,
): ClaimRecord {
  const t = makeTask(taskId);
  if (chainId) t.chain_id = asChainId(chainId);
  return {
    task_id: asTaskId(taskId),
    instance_id: asInstanceId(instId),
    claimed_at: "2026-05-25T00:00:00Z",
    task_snapshot: t,
  };
}

function collectEvents(bus: LeaderEventBus): LeaderEvent[] {
  const out: LeaderEvent[] = [];
  bus.onAny((e) => out.push(e));
  return out;
}

const ALICE = asInstanceId("alice");
const BOB = asInstanceId("bob");

describe("TaskOrchestrator — startup + pending", () => {
  it("emits task_created once for each initial pending task and dedupes on repeat", async () => {
    const queue = new TestTaskQueue();
    const bus = new LeaderEventBus();
    const events = collectEvents(bus);

    const t1 = makeTask("t1");
    const t2 = makeTask("t2");
    queue.setPending([t1, t2]);

    const orch = new TaskOrchestrator(queue, bus);
    await orch.start();

    // Drain microtasks so the async onPending finishes.
    await new Promise((r) => setTimeout(r, 0));

    const createdIds = events
      .filter((e) => e.type === "task_created")
      .map((e) => (e as Extract<LeaderEvent, { type: "task_created" }>).task.id);
    expect(createdIds).toEqual([t1.id, t2.id]);

    // Watch fires again with same set + one new: only the new id emits.
    events.length = 0;
    const t3 = makeTask("t3");
    queue.setPending([t1, t2, t3]);
    await new Promise((r) => setTimeout(r, 0));

    const created2 = events.filter((e) => e.type === "task_created");
    expect(created2).toHaveLength(1);
    expect(
      (created2[0] as Extract<LeaderEvent, { type: "task_created" }>).task.id,
    ).toBe(t3.id);

    orch.stop();
  });
});

describe("TaskOrchestrator — claimed lifecycle", () => {
  it("emits task_claimed when a new claim record appears", async () => {
    const queue = new TestTaskQueue();
    const bus = new LeaderEventBus();
    const events = collectEvents(bus);

    const orch = new TaskOrchestrator(queue, bus);
    await orch.start();
    events.length = 0;

    queue.setClaimed([makeClaim("t1", ALICE)]);
    await new Promise((r) => setTimeout(r, 0));

    const claimed = events.filter((e) => e.type === "task_claimed");
    expect(claimed).toHaveLength(1);
    expect((claimed[0] as Extract<LeaderEvent, { type: "task_claimed" }>).task_id).toBe(asTaskId("t1"));
    expect((claimed[0] as Extract<LeaderEvent, { type: "task_claimed" }>).instance_id).toBe(ALICE);

    orch.stop();
  });

  it("emits task_completed when a claim record disappears between watch firings", async () => {
    const queue = new TestTaskQueue();
    const bus = new LeaderEventBus();
    const events = collectEvents(bus);

    queue.setClaimed([makeClaim("t1", ALICE), makeClaim("t2", BOB)]);

    const orch = new TaskOrchestrator(queue, bus);
    await orch.start();
    // Initial claimed list is registered as known; no completion events yet.
    events.length = 0;

    // t1's claim node disappears (worker completed the task).
    queue.setClaimed([makeClaim("t2", BOB)]);
    await new Promise((r) => setTimeout(r, 0));

    const completed = events.filter((e) => e.type === "task_completed");
    expect(completed).toHaveLength(1);
    expect(
      (completed[0] as Extract<LeaderEvent, { type: "task_completed" }>).task_id,
    ).toBe(asTaskId("t1"));
    expect(
      (completed[0] as Extract<LeaderEvent, { type: "task_completed" }>).instance_id,
    ).toBe(ALICE);
    // No spurious task_claimed for t2 (it was already known).
    expect(events.filter((e) => e.type === "task_claimed")).toHaveLength(0);

    orch.stop();
  });
});

describe("TaskOrchestrator — chain audit integration", () => {
  it("invokes ChainAudit.record on claim AND completion; audit rejections do NOT block bus emission", async () => {
    const queue = new TestTaskQueue();
    const bus = new LeaderEventBus();
    const events = collectEvents(bus);

    const auditCalls: Array<{ chainId: string; event: string; task_id: string }> = [];
    let failNext = false;

    // TRUST-JUSTIFICATION: minimal stub of ChainAudit.
    // Downstream: ChainAudit.record persists JSON to disk under
    // chain-audit/. Covered by chain-audit.test.ts in this package.
    // Reason: the orchestrator's contract here is "audit is called and
    // its rejections are absorbed via .catch()." Audit correctness is
    // not under test in this file.
    // Evidence: auditCalls records observable invocations; bus emission
    // is verified independently.
    const auditStub = {
      async record(
        chainId: string,
        payload: { event: string; task_id: string },
      ): Promise<void> {
        auditCalls.push({
          chainId,
          event: payload.event,
          task_id: payload.task_id,
        });
        if (failNext) {
          failNext = false;
          throw new Error("audit write failed");
        }
      },
    } as unknown as ChainAudit;

    const orch = new TaskOrchestrator(queue, bus, auditStub);
    await orch.start();
    events.length = 0;

    queue.setClaimed([makeClaim("t1", ALICE, "chain-1")]);
    await new Promise((r) => setTimeout(r, 0));

    // Audit rejects on completion — orchestrator must NOT crash.
    failNext = true;
    queue.setClaimed([]);
    await new Promise((r) => setTimeout(r, 10));

    expect(events.filter((e) => e.type === "task_claimed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "task_completed")).toHaveLength(1);

    expect(auditCalls).toEqual([
      { chainId: "chain-1", event: "task_claimed", task_id: "t1" },
      { chainId: "chain-1", event: "task_completed", task_id: "t1" },
    ]);

    orch.stop();
  });
});

describe("TaskOrchestrator — stop()", () => {
  it("after stop(), further watch firings produce no bus emissions", async () => {
    const queue = new TestTaskQueue();
    const bus = new LeaderEventBus();
    const events = collectEvents(bus);

    const orch = new TaskOrchestrator(queue, bus);
    await orch.start();
    orch.stop();
    events.length = 0;

    queue.setPending([makeTask("post-stop")]);
    queue.setClaimed([makeClaim("post-stop", ALICE)]);
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toHaveLength(0);
  });
});
