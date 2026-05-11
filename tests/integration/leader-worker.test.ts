import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZkClient, isNodeExists } from "../../src/zk/client.js";
import { InstanceRegistry } from "../../src/modules/registry.js";
import { TaskQueue } from "../../src/modules/task-queue.js";
import { MessageRouter } from "../../src/modules/message-router.js";
import { LeaderEventBus } from "../../src/leader/event-bus.js";
import { LeaderState } from "../../src/leader/state.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

describe("v0.3.0 Leader-Worker Integration", () => {
  let zk: ZkClient;

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();
  });

  afterAll(async () => {
    await zk.disconnect();
  });

  it("creates /leader EPHEMERAL node", async () => {
    await zk.createLeader({
      instance_id: "test-leader",
      name: "TestLeader",
      role: "leader",
      started_at: new Date().toISOString(),
      version: "0.3.0",
    });
    const data = await zk.getLeader();
    expect(data).not.toBeNull();
    expect(data!.name).toBe("TestLeader");
  });

  it("Worker registers and appears in /instances", async () => {
    const registry = new InstanceRegistry(zk);
    const instance = await registry.register("Jerry", "developer");
    expect(instance.role).toBe("developer");
    const instances = await registry.listAll();
    expect(instances.some((i: Record<string, unknown>) => i.name === "Jerry")).toBe(true);
  });

  it("Task lifecycle: push -> claim -> complete", async () => {
    const taskQueue = new TaskQueue(zk);
    const task = await taskQueue.push("Test task", "Test desc", 1, "tester-1");
    expect(task.status).toBe("pending");
    expect(task.retry_count).toBe(0);

    const claimed = await taskQueue.claim("worker-1");
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("claimed");

    const completed = await taskQueue.complete("worker-1", claimed!.id, "Done");
    expect(completed.status).toBe("completed");
  });

  it("Task lifecycle: push -> claim -> block -> fail -> retry", async () => {
    const taskQueue = new TaskQueue(zk);
    const task = await taskQueue.push("Blockable task", "", 1, "tester-1");
    const claimed = await taskQueue.claim("worker-1");
    expect(claimed).not.toBeNull();

    await taskQueue.block("worker-1", claimed!.id, "Waiting for dependency");

    let tasks = await taskQueue.listTasks("blocked");
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    const failed = await taskQueue.fail("worker-1", claimed!.id, "Dependency timeout");
    expect(failed.status).toBe("failed");
    expect(failed.fail_reason).toBe("Dependency timeout");

    const retried = await taskQueue.retry(claimed!.id);
    expect(retried.status).toBe("pending");
    expect(retried.retry_count).toBe(1);
  });

  it("Message with new fields stores correctly", async () => {
    const registry = new InstanceRegistry(zk);
    const instance = await registry.register("Alice", "developer");

    const router = new MessageRouter(zk);
    const msgs = await router.send("sender-1", "Sender", "Test message", instance.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("direct");

    const messages = await zk.listMessages(instance.id);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("Workers can send messages to each other", async () => {
    const registry = new InstanceRegistry(zk);
    const router = new MessageRouter(zk);

    const alice = await registry.register("Alice", "developer");
    const bob = await registry.register("Bob", "tester");

    await router.send(alice.id, "Alice", "Hello Bob!", bob.id);
    const msgs = await router.poll(bob.id);
    expect(msgs.some((m) => m.content.includes("Hello Bob!"))).toBe(true);
  });
});

describe("Leader EventBus", () => {
  it("dispatches events to onAll handler", () => {
    const bus = new LeaderEventBus();
    const events: string[] = [];
    bus.onAll((e) => events.push(e.type));

    bus.emit({ type: "worker_joined", instanceId: "w1", name: "Jerry" });
    bus.emit({ type: "task_created", taskId: "t1" });

    expect(events).toContain("worker_joined");
    expect(events).toContain("task_created");
  });

  it("dispatches events to specific handler", () => {
    const bus = new LeaderEventBus();
    let count = 0;
    bus.on("task_failed", () => count++);
    bus.on("task_completed", () => count++);

    bus.emit({ type: "task_failed", taskId: "t1" });
    bus.emit({ type: "task_failed", taskId: "t2" });

    expect(count).toBe(2);
  });
});

describe("LeaderState", () => {
  it("tracks worker join and leave", () => {
    const state = new LeaderState();
    state.apply({
      type: "worker_joined",
      instanceId: "w1",
      name: "Jerry",
      instance: { id: "w1", name: "Jerry", role: "developer", status: "idle", current_task_id: null },
    });
    expect(state.workers).toHaveLength(1);
    expect(state.events).toHaveLength(1);

    state.apply({ type: "worker_left", instanceId: "w1", name: "Jerry" });
    expect(state.workers).toHaveLength(0);
    expect(state.events).toHaveLength(2);
  });

  it("tracks task lifecycle events", () => {
    const state = new LeaderState();
    state.apply({ type: "task_created", taskId: "t1", task: { id: "t1", title: "Do something", priority: 1 } });
    expect(state.pendingTasks).toHaveLength(1);

    state.apply({ type: "task_claimed", taskId: "t1", instanceId: "w1" });
    expect(state.pendingTasks).toHaveLength(0);
    expect(state.claimedTasks).toHaveLength(1);

    state.apply({ type: "task_completed", taskId: "t1" });
    expect(state.claimedTasks).toHaveLength(0);
  });

  it("caps event log at 100 entries", () => {
    const state = new LeaderState();
    for (let i = 0; i < 110; i++) {
      state.apply({ type: "task_created", taskId: `t${i}`, task: { id: `t${i}`, title: `Task ${i}` } });
    }
    expect(state.events.length).toBeLessThanOrEqual(100);
  });
});
