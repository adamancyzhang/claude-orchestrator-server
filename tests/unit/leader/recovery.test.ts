import { describe, it, expect } from "vitest";
import { TaskRecovery } from "../../../src/leader/recovery.js";
import { LeaderEventBus } from "../../../src/leader/event-bus.js";
import { MockZkClient } from "../../fixtures/mock-zk.js";
import { makeTask, makeInstance } from "../../fixtures/factories.js";
import { captureEvents } from "../../fixtures/helpers.js";
import type { ZkClient } from "../../../src/zk/client.js";

describe("TaskRecovery", () => {
  it("re-queues a task with retry_count below MAX_RETRIES and emits task_recovered", async () => {
    const zk = new MockZkClient();
    const task = makeTask({ title: "Build", retry_count: 1 });
    const orphanWorker = "deadworker1";
    zk.claimedTasks.set(`${orphanWorker}-task-orig`, task);

    const bus = new LeaderEventBus();
    const events = captureEvents(bus);

    const rec = new TaskRecovery(zk as unknown as ZkClient, bus);
    rec.start();
    bus.emit({ type: "worker_left", instanceId: orphanWorker, name: "dead" });
    // recoverOrphanedTasks is fired async without awaiting; give it room to settle.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const recovered = events.find((e) => e.type === "task_recovered");
    expect(recovered).toBeDefined();
    expect("retryCount" in recovered! && recovered.retryCount).toBe(2);

    // A new pending task should exist
    expect(zk.createPendingTask).toHaveBeenCalled();
    // The original claimed entry was removed
    expect(zk.deleteClaimedTask).toHaveBeenCalled();
  });

  it("archives as failed when retry_count exceeds MAX_RETRIES", async () => {
    const zk = new MockZkClient();
    const task = makeTask({ title: "Build", retry_count: 3 });
    const orphanWorker = "deadworker2";
    zk.claimedTasks.set(`${orphanWorker}-task-failed`, task);

    const bus = new LeaderEventBus();
    const events = captureEvents(bus);

    const rec = new TaskRecovery(zk as unknown as ZkClient, bus);
    rec.start();
    bus.emit({ type: "worker_left", instanceId: orphanWorker, name: "dead" });
    // recoverOrphanedTasks is fired async without awaiting; give it room to settle.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const failed = events.find((e) => e.type === "task_failed");
    expect(failed).toBeDefined();
    expect(zk.saveCompletedTask).toHaveBeenCalled();
    expect(zk.createPendingTask).not.toHaveBeenCalled();

    // The saved completed task should be in failed status
    const savedCall = zk.saveCompletedTask.mock.calls[0];
    expect((savedCall[1] as { status: string }).status).toBe("failed");
  });

  it("scanOrphans cross-references online instances vs claimed tasks", async () => {
    const zk = new MockZkClient();
    const alive = makeInstance({ name: "alive" });
    const dead = "deadworker";
    zk.instances.set(alive.id, alive);

    const aliveTask = makeTask({ title: "alive-task" });
    const deadTask = makeTask({ title: "dead-task" });
    zk.claimedTasks.set(`${alive.id}-task-a`, aliveTask);
    zk.claimedTasks.set(`${dead}-task-d`, deadTask);

    const bus = new LeaderEventBus();
    const events = captureEvents(bus);

    const rec = new TaskRecovery(zk as unknown as ZkClient, bus);
    await rec.scanOrphans();

    const recovered = events.filter((e) => e.type === "task_recovered" || e.type === "task_failed");
    expect(recovered).toHaveLength(1);
  });
});
