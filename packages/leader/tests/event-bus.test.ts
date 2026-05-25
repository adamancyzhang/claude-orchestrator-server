// CORE-RETENTION
// Locks in: LeaderEventBus's typed dispatch — on(type, cb) receives only
// matching events; onAny(cb) receives every event in emit order;
// unsubscribe functions returned by both stop further invocations;
// multiple subscribers to the same type all receive each event.
// Critical because: this bus is the single fan-out point between the
// leader's recovery / orchestration / TUI / chain-router / watcher
// modules. A type-routing regression (e.g. cb fires for the wrong
// event variant cast to its own discriminant) silently corrupts every
// downstream consumer; a leaky unsubscribe accumulates listeners across
// long-running orchestrator sessions and eventually triggers
// MaxListenersExceededWarning then memory bloat.
// Primary sources: packages/leader/src/event-bus.ts

import { describe, expect, it } from "vitest";
import {
  asInstanceId,
  asTaskId,
  type LeaderEvent,
} from "@co/contracts";
import { LeaderEventBus } from "../src/event-bus.js";

function ev(name: string): Extract<LeaderEvent, { type: "debug_info" }> {
  return { type: "debug_info", message: name };
}

describe("LeaderEventBus.on — typed dispatch", () => {
  it("subscribers only receive events of their requested type", () => {
    const bus = new LeaderEventBus();
    const debugReceived: string[] = [];
    const chainClosedReceived: string[] = [];

    bus.on("debug_info", (e) => debugReceived.push(e.message));
    bus.on("chain_closed", (e) => chainClosedReceived.push(e.chain_id));

    bus.emit(ev("hello"));
    bus.emit({ type: "chain_closed", chain_id: "chain-1" as never });
    bus.emit(ev("world"));

    expect(debugReceived).toEqual(["hello", "world"]);
    expect(chainClosedReceived).toEqual(["chain-1"]);
  });

  it("multiple subscribers to the same type each receive every matching event", () => {
    const bus = new LeaderEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.on("debug_info", (e) => a.push(e.message));
    bus.on("debug_info", (e) => b.push(e.message));

    bus.emit(ev("one"));
    bus.emit(ev("two"));

    expect(a).toEqual(["one", "two"]);
    expect(b).toEqual(["one", "two"]);
  });
});

describe("LeaderEventBus.onAny", () => {
  it("receives every event regardless of type, in emit order", () => {
    const bus = new LeaderEventBus();
    const all: string[] = [];

    bus.onAny((e) => {
      if (e.type === "debug_info") all.push(`d:${e.message}`);
      else if (e.type === "chain_closed") all.push(`c:${e.chain_id}`);
      else if (e.type === "task_failed") all.push(`f:${e.task_id}`);
    });

    bus.emit(ev("a"));
    bus.emit({ type: "chain_closed", chain_id: "ch-1" as never });
    bus.emit({
      type: "task_failed",
      task_id: asTaskId("t-1"),
      reason: "x",
    });
    bus.emit(ev("b"));

    expect(all).toEqual(["d:a", "c:ch-1", "f:t-1", "d:b"]);
  });
});

describe("LeaderEventBus — unsubscribe", () => {
  it("the function returned by on() stops further invocations", () => {
    const bus = new LeaderEventBus();
    const got: string[] = [];
    const off = bus.on("debug_info", (e) => got.push(e.message));

    bus.emit(ev("one"));
    off();
    bus.emit(ev("two"));

    expect(got).toEqual(["one"]);
  });

  it("the function returned by onAny() stops further invocations", () => {
    const bus = new LeaderEventBus();
    const got: string[] = [];
    const off = bus.onAny((e) => {
      if (e.type === "debug_info") got.push(e.message);
    });

    bus.emit(ev("alpha"));
    off();
    bus.emit(ev("beta"));

    expect(got).toEqual(["alpha"]);
  });

  it("on() and onAny() unsubscribes are independent", () => {
    const bus = new LeaderEventBus();
    const typed: string[] = [];
    const wild: string[] = [];

    const offTyped = bus.on("debug_info", (e) => typed.push(e.message));
    const offWild = bus.onAny((e) => {
      if (e.type === "debug_info") wild.push(e.message);
    });

    bus.emit(ev("one"));
    offTyped();
    bus.emit(ev("two"));
    offWild();
    bus.emit(ev("three"));

    expect(typed).toEqual(["one"]);
    expect(wild).toEqual(["one", "two"]);
  });

  it("subscribers added after emit do not receive prior events", () => {
    // The bus is fire-and-forget; there is no replay. Locked in so callers
    // know they must subscribe before triggering work.
    const bus = new LeaderEventBus();
    bus.emit(ev("missed"));

    const got: string[] = [];
    bus.on("debug_info", (e) => got.push(e.message));
    bus.emit(ev("seen"));

    expect(got).toEqual(["seen"]);
  });
});
