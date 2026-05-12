import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

const TEST_ROOT = vi.hoisted(() => {
  const root = `/test-fullchain-${Date.now()}`;
  process.env.ZK_ROOT_PATH = root;
  return root;
});

import { ZkClient } from "../../src/zk/client.js";
import { TaskQueue } from "../../src/modules/task-queue.js";
import { MessageRouter } from "../../src/modules/message-router.js";
import { InstanceRegistry } from "../../src/modules/registry.js";
import { ChainRouter } from "../../src/leader/chain-router.js";
import { TaskRecovery } from "../../src/leader/recovery.js";
import { LeaderEventBus } from "../../src/leader/event-bus.js";
import { ClaudeRunner } from "../../src/executor/runner.js";
import type { Message } from "../../src/models/schemas.js";

function makeFakeRunner() {
  return {
    taskDocPath: vi.fn().mockReturnValue("/tmp/fake-task-doc.md"),
    logPath: vi.fn(),
    resultPath: vi.fn(),
    evalLogPath: vi.fn(),
    evalResultPath: vi.fn(),
    run: vi.fn(),
    ensureDir: vi.fn(),
  } as any as ClaudeRunner;
}

describe("Full Chain Integration", () => {
  let zk: ZkClient;
  let taskQueue: TaskQueue;
  let messageRouter: MessageRouter;
  let registry: InstanceRegistry;
  let eventBus: LeaderEventBus;
  let chainRouter: ChainRouter;
  let recovery: TaskRecovery;
  let runner: ClaudeRunner;

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();
    taskQueue = new TaskQueue(zk);
    messageRouter = new MessageRouter(zk);
    registry = new InstanceRegistry(zk);
    eventBus = new LeaderEventBus();
    runner = makeFakeRunner();
    chainRouter = new ChainRouter(zk, taskQueue, messageRouter, eventBus, "leader-001", "Leader", runner);
    recovery = new TaskRecovery(zk, eventBus);
  });

  afterAll(async () => {
    await zk.disconnect();
  });

  describe("task block / fail / retry cycle", () => {
    it("push → claim → block → fail → retry", async () => {
      const task = await taskQueue.push("Integration task", "Full cycle test", 1, "leader-001");
      expect(task.status).toBe("pending");

      // Claim
      const claimed = await taskQueue.claim("worker-int-1");
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe("claimed");

      // Block
      const blocked = await taskQueue.block("worker-int-1", claimed!.id, "Waiting for dependency");
      expect(blocked.status).toBe("blocked");
      expect(blocked.blocked_reason).toBe("Waiting for dependency");

      // Fail
      const failed = await taskQueue.fail("worker-int-1", claimed!.id, "Timed out");
      expect(failed.status).toBe("failed");
      expect(failed.fail_reason).toBe("Timed out");

      // Retry
      const retried = await taskQueue.retry(claimed!.id);
      expect(retried.status).toBe("pending");
      expect(retried.retry_count).toBe(1);
      expect(retried.title).toBe("Integration task");
    });
  });

  describe("worker disconnect recovery", () => {
    // Drain pending tasks before recovery tests
    async function drainAllPending() {
      const drainer = await registry.register("FCDrainer", "builder");
      let d = await taskQueue.claim(drainer.id);
      while (d) {
        try { await taskQueue.complete(drainer.id, d.id, "drained"); } catch {}
        d = await taskQueue.claim(drainer.id);
      }
    }

    it("orphaned task is re-queued on worker disconnect", async () => {
      await drainAllPending();

      const worker = await registry.register("DisconnectWorker", "builder");
      const task = await taskQueue.push("Disconnect test", "", 1, "leader-001");
      const claimed = await taskQueue.claim(worker.id);
      expect(claimed).not.toBeNull();

      // Simulate disconnect
      await registry.unregister(worker.id);

      const recoveredEvents: any[] = [];
      eventBus.on("task_recovered", (e) => recoveredEvents.push(e));

      await recovery.scanOrphans();

      expect(recoveredEvents.length).toBe(1);
      expect(recoveredEvents[0].taskId).toBe(claimed!.id);
      expect(recoveredEvents[0].retryCount).toBe(1);
    });

    it("task permanently fails after 3 recoveries with same task data", async () => {
      await drainAllPending();

      // Worker 1
      const w1 = await registry.register("FullChainW1b", "builder");
      const task = await taskQueue.push("Perm fail task", "", 1, "leader-001");
      const c1 = await taskQueue.claim(w1.id);
      expect(c1).not.toBeNull();
      await recovery["recoverOrphanedTasks"](w1.id);

      // Worker 2
      const w2 = await registry.register("FullChainW2b", "builder");
      const c2 = await taskQueue.claim(w2.id);
      expect(c2).not.toBeNull();
      await recovery["recoverOrphanedTasks"](w2.id);

      // Worker 3
      const w3 = await registry.register("FullChainW3b", "builder");
      const c3 = await taskQueue.claim(w3.id);
      expect(c3).not.toBeNull();
      await recovery["recoverOrphanedTasks"](w3.id);

      // Worker 4 — should trigger permanent failure
      const w4 = await registry.register("FullChainW4b", "builder");
      const c4 = await taskQueue.claim(w4.id);
      expect(c4).not.toBeNull();

      const failEvents: any[] = [];
      eventBus.on("task_failed", (e) => failEvents.push(e));

      await recovery["recoverOrphanedTasks"](w4.id);

      expect(failEvents.length).toBe(1);
      expect(failEvents[0].reason).toBe("Max retries exceeded");
    });
  });

  describe("chain routing", () => {
    it("handles task_defs and creates tasks for each link", async () => {
      const chainDef = {
        chain_id: "chain-test-001",
        chain_title: "Test Chain",
        tasks: {
          plan: null,
          build: { title: "Build feature", description: "Implement X", criteria: "Passes tests", priority: 1 },
          verify: { title: "Verify feature", description: "Test X", criteria: "All green", priority: 1 },
          review: { title: "Review feature", description: "Review X", criteria: "Approved", priority: 1 },
          accept: { title: "Accept feature", description: "Accept X", criteria: "Signed off", priority: 1 },
        },
      };

      const createdEvents: any[] = [];
      const chainEvents: any[] = [];
      eventBus.on("task_created", (e) => createdEvents.push(e));
      eventBus.on("chain_activated", (e) => chainEvents.push(e));

      const msg = {
        id: "msg-defs-1",
        type: "direct" as const,
        from_instance: "planner-1",
        from_name: "Planner",
        from_role: "planner",
        to_instance: "leader-001",
        content: JSON.stringify(chainDef),
        created_at: new Date().toISOString(),
        read: false,
        link: "task_defs",
        task_title: null,
        task_description: null,
        task_criteria: null,
        task_doc_path: null,
        result_path: null,
        reply_to: null,
        to_name: null,
      };

      await chainRouter.route(msg);

      expect(createdEvents.length).toBe(4); // build, verify, review, accept
      expect(chainEvents.length).toBe(1);
      expect(chainEvents[0].chainId).toBe("chain-test-001");
    });

    it("handles activate_next completion report", async () => {
      const events: any[] = [];
      eventBus.on("task_created", (e) => events.push(e));

      const report = {
        decision: "activate_next",
        reason: "Build looks good",
        nextLink: "verify",
      };

      const msg = {
        id: "msg-report-1",
        type: "direct" as const,
        from_instance: "builder-1",
        from_name: "Builder",
        from_role: "builder",
        to_instance: "leader-001",
        content: JSON.stringify(report),
        created_at: new Date().toISOString(),
        read: false,
        link: "build",
        task_title: null,
        task_description: null,
        task_criteria: null,
        task_doc_path: null,
        result_path: null,
        reply_to: null,
        to_name: null,
      };

      await chainRouter.route(msg);

      expect(events.length).toBe(1);
    });

    it("handles close_chain completion report for accept link (no crash)", async () => {
      const report = {
        decision: "close_chain",
        reason: "All criteria met, accepting",
      };

      const msg = {
        id: "msg-close-1",
        type: "direct" as const,
        from_instance: "accepter-1",
        from_name: "Accepter",
        from_role: "accepter",
        to_instance: "leader-001",
        content: JSON.stringify(report),
        created_at: new Date().toISOString(),
        read: false,
        link: "accept",
        task_title: null,
        task_description: null,
        task_criteria: null,
        task_doc_path: null,
        result_path: null,
        reply_to: null,
        to_name: null,
      } as Message;

      // Should not throw
      await chainRouter.route(msg);
    });

    it("handles feedback completion report", async () => {
      const builder = await registry.register("FeedbackBuilder", "builder");

      const report = {
        decision: "feedback",
        reason: "Needs more work",
        feedback: "Please fix the edge case",
      };

      const msg = {
        id: "msg-feedback-1",
        type: "direct" as const,
        from_instance: builder.id,
        from_name: "Verifier",
        from_role: "verifier",
        to_instance: "leader-001",
        content: JSON.stringify(report),
        created_at: new Date().toISOString(),
        read: false,
        link: "verify",
        task_title: null,
        task_description: null,
        task_criteria: null,
        task_doc_path: null,
        result_path: null,
        reply_to: null,
        to_name: null,
      } as Message;

      await chainRouter.route(msg);

      // Feedback should create a message to the worker
      const msgs = await messageRouter.poll(builder.id);
      const feedbackMsg = msgs.find((m) => m.content === "Please fix the edge case");
      expect(feedbackMsg).toBeDefined();
    });

    it("falls back to auto-advance on non-JSON completion report", async () => {
      const events: any[] = [];
      eventBus.on("task_created", (e) => events.push(e));

      const msg = {
        id: "msg-fallback-1",
        type: "direct" as const,
        from_instance: "builder-1",
        from_name: "Builder",
        from_role: "builder",
        to_instance: "leader-001",
        content: "This is not valid JSON, just plain text",
        created_at: new Date().toISOString(),
        read: false,
        link: "build",
        task_title: null,
        task_description: null,
        task_criteria: null,
        task_doc_path: null,
        result_path: null,
        reply_to: null,
        to_name: null,
      } as Message;

      await chainRouter.route(msg);

      // Should auto-advance: build → verify
      expect(events.length).toBe(1);
    });
  });

  describe("role-weight claiming in context of chain", () => {
    it("accepter worker claims accept tasks before other roles", async () => {
      const accepter = await registry.register("ChainAccepter", "accepter");
      const builder = await registry.register("ChainBuilder", "builder");

      // Push tasks for different links
      await taskQueue.push("Build task", "", 0, "leader-001", undefined, undefined, undefined, "build", "chain-x");
      const acceptTask = await taskQueue.push("Accept task", "", 2, "leader-001", undefined, undefined, undefined, "accept", "chain-x");

      // Accepter claims — should prefer accept task despite lower priority
      const claimed = await taskQueue.claim(accepter.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.link).toBe("accept");
    });
  });
});
