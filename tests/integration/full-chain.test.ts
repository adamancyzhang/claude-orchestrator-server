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
import { TemplateEngine } from "../../src/executor/template.js";
import type { Message } from "../../src/models/schemas.js";

function makeFakeRunner() {
  return {
    taskDocPath: vi.fn((taskId?: string) => `/tmp/fake-task-${taskId ?? "unknown"}.md`),
    logPath: vi.fn((key?: string) => `/tmp/fake-log-${key ?? "unknown"}.log`),
    resultPath: vi.fn((key?: string) => `/tmp/fake-result-${key ?? "unknown"}.md`),
    evalLogPath: vi.fn(),
    evalResultPath: vi.fn(),
    run: vi.fn().mockResolvedValue({ code: 0 }),
    ensureDir: vi.fn(),
  } as any as ClaudeRunner;
}

function makeFakeTemplateEngine() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    render: vi.fn(),
    loadAll: vi.fn(),
    loadFile: vi.fn(),
  } as any as TemplateEngine;
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
  let templateEngine: TemplateEngine;

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();
    taskQueue = new TaskQueue(zk);
    messageRouter = new MessageRouter(zk);
    registry = new InstanceRegistry(zk);
    eventBus = new LeaderEventBus();
    runner = makeFakeRunner();
    templateEngine = makeFakeTemplateEngine();
    chainRouter = new ChainRouter(zk, taskQueue, messageRouter, eventBus, "leader-001", "Leader", runner, templateEngine);
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
      const drainer = await registry.register("FCDrainerRecovery", "builder");
      let d = await taskQueue.claim(drainer.id);
      while (d) {
        try { await taskQueue.complete(drainer.id, d.id, "drained"); } catch {}
        d = await taskQueue.claim(drainer.id);
      }
      try { await registry.unregister(drainer.id); } catch {}
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

  // ─── Full E2E Chain Tests (no claude-cli execution) ───

  describe("requirement routing", () => {
    it("forwards requirement (no-link message) to planner worker", async () => {
      const planner = await registry.register("E2EPlanner", "planner");

      const msg: Message = {
        id: "msg-req-1",
        type: "direct",
        from_instance: "leader-001",
        from_name: "Leader",
        from_role: "leader",
        to_instance: "leader-001",
        content: "Build a login page with 2FA support",
        created_at: new Date().toISOString(),
        read: false,
        link: null,
        task_title: null,
        task_description: null,
        task_criteria: null,
        task_doc_path: null,
        result_path: null,
        reply_to: null,
        to_name: null,
      };

      await chainRouter.route(msg);

      // Verify message was forwarded to planner
      const msgs = await messageRouter.poll(planner.id);
      const forwarded = msgs.find((m) => m.content === "Build a login page with 2FA support");
      expect(forwarded).toBeDefined();
      expect(forwarded!.link).toBe("decompose");
      expect(forwarded!.from_role).toBe("leader");
    });

    it("requirement with no planner worker handles gracefully", async () => {
      // Ensure no planner worker exists (drain any existing)
      const instances = await registry.listAll();
      const planners = instances.filter((i: Record<string, unknown>) => i.role === "planner");
      for (const p of planners) {
        try { await registry.unregister(p.id as string); } catch {}
      }

      const msg: Message = {
        id: "msg-req-nop",
        type: "direct",
        from_instance: "leader-001",
        from_name: "Leader",
        from_role: "leader",
        to_instance: "leader-001",
        content: "Some requirement",
        created_at: new Date().toISOString(),
        read: false,
        link: null,
        task_title: null,
        task_description: null,
        task_criteria: null,
        task_doc_path: null,
        result_path: null,
        reply_to: null,
        to_name: null,
      };

      // Should not throw even with no planner
      await chainRouter.route(msg);
    });
  });

  describe("full chain E2E: plan → build → verify → review → accept", () => {
    // Each test shares the same chain setup
    let chainId: string;

    async function drainAllPending() {
      const drainer = await registry.register("FCE2EDrainer", "builder");
      let d = await taskQueue.claim(drainer.id);
      while (d) {
        try { await taskQueue.complete(drainer.id, d.id, "drained"); } catch {}
        d = await taskQueue.claim(drainer.id);
      }
      try { await registry.unregister(drainer.id); } catch {}
    }

    it("sets up chain and verifies tasks created + message sent to first worker", async () => {
      await drainAllPending();

      // Clean up all existing instances to ensure isolation
      const existingInstances = await registry.listAll();
      for (const inst of existingInstances) {
        try { await registry.unregister(inst.id as string); } catch {}
      }

      chainId = `e2e-chain-${Date.now()}`;

      // Register workers for all roles
      await registry.register("E2E_Planner", "planner");
      await registry.register("E2E_Builder", "builder");
      await registry.register("E2E_Verifier", "verifier");
      await registry.register("E2E_Reviewer", "reviewer");
      await registry.register("E2E_Accepter", "accepter");

      const chainDef = {
        chain_id: chainId,
        chain_title: "E2E Login Feature",
        tasks: {
          plan: { title: "Plan login feature", description: "Design the login feature architecture", criteria: "Architecture doc approved", priority: 0 },
          build: { title: "Build login feature", description: "Implement the login feature", criteria: "Tests pass", priority: 1 },
          verify: { title: "Verify login feature", description: "Test the login feature", criteria: "All test cases pass", priority: 1 },
          review: { title: "Review login feature", description: "Review the login code", criteria: "Code review approved", priority: 1 },
          accept: { title: "Accept login feature", description: "Accept the final deliverable", criteria: "All criteria met", priority: 2 },
        },
      };

      const createdEvents: any[] = [];
      const chainEvents: any[] = [];
      eventBus.on("task_created", (e) => createdEvents.push(e));
      eventBus.on("chain_activated", (e) => chainEvents.push(e));

      const defsMsg: Message = {
        id: "msg-e2e-defs",
        type: "direct",
        from_instance: "planner-e2e",
        from_name: "E2E_Planner",
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

      await chainRouter.route(defsMsg);

      // All 5 tasks created
      expect(createdEvents.length).toBe(5);
      expect(chainEvents.length).toBe(1);
      expect(chainEvents[0].chainId).toBe(chainId);

      // Verify tasks exist in pending queue
      const pending = await taskQueue.listTasks("pending");
      const chainTasks = pending.filter((t: any) => t.chain_id === chainId);
      expect(chainTasks.length).toBeGreaterThanOrEqual(4); // plan claimed by planner, rest pending

      // Verify first worker (planner) got a message for the plan link
      const plannerInst = (await registry.listAll()).find((i: Record<string, unknown>) => i.name === "E2E_Planner");
      const plannerMsgs = await messageRouter.poll(plannerInst!.id as string);
      const planMsg = plannerMsgs.find((m) => m.link === "plan");
      expect(planMsg).toBeDefined();
      expect(planMsg!.chain_id).toBe(chainId);
    });

    it("plan → build: activate_next creates build task and notifies builder", async () => {
      // Planner completes plan with activate_next
      const createdEvents: any[] = [];
      eventBus.on("task_created", (e) => createdEvents.push(e));

      const report: Message = {
        id: "msg-e2e-plan-done",
        type: "direct",
        from_instance: "planner-e2e",
        from_name: "E2E_Planner",
        from_role: "planner",
        to_instance: "leader-001",
        content: JSON.stringify({
          decision: "activate_next",
          reason: "Plan is ready for implementation",
          nextLink: "build",
        }),
        created_at: new Date().toISOString(),
        read: false,
        link: "plan",
        chain_id: chainId,
        task_title: "Plan login feature",
        task_description: "Design the login feature architecture",
        task_criteria: "Architecture doc approved",
        task_doc_path: "/tmp/fake-doc.md",
        result_path: "/tmp/fake-result.md",
        reply_to: null,
        task_id: null,
        to_name: null,
      };

      await chainRouter.route(report);

      // Should create a build task
      const buildTaskCreated = createdEvents.find((e: any) => {
        const t = e.task;
        return t && t.link === "build";
      });
      expect(buildTaskCreated).toBeDefined();

      // Some idle builder should receive a message with build link
      const allInstances = await registry.listAll();
      let buildMsgFound = false;
      for (const inst of allInstances) {
        if ((inst as Record<string, unknown>).role !== "builder") continue;
        const msgs = await messageRouter.poll(inst.id as string);
        if (msgs.find((m) => m.link === "build")) {
          buildMsgFound = true;
          break;
        }
      }
      expect(buildMsgFound).toBe(true);
    });

    it("build → verify: builder completion activates verify", async () => {
      const verifierInst = (await registry.listAll()).find((i: Record<string, unknown>) => i.name === "E2E_Verifier");

      const createdEvents: any[] = [];
      eventBus.on("task_created", (e) => createdEvents.push(e));

      const report: Message = {
        id: "msg-e2e-build-done",
        type: "direct",
        from_instance: "builder-e2e",
        from_name: "E2E_Builder",
        from_role: "builder",
        to_instance: "leader-001",
        content: JSON.stringify({
          decision: "activate_next",
          reason: "Build complete and tested",
          nextLink: "verify",
          commit: { sha: "abc123def456", message: "Implement login feature", branch: "feature/login" },
        }),
        created_at: new Date().toISOString(),
        read: false,
        link: "build",
        chain_id: chainId,
        task_title: "Build login feature",
        task_description: "Implement the login feature",
        task_criteria: "Tests pass",
        task_doc_path: "/tmp/fake-doc.md",
        result_path: "/tmp/fake-result.md",
        reply_to: null,
        task_id: null,
        to_name: null,
      };

      await chainRouter.route(report);

      // Verify task created
      const verifyTaskCreated = createdEvents.find((e: any) => e.task?.link === "verify");
      expect(verifyTaskCreated).toBeDefined();

      // Verifier should receive a message
      const verifierMsgs = await messageRouter.poll(verifierInst!.id as string);
      const verifyMsg = verifierMsgs.find((m) => m.link === "verify");
      expect(verifyMsg).toBeDefined();
    });

    it("verify → review: verifier completion activates review", async () => {
      const reviewerInst = (await registry.listAll()).find((i: Record<string, unknown>) => i.name === "E2E_Reviewer");

      const createdEvents: any[] = [];
      eventBus.on("task_created", (e) => createdEvents.push(e));

      const report: Message = {
        id: "msg-e2e-verify-done",
        type: "direct",
        from_instance: "verifier-e2e",
        from_name: "E2E_Verifier",
        from_role: "verifier",
        to_instance: "leader-001",
        content: JSON.stringify({
          decision: "activate_next",
          reason: "All tests pass",
          nextLink: "review",
        }),
        created_at: new Date().toISOString(),
        read: false,
        link: "verify",
        chain_id: chainId,
        task_title: "Verify login feature",
        task_description: "Test the login feature",
        task_criteria: "All test cases pass",
        task_doc_path: "/tmp/fake-doc.md",
        result_path: "/tmp/fake-result.md",
        reply_to: null,
        task_id: null,
        to_name: null,
      };

      await chainRouter.route(report);

      // Review task created
      const reviewTaskCreated = createdEvents.find((e: any) => e.task?.link === "review");
      expect(reviewTaskCreated).toBeDefined();

      // Reviewer should receive a message
      const reviewerMsgs = await messageRouter.poll(reviewerInst!.id as string);
      const reviewMsg = reviewerMsgs.find((m) => m.link === "review");
      expect(reviewMsg).toBeDefined();
    });

    it("review → accept: reviewer completion activates accept", async () => {
      const createdEvents: any[] = [];
      eventBus.on("task_created", (e) => createdEvents.push(e));

      const report: Message = {
        id: "msg-e2e-review-done",
        type: "direct",
        from_instance: "reviewer-e2e",
        from_name: "E2E_Reviewer",
        from_role: "reviewer",
        to_instance: "leader-001",
        content: JSON.stringify({
          decision: "activate_next",
          reason: "Code review approved",
          nextLink: "accept",
        }),
        created_at: new Date().toISOString(),
        read: false,
        link: "review",
        chain_id: chainId,
        task_title: "Review login feature",
        task_description: "Review the login code",
        task_criteria: "Code review approved",
        task_doc_path: "/tmp/fake-doc.md",
        result_path: "/tmp/fake-result.md",
        reply_to: null,
        task_id: null,
        to_name: null,
      };

      await chainRouter.route(report);

      // Accept task created
      const acceptTaskCreated = createdEvents.find((e: any) => e.task?.link === "accept");
      expect(acceptTaskCreated).toBeDefined();

      // Some idle accepter should receive a message with accept link
      const allInstances = await registry.listAll();
      let acceptMsgFound = false;
      for (const inst of allInstances) {
        if ((inst as Record<string, unknown>).role !== "accepter") continue;
        const msgs = await messageRouter.poll(inst.id as string);
        if (msgs.find((m) => m.link === "accept")) {
          acceptMsgFound = true;
          break;
        }
      }
      expect(acceptMsgFound).toBe(true);
    });

    it("accept → close_chain: final acceptance closes the chain", async () => {
      const chainClosedEvents: any[] = [];
      eventBus.on("chain_closed", (e) => chainClosedEvents.push(e));

      const report: Message = {
        id: "msg-e2e-accept-done",
        type: "direct",
        from_instance: "accepter-e2e",
        from_name: "E2E_Accepter",
        from_role: "accepter",
        to_instance: "leader-001",
        content: JSON.stringify({
          decision: "close_chain",
          reason: "All requirements met, login feature accepted",
        }),
        created_at: new Date().toISOString(),
        read: false,
        link: "accept",
        chain_id: chainId,
        task_title: "Accept login feature",
        task_description: "Accept the final deliverable",
        task_criteria: "All criteria met",
        task_doc_path: "/tmp/fake-doc.md",
        result_path: "/tmp/fake-result.md",
        reply_to: null,
        task_id: null,
        to_name: null,
      };

      await chainRouter.route(report);

      // Chain should be closed
      expect(chainClosedEvents.length).toBe(1);
      expect(chainClosedEvents[0].chainId).toBe(chainId);
    });
  });

  describe("chain edge cases", () => {
    it("activate_next queues task when next role worker is unavailable", async () => {
      const createdEvents: any[] = [];
      eventBus.on("task_created", (e) => createdEvents.push(e));

      // No verifier registered yet
      const report: Message = {
        id: "msg-edge-noverify",
        type: "direct",
        from_instance: "builder-edge",
        from_name: "TestBuilder",
        from_role: "builder",
        to_instance: "leader-001",
        content: JSON.stringify({
          decision: "activate_next",
          reason: "Build done",
          nextLink: "verify",
        }),
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

      await chainRouter.route(report);

      // Task should be created but no message sent (no worker)
      expect(createdEvents.length).toBe(1);
      expect(createdEvents[0].task.link).toBe("verify");

      // Later a verifier arrives and can claim the task
      const verifier = await registry.register("LateVerifier", "verifier");
      const pending = await taskQueue.listTasks("pending");
      const verifyTask = pending.find((t: any) => t.link === "verify");
      expect(verifyTask).toBeDefined();

      const claimed = await taskQueue.claim(verifier.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.link).toBe("verify");
    });

    it("feedback on verify link sends message back to originating worker", async () => {
      const builder = await registry.register("EdgeFeedbackBuilder", "builder");

      const report: Message = {
        id: "msg-edge-feedback",
        type: "direct",
        from_instance: builder.id,
        from_name: "EdgeVerifier",
        from_role: "verifier",
        to_instance: "leader-001",
        content: JSON.stringify({
          decision: "feedback",
          reason: "Tests found issues",
          feedback: "Login button handler is missing error state",
        }),
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
      };

      await chainRouter.route(report);

      // Builder should get the feedback message
      const msgs = await messageRouter.poll(builder.id);
      const feedbackMsg = msgs.find((m) => m.content.includes("Login button handler"));
      expect(feedbackMsg).toBeDefined();
    });

    it("non-JSON completion triggers auto-advance with fallback nextLink", async () => {
      const createdEvents: any[] = [];
      eventBus.on("task_created", (e) => createdEvents.push(e));

      const report: Message = {
        id: "msg-edge-plaintext",
        type: "direct",
        from_instance: "builder-edge2",
        from_name: "TestBuilder",
        from_role: "builder",
        to_instance: "leader-001",
        content: "Task completed successfully. Output looks good.",
        created_at: new Date().toISOString(),
        read: false,
        link: "plan",
        task_title: null,
        task_description: null,
        task_criteria: null,
        task_doc_path: null,
        result_path: null,
        reply_to: null,
        to_name: null,
      };

      await chainRouter.route(report);

      // Should auto-advance: plan → build
      const newTasks = createdEvents.filter((e: any) => e.task);
      expect(newTasks.length).toBe(1);
      const buildTask = newTasks.find((e: any) => e.task?.link === "build");
      expect(buildTask).toBeDefined();
    });
  });

  describe("assignee-priority claiming", () => {
    it("worker claims task explicitly assigned to them first", async () => {
      const worker = await registry.register("AssignedWorker", "builder");

      // Push unassigned higher priority task first
      await taskQueue.push("High priority unassigned", "", 0, "leader-001", undefined, undefined, undefined, "build");
      // Push assigned lower priority task
      const assignedTask = await taskQueue.push("Assigned to me", "", 2, "leader-001", worker.id, undefined, undefined, "build");

      const claimed = await taskQueue.claim(worker.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.title).toBe("Assigned to me");
      expect(claimed!.assigned_to).toBe(worker.id);
    });
  });
});
