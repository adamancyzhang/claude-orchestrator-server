// ZK_ROOT_PATH must be set via environment before running this test.
// Use: ZK_ROOT_PATH=/test-root node this-file.js
// Or run via: bash workspace-tests/run-all.sh

import { InstanceRegistry } from "../../dist/modules/registry.js";
import { TaskQueue } from "../../dist/modules/task-queue.js";
import { assert, sleep, runScenario } from "../lib/test-zk.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

await runScenario(
  "03 — Worker Disconnect & Orphan Task",
  ZK_HOSTS,
  process.env.ZK_ROOT_PATH,
  async (scenarioZk) => {
    // Use a SEPARATE ZkClient for the disconnect simulation.
    // Do NOT disconnect scenarioZk — the test harness needs it for cleanup.
    const { ZkClient } = await import("../../dist/zk/client.js");
    const workerZk = new ZkClient(ZK_HOSTS);
    await workerZk.connect();

    try {
      const registry = new InstanceRegistry(scenarioZk);
      const taskQueue = new TaskQueue(scenarioZk);

      // Register worker on the separate connection
      const workerReg = new InstanceRegistry(workerZk);
      const workerTq = new TaskQueue(workerZk);

      const worker = await workerReg.register("Worker1", "builder");
      assert(worker.role === "builder", "Worker1 should be builder");

      // Verify worker visible from scenario connection
      const instances = await registry.listAll();
      assert(
        instances.some((i) => i.id === worker.id),
        "Worker1 should be visible from scenario connection"
      );

      // Push and claim a task from worker's connection
      const task = await workerTq.push(
        "Orphan Test",
        "This task will be orphaned",
        1,
        worker.id,
        undefined,
        undefined,
        undefined,
        "build",
        undefined
      );
      const claimed = await workerTq.claim(worker.id);
      assert(claimed !== null, "Worker1 should claim the task");
      assert(claimed.status === "claimed", "Task should be claimed");

      // Push another task that should survive
      const task2 = await workerTq.push(
        "Survivor Task",
        "This task survives the disconnect",
        1,
        worker.id
      );

      // Disconnect the worker's ZK session — EPHEMERAL nodes disappear
      await workerZk.disconnect();
      await sleep(300);

      // Worker1's instance should be gone (EPHEMERAL)
      const instances2 = await registry.listAll();
      assert(
        !instances2.some((i) => i.id === worker.id),
        "Worker1 should be gone after disconnect"
      );

      // Pending task should still be claimable from scenario connection
      const pendingTasks = await taskQueue.listTasks("pending");
      assert(
        pendingTasks.some((t) => t.id === task2.id),
        "Pending task should survive disconnect"
      );

      // Register new worker on scenario connection
      const worker2 = await registry.register("Worker2", "builder");

      // New worker can claim pending task
      const reclaimed = await taskQueue.claim(worker2.id);
      assert(reclaimed !== null, "Worker2 should claim pending task");

      const completed = await taskQueue.complete(
        worker2.id,
        reclaimed.id,
        "Recovered by Worker2"
      );
      assert(completed.status === "completed", "Task should complete after recovery");
    } finally {
      // Ensure worker session is disconnected (may already be)
      try { await workerZk.disconnect(); } catch (_) { /* ok */ }
    }
  }
);
