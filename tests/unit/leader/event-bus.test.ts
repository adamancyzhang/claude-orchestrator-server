import { describe, it, expect, vi } from "vitest";
import { LeaderEventBus } from "../../../src/leader/event-bus.js";

describe("LeaderEventBus", () => {
  it("delivers events to single-type subscribers only when their type fires", () => {
    const bus = new LeaderEventBus();
    const onJoined = vi.fn();
    const onLeft = vi.fn();
    bus.on("worker_joined", onJoined);
    bus.on("worker_left", onLeft);

    bus.emit({ type: "worker_joined", instance: {}, instanceId: "i1", name: "Alice" });

    expect(onJoined).toHaveBeenCalledTimes(1);
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("delivers every event type to an onAll subscriber", () => {
    const bus = new LeaderEventBus();
    const sink = vi.fn();
    bus.onAll(sink);

    bus.emit({ type: "worker_joined", instance: {}, instanceId: "i1", name: "A" });
    bus.emit({ type: "task_created", task: {}, taskId: "t1" });
    bus.emit({ type: "chain_closed", chainId: "c1" });

    expect(sink).toHaveBeenCalledTimes(3);
    const types = sink.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(["worker_joined", "task_created", "chain_closed"]);
  });

  it("supports multiple listeners on the same event type", () => {
    const bus = new LeaderEventBus();
    const a = vi.fn(), b = vi.fn();
    bus.on("task_completed", a);
    bus.on("task_completed", b);
    bus.emit({ type: "task_completed", taskId: "t1" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
