// CORE-RETENTION
// Locks in: LeaderEventBus typed event dispatch via IEventBus<LeaderEvent>.
//   on(type, cb) filters by discriminant; onAny(cb) sees every event.
//   Returned unsubscribers remove listeners.
// Core path because: state, TUI, recovery, monitor, etc all subscribe via
//   the bus — a regression here silently breaks every TUI update.
// Owner subsystem: leader.
// Primary source files exercised:
//   - packages/leader/src/event-bus.ts

import { describe, expect, it, vi } from "vitest";
import { LeaderEventBus } from "../../../src/index.js";
import { asInstanceId } from "@co/contracts";

describe("LeaderEventBus", () => {
  it("invokes on(type) only for matching events", () => {
    const bus = new LeaderEventBus();
    const cb = vi.fn();
    bus.on("worker_left", cb);
    bus.emit({ type: "worker_left", instance_id: asInstanceId("a"), name: "Tom" });
    bus.emit({
      type: "task_blocked",
      task_id: "t" as never,
      reason: "x",
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("invokes onAny for every event", () => {
    const bus = new LeaderEventBus();
    const cb = vi.fn();
    bus.onAny(cb);
    bus.emit({ type: "worker_left", instance_id: asInstanceId("a"), name: "Tom" });
    bus.emit({ type: "chain_closed", chain_id: "c-1" as never });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("returned off() unsubscribes", () => {
    const bus = new LeaderEventBus();
    const cb = vi.fn();
    const off = bus.on("worker_left", cb);
    off();
    bus.emit({ type: "worker_left", instance_id: asInstanceId("a"), name: "Tom" });
    expect(cb).not.toHaveBeenCalled();
  });
});
