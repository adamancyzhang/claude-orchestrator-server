import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

const TEST_ROOT = vi.hoisted(() => {
  const root = `/test-recovery-${Date.now()}`;
  process.env.ZK_ROOT_PATH = root;
  return root;
});

import { ZkClient } from "../../src/zk/client.js";
import { TaskQueue } from "../../src/modules/task-queue.js";
import { InstanceRegistry } from "../../src/modules/registry.js";
import { TaskRecovery } from "../../src/leader/recovery.js";
import { LeaderEventBus } from "../../src/leader/event-bus.js";

describe("TaskRecovery", () => {
  let zk: ZkClient;
  let eventBus: LeaderEventBus;
  let recovery: TaskRecovery;
  let taskQueue: TaskQueue;
  let registry: InstanceRegistry;

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();
    eventBus = new LeaderEventBus();
    recovery = new TaskRecovery(zk, eventBus);
    taskQueue = new TaskQueue(zk);
    registry = new InstanceRegistry(zk);
  });

  afterAll(async () => {
    await zk.disconnect();
  });

  describe("recoverOrphanedTasks (triggered by worker_left)", () => {
    it("re-queues orphaned claimed tasks as pending", async () => {
      // Register a worker, push and claim a task
      const worker = await registry.register("OrphanWorker", "builder");
      const task = await taskQueue.push("Orphaned task", "Test", 1, "creator-1");
      const claimed = await taskQueue.claim(worker.id);
      expect(claimed).not.toBeNull();

      // Simulate worker disconnect by triggering worker_left event
      // We need to manually call recoverOrphanedTasks since the recovery.start()
      // subscribes to worker_left but we're testing directly
      const events: any[] = [];
      eventBus.on("task_recovered", (e) => events.push(e));

      await recovery["recoverOrphanedTasks"](worker.id);

      // Task should be re-queued as pending
      expect(events.length).toBe(1);
      expect(events[0].taskId).toBe(claimed!.id);
      expect(events[0].retryCount).toBe(1);

      // The original claimed node should be removed
      const claimedData = await zk.getClaimedTask(worker.id, claimed!.id);
      expect(claimedData).toEqual({});
    });
  });

  describe("scanOrphans", () => {
    it("detects and recovers orphaned tasks", async () => {
      // Register a worker, push and claim a task, then unregister the worker
      const worker = await registry.register("ScanWorker", "builder");
      const task = await taskQueue.push("Scan orphan", "Test", 1, "creator-1");
      const claimed = await taskQueue.claim(worker.id);
      expect(claimed).not.toBeNull();

      // Unregister to simulate disconnect
      await registry.unregister(worker.id);

      const events: any[] = [];
      eventBus.on("task_recovered", (e) => events.push(e));

      await recovery.scanOrphans();

      expect(events.length).toBe(1);
      expect(events[0].taskId).toBe(claimed!.id);
    });
  });

  describe("max retries limit", () => {
    it("permanently fails a task after 3 retries", async () => {
      // Drain any pending tasks from earlier tests
      const drainer = await registry.register("RetryDrainer", "builder");
      let d = await taskQueue.claim(drainer.id);
      while (d) {
        try { await taskQueue.complete(drainer.id, d.id, "drained"); } catch {}
        d = await taskQueue.claim(drainer.id);
      }

      // Worker 1 claims → disconnects → recovery (retry_count: 1)
      const w1 = await registry.register("RetryWorker1b", "builder");
      const task = await taskQueue.push("Retry limit task", "Test", 1, "creator-1");
      const c1 = await taskQueue.claim(w1.id);
      expect(c1).not.toBeNull();
      await recovery["recoverOrphanedTasks"](w1.id);

      // Worker 2 claims re-queued task → disconnects → recovery (retry_count: 2)
      const w2 = await registry.register("RetryWorker2b", "builder");
      const c2 = await taskQueue.claim(w2.id);
      expect(c2).not.toBeNull();
      await recovery["recoverOrphanedTasks"](w2.id);

      // Worker 3 claims re-queued task → disconnects → recovery (retry_count: 3)
      const w3 = await registry.register("RetryWorker3b", "builder");
      const c3 = await taskQueue.claim(w3.id);
      expect(c3).not.toBeNull();
      await recovery["recoverOrphanedTasks"](w3.id);

      // Worker 4 claims re-queued task → disconnects → recovery (retry_count: 4 > 3, permanent fail)
      const w4 = await registry.register("RetryWorker4b", "builder");
      const c4 = await taskQueue.claim(w4.id);
      expect(c4).not.toBeNull();

      const failEvents: any[] = [];
      eventBus.on("task_failed", (e) => failEvents.push(e));

      await recovery["recoverOrphanedTasks"](w4.id);

      expect(failEvents.length).toBe(1);
      expect(failEvents[0].reason).toBe("Max retries exceeded");
    });
  });

  describe("edge cases", () => {
    it("no-op when worker has no claimed tasks", async () => {
      const events: any[] = [];
      eventBus.on("task_recovered", (e) => events.push(e));
      eventBus.on("task_failed", (e) => events.push(e));

      await recovery["recoverOrphanedTasks"]("nonexistent-worker");

      expect(events.length).toBe(0);
    });

    it("no-op when all claiming instances are online", async () => {
      const worker = await registry.register("OnlineWorker", "builder");
      const task = await taskQueue.push("Online worker task");
      const claimed = await taskQueue.claim(worker.id);
      expect(claimed).not.toBeNull();

      const events: any[] = [];
      eventBus.on("task_recovered", (e) => events.push(e));

      // scanOrphans should not recover tasks whose workers are still online
      await recovery.scanOrphans();

      // No recovery events since the worker is still registered
      expect(events.length).toBe(0);
    });
  });
});
