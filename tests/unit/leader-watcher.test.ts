import { describe, it, expect, beforeEach, vi } from "vitest";
import { LeaderWatcher } from "../../src/leader/watcher.js";
import { LeaderEventBus } from "../../src/leader/event-bus.js";
import type { ChainRouter } from "../../src/leader/chain-router.js";

function makeMockZk() {
  return {
    mkdirp: vi.fn().mockResolvedValue(undefined),
    watchMessageDir: vi.fn(),
    getMessage: vi.fn(),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeMockChainRouter() {
  return {
    route: vi.fn().mockResolvedValue(undefined),
  } as any as ChainRouter;
}

function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-001",
    type: "direct",
    from_instance: "sender-1",
    from_name: "Sender",
    from_role: "builder",
    to_instance: "leader-1",
    to_name: null,
    content: "Hello",
    created_at: new Date().toISOString(),
    read: false,
    link: null,
    task_title: null,
    task_description: null,
    task_criteria: null,
    task_doc_path: null,
    result_path: null,
    reply_to: null,
    ...overrides,
  };
}

describe("LeaderWatcher", () => {
  let zk: ReturnType<typeof makeMockZk>;
  let eventBus: LeaderEventBus;
  let chainRouter: ChainRouter;
  let watcher: LeaderWatcher;
  const leaderId = "leader-instance-001";

  beforeEach(() => {
    zk = makeMockZk();
    eventBus = new LeaderEventBus();
    chainRouter = makeMockChainRouter();
    watcher = new LeaderWatcher(zk, eventBus, leaderId, chainRouter);
  });

  describe("start", () => {
    it("creates message directory for leader", async () => {
      await watcher.start();
      expect(zk.mkdirp).toHaveBeenCalled();
    });

    it("begins watch loop on initial children", async () => {
      zk.watchMessageDir.mockResolvedValue(["msg-1"]);
      zk.getMessage.mockResolvedValue(makeMsg({ id: "msg-1", content: "Test" }));

      const events: any[] = [];
      eventBus.on("message_received", (e) => events.push(e));

      await watcher.start();

      // The watch loop processes existing children synchronously from the initial callback
      // We need to wait a tick for async processing
      await new Promise((r) => setTimeout(r, 100));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].content).toBe("Test");
    });
  });

  describe("processMessage", () => {
    it("routes message via ChainRouter", async () => {
      zk.getMessage.mockResolvedValue(makeMsg({ id: "msg-1" }));

      await watcher["processMessage"]("msg-1");

      expect(chainRouter.route).toHaveBeenCalled();
    });

    it("marks message as read after routing", async () => {
      zk.getMessage.mockResolvedValue(makeMsg({ id: "msg-1" }));

      await watcher["processMessage"]("msg-1");

      expect(zk.updateMessage).toHaveBeenCalled();
      const callArgs = zk.updateMessage.mock.calls[0];
      expect(callArgs[1]).toBe("msg-1");
    });

    it("skips already-read messages", async () => {
      zk.getMessage.mockResolvedValue(makeMsg({ id: "msg-1", read: true }));

      await watcher["processMessage"]("msg-1");

      expect(chainRouter.route).not.toHaveBeenCalled();
    });

    it("skips when message data is null", async () => {
      zk.getMessage.mockResolvedValue(null);

      await watcher["processMessage"]("msg-1");

      expect(chainRouter.route).not.toHaveBeenCalled();
    });

    it("processes message when not already in-flight", async () => {
      zk.getMessage.mockResolvedValue(makeMsg({ id: "msg-1" }));

      await watcher["processMessage"]("msg-1");

      expect(chainRouter.route).toHaveBeenCalledTimes(1);
      expect(zk.updateMessage).toHaveBeenCalledTimes(1);
    });

    it("emits message_received and message_processed events", async () => {
      zk.getMessage.mockResolvedValue(makeMsg({ id: "msg-1" }));

      const events: any[] = [];
      eventBus.onAll((e) => events.push(e));

      await watcher["processMessage"]("msg-1");

      expect(events.some((e) => e.type === "message_received")).toBe(true);
      expect(events.some((e) => e.type === "message_processed")).toBe(true);
    });

    it("throws when routing fails (route is not caught)", async () => {
      zk.getMessage.mockResolvedValue(makeMsg({ id: "msg-1" }));
      (chainRouter.route as any).mockRejectedValue(new Error("Route failed"));

      await expect(watcher["processMessage"]("msg-1")).rejects.toThrow("Route failed");
    });
  });

  describe("stop", () => {
    it("sets stopped flag", () => {
      watcher.stop();
      // After stop, processMessage should skip
      expect(watcher["stopped"]).toBe(true);
    });
  });
});
