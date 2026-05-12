import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZkClient } from "../src/zk/client.js";
import { InstanceRegistry } from "../src/modules/registry.js";
import { TaskQueue } from "../src/modules/task-queue.js";
import { MessageRouter } from "../src/modules/message-router.js";
import { LeaderEventBus } from "../src/leader/event-bus.js";
import { LeaderState } from "../src/leader/state.js";
import { ChainRouter } from "../src/leader/chain-router.js";
import { ClaudeRunner } from "../src/executor/runner.js";
import { createMessage } from "../src/models/schemas.js";
import type { Message } from "../src/models/schemas.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

/**
 * Real-ZK benchmark that exercises the full Leader → Worker → Leader loop
 * without invoking claude-cli. Each Worker is simulated by directly claiming
 * tasks, marking them complete, and sending structured response messages
 * (ChainDef / EvalDecision) back to the Leader's ZK message queue. The Leader
 * side is driven through ChainRouter, the same mechanical router used in
 * production.
 */

function chainId(): string {
  return `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SimWorker {
  instance: { id: string; name: string; role: string };
  registry: InstanceRegistry;
}

async function claimAndComplete(
  taskQueue: TaskQueue,
  worker: SimWorker,
  expectedLink: string,
) {
  const claimed = await taskQueue.claim(worker.instance.id);
  if (!claimed) {
    throw new Error(`No pending task for ${worker.instance.name} (expected link=${expectedLink})`);
  }
  if (claimed.link !== expectedLink) {
    throw new Error(
      `Claimed task link=${claimed.link}, expected ${expectedLink} for ${worker.instance.name}`,
    );
  }
  const completed = await taskQueue.complete(
    worker.instance.id,
    claimed.id,
    `${expectedLink} done by ${worker.instance.name}`,
  );
  return { claimed, completed };
}

async function sendToLeader(
  zk: ZkClient,
  leaderId: string,
  worker: SimWorker,
  content: string,
  link: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const msgData: Record<string, unknown> = {
    type: "direct",
    from_instance: worker.instance.id,
    from_name: worker.instance.name,
    from_role: worker.instance.role,
    to_instance: leaderId,
    content,
    created_at: new Date().toISOString(),
    read: false,
    link,
    ...extra,
  };
  return zk.createMessage(leaderId, msgData);
}

describe("Leader-Worker-Leader Full Chain Benchmark", () => {
  let zk: ZkClient;
  let taskQueue: TaskQueue;
  let eventBus: LeaderEventBus;
  let state: LeaderState;
  let chainRouter: ChainRouter;
  let leaderId: string;
  let workers: Record<string, SimWorker> = {};

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();

    // Clean up stale state from previous runs so claiming picks up the
    // tasks created by *this* benchmark run rather than older ones with
    // lower sequential IDs.
    const ROOT = process.env.ZK_ROOT_PATH || "/claude-orchestrator";
    for (const dir of [`${ROOT}/tasks/pending`, `${ROOT}/tasks/claimed`, `${ROOT}/tasks/completed`]) {
      const children = await zk.getChildren(dir);
      for (const child of children) {
        try { await zk.remove(`${dir}/${child}`); } catch { /* ephemeral already gone */ }
      }
    }

    taskQueue = new TaskQueue(zk);
    eventBus = new LeaderEventBus();
    state = new LeaderState();
    leaderId = "bench-leader";

    eventBus.onAll((e) => state.apply(e));

    await zk.createLeader({
      instance_id: leaderId,
      name: "BenchLeader",
      role: "leader",
      started_at: new Date().toISOString(),
      version: "0.3.2",
    });

    const messageRouter = new MessageRouter(zk);
    const runner = new ClaudeRunner("echo", "/tmp/benchmark-cache", leaderId, "/tmp");

    chainRouter = new ChainRouter(
      zk, taskQueue, messageRouter, eventBus, leaderId, "BenchLeader", runner,
    );

    // Register all role workers upfront
    for (const [name, role] of [
      ["BenchPlanner", "planner"],
      ["BenchBuilder", "builder"],
      ["BenchVerifier", "verifier"],
      ["BenchReviewer", "reviewer"],
      ["BenchAccepter", "accepter"],
    ] as const) {
      const registry = new InstanceRegistry(zk);
      const instance = await registry.register(name, role);
      workers[role] = { instance: { id: instance.id, name, role }, registry };
    }
  });

  afterAll(async () => {
    await zk.disconnect();
  });

  // ── Warmup: basic task lifecycle ──
  it("warmup: single task push → claim → complete", async () => {
    const task = await taskQueue.push("warmup", "", 1, leaderId);
    expect(task.status).toBe("pending");

    const claimed = await taskQueue.claim(workers.builder.instance.id);
    expect(claimed).not.toBeNull();

    const done = await taskQueue.complete(workers.builder.instance.id, claimed!.id, "ok");
    expect(done.status).toBe("completed");
  });

  // ── Main benchmark: full chain ──
  it("benchmark: requirement → plan → build → verify → review → accept", async () => {
    const id = chainId();
    const timings: Record<string, number> = {};

    // ── Step 1: Leader receives requirement → routes to planner ──
    const reqMsg = createMessage({
      from_instance: "external",
      from_name: "User",
      content: "Build a REST API for user management with CRUD operations",
      to_instance: leaderId,
    });
    const reqMsgId = await zk.createMessage(leaderId, reqMsg as unknown as Record<string, unknown>);
    reqMsg.id = reqMsgId;

    let t0 = Date.now();
    await chainRouter.route(reqMsg);
    timings.requirement = Date.now() - t0;

    // Verify: planner received decompose message
    const plannerMsgs = await zk.listMessages(workers.planner.instance.id);
    const decomposeMsg = plannerMsgs.find(([, d]) => d.link === "decompose");
    expect(decomposeMsg).toBeDefined();

    // ── Step 2: Planner responds with ChainDef → Leader creates tasks ──
    const chainDef = {
      chain_id: id,
      chain_title: "REST API for User Management",
      tasks: {
        plan: { title: "Plan user API", description: "Design REST endpoints", criteria: "All CRUD endpoints defined", priority: 1 },
        build: { title: "Build user API", description: "Implement endpoints", criteria: "All tests pass", priority: 1 },
        verify: { title: "Verify user API", description: "Integration test endpoints", criteria: "Integration tests pass", priority: 1 },
        review: { title: "Review user API", description: "Code review", criteria: "No issues found", priority: 1 },
        accept: { title: "Accept user API", description: "Final acceptance", criteria: "All criteria met", priority: 1 },
      },
    };

    // Simulate planner processing the decompose message and responding with ChainDef.
    // Decompose is a message-based step — no ZK task is created for it.
    await sendToLeader(zk, leaderId, workers.planner, JSON.stringify(chainDef), "task_defs");

    // Route the task_defs message (simulate LeaderWatcher picking it up)
    const chainDefMsgs = await zk.listMessages(leaderId);
    const chainDefMsg = chainDefMsgs.find(([, d]) => d.link === "task_defs");
    expect(chainDefMsg).toBeDefined();

    t0 = Date.now();
    const chainDefMsgObj = createMessage({
      from_instance: workers.planner.instance.id,
      from_name: workers.planner.instance.name,
      from_role: "planner",
      content: JSON.stringify(chainDef),
      link: "task_defs",
      to_instance: leaderId,
    });
    chainDefMsgObj.id = chainDefMsg![0];
    await chainRouter.route(chainDefMsgObj);
    timings.task_defs = Date.now() - t0;

    // Verify: 5 tasks created
    expect(state.events.some((e) => e.message.includes("activated"))).toBe(true);
    const pending = await taskQueue.listTasks("pending");
    const chainPending = pending.filter((t) => t.chain_id === id);
    expect(chainPending.length).toBeGreaterThanOrEqual(5);

    // ── Step 3: Execute chain links ──
    const chainLinks = [
      { link: "plan", worker: workers.planner },
      { link: "build", worker: workers.builder },
      { link: "verify", worker: workers.verifier },
      { link: "review", worker: workers.reviewer },
      { link: "accept", worker: workers.accepter },
    ];

    for (let i = 0; i < chainLinks.length; i++) {
      const { link, worker } = chainLinks[i];
      const isLast = i === chainLinks.length - 1;

      // Worker claims and completes the task
      const { claimed } = await claimAndComplete(taskQueue, worker, link);

      // Worker sends EvalDecision back to leader
      const nextLink = isLast ? null : chainLinks[i + 1].link;
      const evalDecision = isLast
        ? { decision: "close_chain", reason: "All links completed successfully" }
        : { decision: "activate_next", reason: `${link} done`, nextLink };

      const reportMsgId = await sendToLeader(
        zk, leaderId, worker,
        JSON.stringify(evalDecision),
        link,
        { chain_id: id, reply_to: id },
      );

      // Route the completion report (simulate LeaderWatcher)
      const reportMsg = createMessage({
        from_instance: worker.instance.id,
        from_name: worker.instance.name,
        from_role: worker.instance.role,
        content: JSON.stringify(evalDecision),
        link,
        reply_to: id,
        to_instance: leaderId,
      });
      reportMsg.id = reportMsgId;
      // Attach chain_id for close_chain detection
      const enrichedMsg = { ...reportMsg, chain_id: id } as Message & { chain_id: string };

      t0 = Date.now();
      await chainRouter.route(enrichedMsg);
      timings[link] = Date.now() - t0;

      if (!isLast) {
        // Verify next task was created
        const remaining = await taskQueue.listTasks("pending");
        expect(remaining.some((t) => t.link === nextLink)).toBe(true);
      }
    }

    // ── Final assertions ──
    expect(state.events.some((e) => e.message.includes("closed"))).toBe(true);

    const completed = await taskQueue.listTasks("completed");
    const chainCompleted = completed.filter((t) => t.chain_id === id);
    expect(chainCompleted.length).toBeGreaterThanOrEqual(5);

    // ── Timing report ──
    const total = Object.values(timings).reduce((a, b) => a + b, 0);
    console.log(`\n  Full chain "${id}" timings (${total}ms total route time, ${state.events.length} events):`);
    for (const [step, ms] of Object.entries(timings)) {
      console.log(`    ${step}: ${ms}ms`);
    }
  });

  // ── Feedback loop ──
  it("benchmark: feedback → retry cycle", async () => {
    const id = chainId();

    await taskQueue.push(
      "Feedback test task", "Test", 1, leaderId,
      undefined, undefined, undefined, "build", id,
    );

    await claimAndComplete(taskQueue, workers.builder, "build");

    // Builder self-evaluates and requests feedback (simulating the worker sending
    // an EvalDecision with decision=feedback back to the leader)
    const evalDecision = {
      decision: "feedback",
      reason: "Implementation needs clarification on error handling",
      feedback: "Please clarify: should we return 400 or 422 for validation errors?",
    };

    const reportMsgId = await sendToLeader(
      zk, leaderId, workers.builder,
      JSON.stringify(evalDecision),
      "build",
      { chain_id: id, reply_to: id },
    );

    const reportMsg = createMessage({
      from_instance: workers.builder.instance.id,
      from_name: workers.builder.instance.name,
      from_role: "builder",
      content: JSON.stringify(evalDecision),
      link: "build",
      reply_to: id,
      to_instance: leaderId,
    });
    reportMsg.id = reportMsgId;

    const enrichedMsg = { ...reportMsg, chain_id: id } as Message & { chain_id: string };

    const t0 = Date.now();
    await chainRouter.route(enrichedMsg);
    console.log(`  feedback routing: ${Date.now() - t0}ms`);

    // Verify: feedback message sent back to builder
    const builderMsgs = await zk.listMessages(workers.builder.instance.id);
    const feedbackMsg = builderMsgs.find(([, d]) =>
      (d.content as string).includes("422 for validation errors"),
    );
    expect(feedbackMsg).toBeDefined();
  });

  // ── Role-link sorting ──
  it("benchmark: role-link priority claiming", async () => {
    const id = chainId();

    // Push multiple tasks with different links
    await taskQueue.push("Build task", "", 1, leaderId, undefined, undefined, undefined, "build", id);
    await taskQueue.push("Plan task", "", 1, leaderId, undefined, undefined, undefined, "plan", id);

    // Planner claims: should get plan task first (role-link match)
    const claimed = await taskQueue.claim(workers.planner.instance.id);
    expect(claimed).not.toBeNull();
    expect(claimed!.link).toBe("plan");

    // Clean up
    await taskQueue.complete(workers.planner.instance.id, claimed!.id, "done");
  });
});
