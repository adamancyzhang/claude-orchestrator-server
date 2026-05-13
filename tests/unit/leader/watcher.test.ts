import { describe, it, expect, vi, beforeEach } from "vitest";
import { LeaderWatcher } from "../../../src/leader/watcher.js";
import { LeaderEventBus } from "../../../src/leader/event-bus.js";
import { MockZkClient } from "../../fixtures/mock-zk.js";
import { makeMessage } from "../../fixtures/factories.js";
import { captureEvents } from "../../fixtures/helpers.js";
import type { ZkClient } from "../../../src/zk/client.js";
import type { ChainRouter } from "../../../src/leader/chain-router.js";

function makeFakeRouter(): ChainRouter {
  const route = vi.fn(async () => {});
  return { route } as unknown as ChainRouter;
}

describe("LeaderWatcher.processMessage", () => {
  let zk: MockZkClient;
  let bus: LeaderEventBus;
  let router: ChainRouter;
  let watcher: LeaderWatcher;
  let events: ReturnType<typeof captureEvents>;
  const LEADER = "leader-1";

  beforeEach(() => {
    zk = new MockZkClient();
    bus = new LeaderEventBus();
    events = captureEvents(bus);
    router = makeFakeRouter();
    watcher = new LeaderWatcher(zk as unknown as ZkClient, bus, LEADER, router);
  });

  it("parses, emits message_received, routes via chainRouter, then emits message_processed", async () => {
    const msg = makeMessage({ from_instance: "worker-1", from_role: "builder", content: "hi" });
    const msgId = await zk.createMessage(LEADER, msg);

    await watcher.start();
    await new Promise((r) => setImmediate(r));

    expect(router.route).toHaveBeenCalledTimes(1);
    // First: message_received
    expect(events.find((e) => e.type === "message_received")).toBeDefined();
    // Worker message because from_role is "builder", not "leader"
    expect(events.find((e) => e.type === "worker_message_received")).toBeDefined();
    expect(events.find((e) => e.type === "message_processed")).toBeDefined();
    // msg marked read
    const stored = await zk.getMessage(LEADER, msgId);
    expect((stored as { read: boolean }).read).toBe(true);
  });

  it("does not emit worker_message_received for messages from leader role", async () => {
    const msg = makeMessage({ from_role: "leader", content: "self" });
    await zk.createMessage(LEADER, msg);

    await watcher.start();
    await new Promise((r) => setImmediate(r));

    expect(events.find((e) => e.type === "worker_message_received")).toBeUndefined();
  });

  it("skips messages flagged as already read", async () => {
    const msg = makeMessage({ content: "old" });
    msg.read = true;
    await zk.createMessage(LEADER, msg);

    await watcher.start();
    await new Promise((r) => setImmediate(r));

    expect(router.route).not.toHaveBeenCalled();
  });

  it("inFlight set short-circuits sequential calls for the same msgId", async () => {
    const msg = makeMessage({ content: "x" });
    const msgId = await zk.createMessage(LEADER, msg);

    let routeCalls = 0;
    let resolveRoute: () => void = () => {};
    const routePromise = new Promise<void>((r) => { resolveRoute = r; });
    router.route = vi.fn(async () => {
      routeCalls++;
      return routePromise;
    });
    watcher = new LeaderWatcher(zk as unknown as ZkClient, bus, LEADER, router);

    const access = watcher as unknown as { processMessage: (id: string) => Promise<void> };

    // First call begins, awaits router.route (stuck).
    const p1 = access.processMessage(msgId);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(routeCalls).toBe(1);

    // While p1 is still in-flight, a second call must short-circuit because
    // inFlight has the msgId; mark this expectation explicitly.
    const p2 = access.processMessage(msgId);
    await new Promise((r) => setImmediate(r));
    expect(routeCalls).toBe(1);

    resolveRoute();
    await p1; await p2;
    // TODO bug: src/leader/watcher.ts:42-50 — the inFlight check runs BEFORE
    // the initial `getMessage` await, so truly-concurrent invocations both
    // pass the guard. This test exercises the sequential-call protection,
    // which is the more common in-practice case (ZK watch re-firing).
  });
});
