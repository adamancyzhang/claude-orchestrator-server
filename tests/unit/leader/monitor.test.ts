import { describe, it, expect } from "vitest";
import { WorkerMonitor } from "../../../src/leader/monitor.js";
import { LeaderEventBus } from "../../../src/leader/event-bus.js";
import { MockZkClient } from "../../fixtures/mock-zk.js";
import { makeInstance } from "../../fixtures/factories.js";
import { captureEvents } from "../../fixtures/helpers.js";
import type { ZkClient } from "../../../src/zk/client.js";

describe("WorkerMonitor.onChildrenChanged", () => {
  it("emits worker_joined for each new instance", async () => {
    const zk = new MockZkClient();
    const a = makeInstance({ name: "A", role: "builder" });
    const b = makeInstance({ name: "B", role: "planner" });
    zk.instances.set(a.id, a);
    zk.instances.set(b.id, b);

    const bus = new LeaderEventBus();
    const events = captureEvents(bus);

    const monitor = new WorkerMonitor(zk as unknown as ZkClient, bus);
    await monitor.start();

    const joined = events.filter((e) => e.type === "worker_joined");
    expect(joined.map((e) => "name" in e ? e.name : null).sort()).toEqual(["A", "B"]);
  });

  it("emits worker_left when an instance disappears", async () => {
    const zk = new MockZkClient();
    const a = makeInstance({ name: "A" });
    zk.instances.set(a.id, a);

    const bus = new LeaderEventBus();
    const events = captureEvents(bus);

    const monitor = new WorkerMonitor(zk as unknown as ZkClient, bus);
    await monitor.start();
    // simulate instance leaving
    zk.instances.delete(a.id);
    zk.fireInstanceWatch();
    await new Promise((r) => setImmediate(r));

    const left = events.filter((e) => e.type === "worker_left");
    expect(left).toHaveLength(1);
    expect("name" in left[0] && left[0].name).toBe("A");
  });

  it("filters out leader role from worker_joined emissions", async () => {
    const zk = new MockZkClient();
    const leader = makeInstance({ name: "L", role: "leader" });
    const worker = makeInstance({ name: "W", role: "builder" });
    zk.instances.set(leader.id, leader);
    zk.instances.set(worker.id, worker);

    const bus = new LeaderEventBus();
    const events = captureEvents(bus);

    const monitor = new WorkerMonitor(zk as unknown as ZkClient, bus);
    await monitor.start();

    const joined = events.filter((e) => e.type === "worker_joined");
    expect(joined).toHaveLength(1);
    expect("name" in joined[0] && joined[0].name).toBe("W");
  });

  it("does not re-emit joined for already-known instances", async () => {
    const zk = new MockZkClient();
    const a = makeInstance({ name: "A" });
    zk.instances.set(a.id, a);

    const bus = new LeaderEventBus();
    const events = captureEvents(bus);

    const monitor = new WorkerMonitor(zk as unknown as ZkClient, bus);
    await monitor.start();
    zk.fireInstanceWatch();
    await new Promise((r) => setImmediate(r));

    const joined = events.filter((e) => e.type === "worker_joined");
    expect(joined).toHaveLength(1);
  });
});
