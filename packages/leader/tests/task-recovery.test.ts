// CORE-RETENTION
// Locks in: TaskRecovery's orphan detection and retry logic — scanOrphans
// finds claimed tasks whose worker is offline, recoverFor handles worker
// disconnection events, retry exhaustion archives the task and emits
// task_failed, and successful retry emits task_recovered. These tests
// exercise the TaskRecovery class directly with mocked dependencies.
// Critical because: orphan recovery is the chain pipeline's safety net —
// missed orphans leave tasks permanently stuck, and infinite retries
// would block the pipeline indefinitely.
// Primary sources: packages/leader/src/recovery.ts

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  asInstanceId,
  asTaskId,
  OrphanRetryExhaustedError,
  type ClaimRecord,
  type IEventBus,
  type IInstanceRegistry,
  type ITaskQueue,
  type ILogger,
  type LeaderEvent,
  type Task,
} from "@co/contracts";
import { TaskRecovery } from "../src/recovery.js";
import { LeaderEventBus } from "../src/event-bus.js";

// ── Test doubles ──────────────────────────────────────────────────────

class TestTaskQueue implements ITaskQueue {
  private claimed: ClaimRecord[] = [];
  private tasks: Task[] = [];
  private nextId = 1;

  setClaimed(records: ClaimRecord[]): void {
    this.claimed = records;
  }

  async listClaimed(): Promise<ClaimRecord[]> {
    return this.claimed;
  }

  async retry(taskId: string, snapshot?: Task): Promise<Task> {
    const newTask: Task = {
      id: asTaskId(`retry-${this.nextId++}`),
      title: snapshot?.title ?? "retried",
      description: snapshot?.description ?? "",
      criteria: snapshot?.criteria ?? "",
      priority: snapshot?.priority ?? 0,
      link: snapshot?.link ?? null,
      chain_id: snapshot?.chain_id ?? null,
      status: "pending",
      created_by: snapshot?.created_by ?? asInstanceId("leader"),
      created_by_name: snapshot?.created_by_name ?? "Leader",
      assigned_to: null,
      assigned_to_name: null,
      claimed_by: null,
      claimed_at: null,
      completed_at: null,
      retry_count: (snapshot?.retry_count ?? 0) + 1,
      created_at: new Date().toISOString(),
    };
    this.tasks.push(newTask);
    return newTask;
  }

  async fail(_taskId: string, _reason: string): Promise<void> {
    // archive the task
  }

  async push(_input: Partial<Task>): Promise<Task> {
    throw new Error("push unused");
  }

  async assign(_taskId: string, _workerId: string, _workerName: string): Promise<void> {
    throw new Error("assign unused");
  }

  async listPending(): Promise<Task[]> {
    return this.tasks.filter((t) => t.status === "pending");
  }

  async listInProgress(): Promise<Task[]> {
    return this.tasks.filter((t) => t.status === "in_progress");
  }

  async getCompleted(_taskId: string): Promise<Task | null> {
    return null;
  }

  async claim(_taskId: string, _workerId: string): Promise<Task> {
    throw new Error("claim unused");
  }

  async complete(_taskId: string): Promise<void> {
    throw new Error("complete unused");
  }
}

class TestInstanceRegistry implements IInstanceRegistry {
  private instances: Array<{ id: string; name: string; role: string; status: string }> = [];

  setInstances(list: Array<{ id: string; name: string; role: string; status: string }>): void {
    this.instances = list;
  }

  async list(): Promise<any[]> {
    return this.instances;
  }

  async get(id: string): Promise<any | undefined> {
    return this.instances.find((i) => i.id === id);
  }

  async register(_inst: any): Promise<void> {
    throw new Error("register unused");
  }

  async unregister(_id: string): Promise<void> {
    throw new Error("unregister unused");
  }
}

const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

// ── Helpers ───────────────────────────────────────────────────────────

function makeClaimRecord(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    task_id: asTaskId("task-1"),
    instance_id: asInstanceId("worker-1"),
    claimed_at: new Date().toISOString(),
    task_snapshot: {
      id: asTaskId("task-1"),
      title: "test task",
      description: "desc",
      criteria: "",
      priority: 1,
      link: "execute",
      chain_id: "chain-1" as any,
      status: "in_progress",
      created_by: asInstanceId("leader"),
      created_by_name: "Leader",
      assigned_to: asInstanceId("worker-1"),
      assigned_to_name: "Worker1",
      claimed_by: asInstanceId("worker-1"),
      claimed_at: new Date().toISOString(),
      completed_at: null,
      retry_count: 0,
      created_at: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeRecovery(overrides: Partial<{
  queue: ITaskQueue;
  registry: IInstanceRegistry;
  bus: IEventBus<LeaderEvent>;
  logger: ILogger;
}> = {}): {
  recovery: TaskRecovery;
  queue: TestTaskQueue;
  registry: TestInstanceRegistry;
  bus: LeaderEventBus;
} {
  const queue = new TestTaskQueue();
  const registry = new TestInstanceRegistry();
  const bus = new LeaderEventBus();
  const logger = overrides.logger ?? noopLogger;
  const recovery = new TaskRecovery(
    overrides.queue ?? queue,
    overrides.registry ?? registry,
    overrides.bus ?? bus,
    logger,
  );
  return { recovery, queue, registry, bus };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("TaskRecovery — scanOrphans", () => {
  it("retries claimed tasks whose worker is offline", async () => {
    const { recovery, queue, registry, bus } = makeRecovery();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([]); // worker-1 is offline
    queue.setClaimed([makeClaimRecord()]);

    await recovery.scanOrphans();

    expect(events.some((e) => e.type === "task_recovered")).toBe(true);
    const recovered = events.find((e) => e.type === "task_recovered") as any;
    expect(recovered.retry_count).toBe(1);
  });

  it("does not retry tasks whose worker is still online", async () => {
    const { recovery, queue, registry, bus } = makeRecovery();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      { id: "worker-1", name: "Worker1", role: "executor", status: "idle" },
    ]);
    queue.setClaimed([makeClaimRecord()]);

    await recovery.scanOrphans();

    expect(events.filter((e) => e.type === "task_recovered")).toHaveLength(0);
  });

  it("handles empty claimed list", async () => {
    const { recovery, queue, registry, bus } = makeRecovery();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([]);
    queue.setClaimed([]);

    await recovery.scanOrphans();

    expect(events).toHaveLength(0);
  });
});

describe("TaskRecovery — worker_left event", () => {
  it("recovers tasks claimed by the disconnected worker", async () => {
    const { recovery, queue, registry, bus } = makeRecovery();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([]); // worker-1 is offline
    queue.setClaimed([makeClaimRecord()]);

    recovery.start();
    bus.emit({
      type: "worker_left",
      instance_id: asInstanceId("worker-1"),
      name: "Worker1",
    });

    // Wait for async recovery
    await new Promise((r) => setTimeout(r, 10));

    expect(events.some((e) => e.type === "task_recovered")).toBe(true);
  });

  it("does not recover tasks claimed by other workers", async () => {
    const { recovery, queue, registry, bus } = makeRecovery();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([]);
    queue.setClaimed([makeClaimRecord({ instance_id: asInstanceId("worker-2") })]);

    recovery.start();
    bus.emit({
      type: "worker_left",
      instance_id: asInstanceId("worker-1"),
      name: "Worker1",
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(events.filter((e) => e.type === "task_recovered")).toHaveLength(0);
  });
});

describe("TaskRecovery — retry exhaustion", () => {
  it("archives task and emits task_failed after MAX_RETRIES", async () => {
    const { recovery, queue, registry, bus } = makeRecovery();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([]); // worker offline
    // Set up a claim with retry_count already at MAX_RETRIES (3)
    queue.setClaimed([
      makeClaimRecord({
        task_id: asTaskId("task-exhausted"),
        task_snapshot: {
          id: asTaskId("task-exhausted"),
          title: "exhausted",
          description: "",
          criteria: "",
          priority: 1,
          link: "execute",
          chain_id: "chain-1" as any,
          status: "in_progress",
          created_by: asInstanceId("leader"),
          created_by_name: "Leader",
          assigned_to: asInstanceId("worker-1"),
          assigned_to_name: "Worker1",
          claimed_by: asInstanceId("worker-1"),
          claimed_at: new Date().toISOString(),
          completed_at: null,
          retry_count: 3, // already at MAX_RETRIES
          created_at: new Date().toISOString(),
        },
      }),
    ]);

    await expect(recovery.scanOrphans()).rejects.toThrow(OrphanRetryExhaustedError);

    expect(events.some((e) => e.type === "task_failed")).toBe(true);
    const failed = events.find((e) => e.type === "task_failed") as any;
    expect(failed.task_id).toBe("task-exhausted");
  });
});

describe("TaskRecovery — multiple orphans", () => {
  it("recovers multiple orphaned tasks in one scan", async () => {
    const { recovery, queue, registry, bus } = makeRecovery();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([]); // all workers offline
    queue.setClaimed([
      makeClaimRecord({ task_id: asTaskId("task-a"), instance_id: asInstanceId("worker-a") }),
      makeClaimRecord({ task_id: asTaskId("task-b"), instance_id: asInstanceId("worker-b") }),
    ]);

    await recovery.scanOrphans();

    const recovered = events.filter((e) => e.type === "task_recovered");
    expect(recovered).toHaveLength(2);
  });
});
