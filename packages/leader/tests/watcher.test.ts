// CORE-RETENTION
// Locks in: LeaderWatcher's message handling — emits the trio
// (message_received → worker_message_received → message_processed) for
// worker → leader direct messages; skips worker_message_received when
// the message originates from the leader itself or is not "direct";
// reformats decision-JSON content via formatWorkerMessageContent into a
// human-readable "[decision]: reason → next_link" form while leaving
// non-JSON content untouched; a ChainRouter.route() rejection is logged
// at error level and does NOT block the final message_processed event;
// duplicate message ids are skipped via the inFlight set so the trio is
// emitted exactly once; stop() silences further callbacks.
// Critical because: LeaderWatcher is the single funnel for every
// worker-to-leader signal. A mis-emitted event sequence corrupts the
// TUI worker-messages panel and message-history audit; a crash on
// ChainRouter rejection halts the entire leader event loop; missing
// inFlight dedup re-processes the same message and double-emits to the
// bus.
// Primary sources: packages/leader/src/watcher.ts

import { describe, expect, it } from "vitest";
import {
  asInstanceId,
  asMessageId,
  type IMessageRouter,
  type ILogger,
  type LeaderEvent,
  type Message,
  type SendMessageInput,
} from "@co/contracts";
import { LeaderEventBus } from "../src/event-bus.js";
import { LeaderWatcher } from "../src/watcher.js";
import type { ChainRouter } from "../src/chain-router.js";

// TRUST-JUSTIFICATION: TestMessageRouter is a fake IMessageRouter that
// captures the waitForMessage callback so the test can drive messages
// at exact timing.
// Downstream: IMessageRouter is a contracts interface — the boundary
// LeaderWatcher actually consumes (start() only calls waitForMessage).
// Reason: leader does not depend on @co/infra so a real MessageRouter +
// InMemoryZkClient is not reachable here, and the watcher's contract
// is end-to-end on the callback semantics, not on ZK storage.
// Evidence: the real MessageRouter is covered by
// coordination/tests/message-router.test.ts. Methods unused by
// LeaderWatcher throw, so any silent reliance surfaces immediately.
class TestMessageRouter implements IMessageRouter {
  private cb: ((msg: Message) => void) | null = null;

  deliver(msg: Message): void {
    this.cb?.(msg);
  }

  async waitForMessage(
    _instanceId: unknown,
    cb: (msg: Message) => void,
  ): Promise<void> {
    this.cb = cb;
  }

  async send(_: SendMessageInput): Promise<Message> {
    throw new Error("TestMessageRouter.send unused");
  }
  async poll(): Promise<Message[]> {
    throw new Error("TestMessageRouter.poll unused");
  }
  async dismiss(): Promise<void> {
    throw new Error("TestMessageRouter.dismiss unused");
  }
}

// TRUST-JUSTIFICATION: CapturingChainRouter is a fake ChainRouter that
// records each route() call.
// Downstream: ChainRouter.route — the chain-router subsystem itself is
// internally complex and has its own test target (chain-router-helpers).
// Reason: LeaderWatcher's contract is "emit the message trio around a
// route() invocation", not "exercise ChainRouter's routing
// algorithm." The route() call is the protocol boundary between the
// watcher and the router.
// Evidence: tests/chain-router-helpers.test.ts covers ChainRouter's
// decision matrix and helpers in isolation.
class CapturingChainRouter {
  public readonly routed: Message[] = [];
  private rejectNext = false;

  primeRejection(): void {
    this.rejectNext = true;
  }

  async route(msg: Message): Promise<void> {
    this.routed.push(msg);
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("synthetic chain-router failure");
    }
  }
}

// CapturingLogger is a test data structure (not a mock) — no
// TRUST-JUSTIFICATION needed.
class CapturingLogger implements ILogger {
  public readonly errors: Array<{ msg: string; extras?: unknown }> = [];
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(msg: string, extras?: unknown): void {
    this.errors.push({ msg, extras });
  }
  child(): ILogger {
    return this;
  }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: asMessageId("msg-1"),
    type: "direct",
    from_instance: asInstanceId("worker-a"),
    from_name: "WorkerA",
    from_role: "executor",
    to_instance: asInstanceId("leader"),
    to_name: "Leader",
    content: "hello",
    link: null,
    chain_id: null,
    task_id: null,
    task_title: null,
    task_description: null,
    task_criteria: null,
    result_path: null,
    original_requirement_path: null,
    reply_to: null,
    read: false,
    created_at: "2026-05-25T00:00:00Z",
    ...overrides,
  };
}

const LEADER_ID = asInstanceId("leader");

function collect(bus: LeaderEventBus): LeaderEvent[] {
  const events: LeaderEvent[] = [];
  bus.onAny((e) => events.push(e));
  return events;
}

async function flushPromises(): Promise<void> {
  // processMessage is dispatched via `void this.processMessage(msg)`,
  // so we need to let the microtask queue drain before asserting.
  await new Promise((r) => setTimeout(r, 5));
}

describe("LeaderWatcher — message event trio", () => {
  it("emits message_received → worker_message_received → message_processed in order", async () => {
    const router = new TestMessageRouter();
    const chainRouter = new CapturingChainRouter();
    const bus = new LeaderEventBus();
    const events = collect(bus);

    const watcher = new LeaderWatcher(
      router,
      bus,
      chainRouter as unknown as ChainRouter,
      LEADER_ID,
      new CapturingLogger(),
    );
    await watcher.start();

    const msg = makeMessage({
      id: asMessageId("m-100"),
      content: "doing the thing",
      link: "execute",
      created_at: "2026-05-25T01:00:00Z",
    });
    router.deliver(msg);
    await flushPromises();

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "message_received",
      "worker_message_received",
      "message_processed",
    ]);

    const wmr = events[1] as Extract<
      LeaderEvent,
      { type: "worker_message_received" }
    >;
    expect(wmr.instance_id).toBe(msg.from_instance);
    expect(wmr.content).toBe("doing the thing");
    expect(wmr.link).toBe("execute");
    expect(wmr.timestamp).toBe("2026-05-25T01:00:00Z");

    expect(chainRouter.routed).toHaveLength(1);
    expect(chainRouter.routed[0].id).toBe(msg.id);

    watcher.stop();
  });
});

describe("LeaderWatcher — worker_message_received gating", () => {
  it("does NOT emit worker_message_received when the message originates from the leader itself", async () => {
    const router = new TestMessageRouter();
    const bus = new LeaderEventBus();
    const events = collect(bus);

    const watcher = new LeaderWatcher(
      router,
      bus,
      new CapturingChainRouter() as unknown as ChainRouter,
      LEADER_ID,
      new CapturingLogger(),
    );
    await watcher.start();

    router.deliver(makeMessage({ from_instance: LEADER_ID, type: "direct" }));
    await flushPromises();

    expect(events.filter((e) => e.type === "worker_message_received")).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual([
      "message_received",
      "message_processed",
    ]);

    watcher.stop();
  });

  it("does NOT emit worker_message_received when the message type is not 'direct'", async () => {
    const router = new TestMessageRouter();
    const bus = new LeaderEventBus();
    const events = collect(bus);

    const watcher = new LeaderWatcher(
      router,
      bus,
      new CapturingChainRouter() as unknown as ChainRouter,
      LEADER_ID,
      new CapturingLogger(),
    );
    await watcher.start();

    router.deliver(makeMessage({ type: "completion_report" }));
    await flushPromises();

    expect(events.filter((e) => e.type === "worker_message_received")).toHaveLength(0);

    watcher.stop();
  });
});

describe("LeaderWatcher — formatWorkerMessageContent", () => {
  it("transforms decision JSON into '[decision]: reason → next_link'", async () => {
    const router = new TestMessageRouter();
    const bus = new LeaderEventBus();
    const events = collect(bus);

    const watcher = new LeaderWatcher(
      router,
      bus,
      new CapturingChainRouter() as unknown as ChainRouter,
      LEADER_ID,
      new CapturingLogger(),
    );
    await watcher.start();

    const decision = JSON.stringify({
      decision: "activate_next",
      reason: "tests pass",
      next_link: "execute",
    });
    router.deliver(makeMessage({ content: decision }));
    await flushPromises();

    const wmr = events.find((e) => e.type === "worker_message_received") as
      | Extract<LeaderEvent, { type: "worker_message_received" }>
      | undefined;
    expect(wmr).toBeDefined();
    expect(wmr!.content).toBe("[activate_next]: tests pass → execute");

    watcher.stop();
  });

  it("leaves non-JSON content untouched", async () => {
    const router = new TestMessageRouter();
    const bus = new LeaderEventBus();
    const events = collect(bus);

    const watcher = new LeaderWatcher(
      router,
      bus,
      new CapturingChainRouter() as unknown as ChainRouter,
      LEADER_ID,
      new CapturingLogger(),
    );
    await watcher.start();

    router.deliver(makeMessage({ content: "not json" }));
    await flushPromises();

    const wmr = events.find((e) => e.type === "worker_message_received") as
      | Extract<LeaderEvent, { type: "worker_message_received" }>
      | undefined;
    expect(wmr!.content).toBe("not json");

    watcher.stop();
  });
});

describe("LeaderWatcher — error and dedup paths", () => {
  it("ChainRouter.route() rejection is logged at error level but message_processed still emits", async () => {
    const router = new TestMessageRouter();
    const chainRouter = new CapturingChainRouter();
    const logger = new CapturingLogger();
    const bus = new LeaderEventBus();
    const events = collect(bus);

    const watcher = new LeaderWatcher(
      router,
      bus,
      chainRouter as unknown as ChainRouter,
      LEADER_ID,
      logger,
    );
    await watcher.start();

    chainRouter.primeRejection();
    router.deliver(makeMessage({ id: asMessageId("rebel") }));
    await flushPromises();

    expect(events.map((e) => e.type)).toContain("message_processed");
    expect(logger.errors.some((e) => e.msg.includes("chain router failed"))).toBe(true);

    watcher.stop();
  });

  it("duplicate message id is skipped via inFlight dedup — trio emits exactly once", async () => {
    const router = new TestMessageRouter();
    const bus = new LeaderEventBus();
    const events = collect(bus);

    const watcher = new LeaderWatcher(
      router,
      bus,
      new CapturingChainRouter() as unknown as ChainRouter,
      LEADER_ID,
      new CapturingLogger(),
    );
    await watcher.start();

    const msg = makeMessage({ id: asMessageId("same") });
    router.deliver(msg);
    router.deliver(msg);
    await flushPromises();

    // Trio emits exactly once for the duplicate id (3 events total, not 6).
    expect(events).toHaveLength(3);

    watcher.stop();
  });
});

describe("LeaderWatcher — stop()", () => {
  it("after stop(), incoming messages produce no bus emissions", async () => {
    const router = new TestMessageRouter();
    const bus = new LeaderEventBus();
    const events = collect(bus);

    const watcher = new LeaderWatcher(
      router,
      bus,
      new CapturingChainRouter() as unknown as ChainRouter,
      LEADER_ID,
      new CapturingLogger(),
    );
    await watcher.start();
    watcher.stop();
    events.length = 0;

    router.deliver(makeMessage({ id: asMessageId("post-stop") }));
    await flushPromises();

    expect(events).toHaveLength(0);
  });
});
