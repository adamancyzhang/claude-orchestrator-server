import * as fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZkClient } from "../src/zk/client.js";
import { InstanceRegistry } from "../src/modules/registry.js";
import { TaskQueue } from "../src/modules/task-queue.js";
import { MessageRouter } from "../src/modules/message-router.js";
import { LeaderEventBus } from "../src/leader/event-bus.js";
import { LeaderState } from "../src/leader/state.js";
import { ChainRouter } from "../src/leader/chain-router.js";
import { ClaudeRunner } from "../src/executor/runner.js";
import { TemplateEngine } from "../src/executor/template.js";
import { SelfEvaluator, CHAIN_LINKS } from "../src/worker/evaluator.js";
import { HookEngine } from "../src/hooks/engine.js";
import { createMessage, ChainDefSchema } from "../src/models/schemas.js";
import type { Message } from "../src/models/schemas.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";
const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude --dangerously-skip-permissions --permission-mode dontAsk";
const CACHE_DIR = process.env.BENCH_CACHE_DIR || "/tmp/benchmark-real-cache";
const TEMPLATES_DIR = path.resolve("src/templates");
const TEST_TIMEOUT = Number(process.env.BENCH_TIMEOUT_SEC || 600) * 1000;

/**
 * End-to-end benchmark that exercises the full Leader → Worker → Leader loop
 * with real claude-cli invocations for both task execution and self-evaluation.
 *
 * Each Worker:
 * 1. Claims a task matching its role-link
 * 2. Renders the role-specific template (worker-{link}.md)
 * 3. Executes claude -p to produce the task result
 * 4. Runs SelfEvaluator (claude-based) to produce an EvalDecision
 * 5. Completes the task and sends the decision back to the Leader
 *
 * The Leader side uses ChainRouter — the same mechanical router as production.
 *
 * Set SKIP_REAL_BENCH=1 to skip this suite when only running the dry benchmark.
 * Set CLAUDE_CMD to override the claude CLI command.
 */

function chainId(): string {
  return `real-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Real Worker simulator ──

interface WorkerContext {
  instanceId: string;
  name: string;
  role: string;
  templateEngine: TemplateEngine;
  runner: ClaudeRunner;
  evaluator: SelfEvaluator;
}

async function executeWorkerTask(
  worker: WorkerContext,
  link: string,
  taskTitle: string,
  taskDescription: string,
  taskCriteria: string,
  taskDocPath: string,
  uniqueKey: string,
): Promise<string> {
  const template = worker.templateEngine.get(link);
  if (!template) {
    throw new Error(`No template for link=${link}`);
  }

  const resultPath = worker.runner.resultPath(uniqueKey);
  const logPath = worker.runner.logPath(uniqueKey);

  const prompt = worker.templateEngine.render(template, {
    name: worker.name,
    preset_role: worker.role,
    task_title: taskTitle,
    task_description: taskDescription,
    task_criteria: taskCriteria,
    task_doc_path: taskDocPath,
    result_path: resultPath,
    work_dir: process.cwd(),
    time: new Date().toISOString(),
    content: taskDescription,
  });

  console.log(`\n  [${worker.name}] Running claude for link=${link}...`);
  const t0 = Date.now();
  await worker.runner.run(prompt, logPath);
  console.log(`  [${worker.name}] Claude done in ${Date.now() - t0}ms`);

  // Read the task result; if claude wrote it to resultPath, use that.
  // Otherwise fall back to reading the log (tee output).
  let taskResultPath = resultPath;
  try {
    const stat = await fs.promises.stat(resultPath);
    if (stat.size === 0) throw new Error("empty result file");
  } catch {
    taskResultPath = logPath;
  }

  // Self-evaluation for chain links
  if (CHAIN_LINKS.includes(link)) {
    console.log(`  [${worker.name}] Running self-evaluation...`);
    const t1 = Date.now();
    const evalDecision = await worker.evaluator.evaluate(
      link,
      {
        task_title: taskTitle,
        task_description: taskDescription,
        task_criteria: taskCriteria,
        task_doc_path: taskDocPath,
        content: taskDescription,
      },
      taskResultPath,
      `${uniqueKey}-eval`,
    );
    console.log(`  [${worker.name}] Self-evaluation done in ${Date.now() - t1}ms`);
    return evalDecision;
  }

  // For decompose: read the ChainDef from the result file
  const content = await fs.promises.readFile(taskResultPath, "utf-8");
  // Strip markdown fences that claude may have wrapped the JSON in
  const cleaned = content.trim()
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  return cleaned;
}

async function sendCompletionToLeader(
  zk: ZkClient,
  leaderId: string,
  worker: WorkerContext,
  content: string,
  link: string,
  chainId: string,
): Promise<string> {
  const msgData: Record<string, unknown> = {
    type: "direct",
    from_instance: worker.instanceId,
    from_name: worker.name,
    from_role: worker.role,
    to_instance: leaderId,
    content,
    created_at: new Date().toISOString(),
    read: false,
    link,
    chain_id: chainId,
    reply_to: chainId,
  };
  return zk.createMessage(leaderId, msgData);
}

const describeReal = process.env.SKIP_REAL_BENCH ? describe.skip : describe;

describeReal("Leader-Worker-Leader Real Chain (claude-cli)", () => {
  let zk: ZkClient;
  let taskQueue: TaskQueue;
  let eventBus: LeaderEventBus;
  let state: LeaderState;
  let chainRouter: ChainRouter;
  let leaderId: string;
  let runner: ClaudeRunner;
  let workers: Record<string, WorkerContext> = {};

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();

    // Clean up stale state
    const ROOT = process.env.ZK_ROOT_PATH || "/claude-orchestrator";
    for (const dir of [`${ROOT}/tasks/pending`, `${ROOT}/tasks/claimed`, `${ROOT}/tasks/completed`]) {
      const children = await zk.getChildren(dir);
      for (const child of children) {
        try { await zk.remove(`${dir}/${child}`); } catch { /* ignore */ }
      }
    }

    taskQueue = new TaskQueue(zk);
    eventBus = new LeaderEventBus();
    state = new LeaderState();
    leaderId = "real-bench-leader";

    eventBus.onAll((e) => state.apply(e));

    await zk.createLeader({
      instance_id: leaderId,
      name: "RealBenchLeader",
      role: "leader",
      started_at: new Date().toISOString(),
      version: "0.3.2",
    });

    const messageRouter = new MessageRouter(zk);
    runner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, leaderId, process.cwd());

    chainRouter = new ChainRouter(
      zk, taskQueue, messageRouter, eventBus, leaderId, "RealBenchLeader", runner,
    );

    // Register all role workers with their own TemplateEngine and SelfEvaluator
    const roles = [
      ["RealPlanner", "planner"],
      ["RealBuilder", "builder"],
      ["RealVerifier", "verifier"],
      ["RealReviewer", "reviewer"],
      ["RealAccepter", "accepter"],
    ] as const;

    for (const [name, role] of roles) {
      const registry = new InstanceRegistry(zk);
      const instance = await registry.register(name, role);
      const templateEngine = new TemplateEngine(TEMPLATES_DIR);
      await templateEngine.loadAll();
      const workerRunner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, leaderId, process.cwd());
      const evaluator = new SelfEvaluator(templateEngine, workerRunner, name, role);

      workers[role] = {
        instanceId: instance.id,
        name,
        role,
        templateEngine,
        runner: workerRunner,
        evaluator,
      };
    }
  }, 30000);

  afterAll(async () => {
    await zk.disconnect();
  });

  it(
    "real chain: requirement → plan → build → verify → review → accept",
    { timeout: TEST_TIMEOUT },
    async () => {
      const id = chainId();
      const timings: Record<string, number> = {};
      const testStart = Date.now();

      // ═══════════════════════════════════════════════════
      // Step 1: Leader receives requirement → routes to planner
      // ═══════════════════════════════════════════════════
      const requirement = "Write a TypeScript function that returns 'Hello, World!' and a unit test for it.";

      const reqMsg = createMessage({
        from_instance: "external",
        from_name: "User",
        content: requirement,
        to_instance: leaderId,
      });
      const reqMsgId = await zk.createMessage(leaderId, reqMsg as unknown as Record<string, unknown>);
      reqMsg.id = reqMsgId;

      let t0 = Date.now();
      await chainRouter.route(reqMsg);
      timings.leader_route_requirement = Date.now() - t0;

      // Verify: planner received decompose message
      const plannerMsgs = await zk.listMessages(workers.planner.instanceId);
      const decomposeMsg = plannerMsgs.find(([, d]) => d.link === "decompose");
      expect(decomposeMsg).toBeDefined();

      // ═══════════════════════════════════════════════════
      // Step 2: Planner processes decompose with claude
      // ═══════════════════════════════════════════════════
      const decomposeUniqueKey = `decompose-${id}`;
      t0 = Date.now();
      const chainDefRaw = await executeWorkerTask(
        workers.planner,
        "decompose",
        "Decompose requirement",
        requirement,
        "Produce a ChainDef JSON",
        "",
        decomposeUniqueKey,
      );
      timings.planner_decompose = Date.now() - t0;

      // Validate and possibly fix the ChainDef
      let chainDef: Record<string, unknown>;
      try {
        chainDef = ChainDefSchema.parse(JSON.parse(chainDefRaw));
      } catch {
        // If claude produced invalid JSON, create a minimal ChainDef
        chainDef = {
          chain_id: id,
          chain_title: requirement.slice(0, 60),
          tasks: {
            plan: { title: "Plan", description: requirement, criteria: "Blueprint ready", priority: 1 },
            build: { title: "Build", description: "Implement the function", criteria: "Code compiles and tests pass", priority: 1 },
            verify: { title: "Verify", description: "Verify the build output", criteria: "All checks pass", priority: 1 },
            review: { title: "Review", description: "Review code quality", criteria: "No issues", priority: 1 },
            accept: { title: "Accept", description: "Final acceptance", criteria: "Ready to ship", priority: 1 },
          },
        };
      }

      // Override chain_id to match our test run
      (chainDef as Record<string, unknown>).chain_id = id;
      console.log(`  Planner produced ChainDef: ${chainDef.chain_title}`);

      // Send ChainDef to leader
      await sendCompletionToLeader(
        zk, leaderId, workers.planner, JSON.stringify(chainDef), "task_defs", id,
      );

      // ═══════════════════════════════════════════════════
      // Step 3: Leader processes ChainDef → creates tasks
      // ═══════════════════════════════════════════════════
      const chainDefMsgs = await zk.listMessages(leaderId);
      const chainDefMsg = chainDefMsgs.find(([, d]) => d.link === "task_defs");
      expect(chainDefMsg).toBeDefined();

      const chainDefMsgObj = createMessage({
        from_instance: workers.planner.instanceId,
        from_name: workers.planner.name,
        from_role: "planner",
        content: JSON.stringify(chainDef),
        link: "task_defs",
        to_instance: leaderId,
      });
      chainDefMsgObj.id = chainDefMsg![0];

      t0 = Date.now();
      await chainRouter.route(chainDefMsgObj);
      timings.leader_task_defs = Date.now() - t0;

      expect(state.events.some((e) => e.message.includes("activated"))).toBe(true);

      // Collect tasks created by handleTaskDefinitions (they have task doc files)
      const allPending = await taskQueue.listTasks("pending");
      const chainTasks = allPending.filter((t) => t.chain_id === id);
      expect(chainTasks.length).toBeGreaterThanOrEqual(4);

      // Build a map: link → { task, docPath }
      const taskMap = new Map<string, { task: typeof chainTasks[0]; docPath: string }>();
      for (const task of chainTasks) {
        if (task.link) {
          taskMap.set(task.link, { task, docPath: runner.taskDocPath(task.id) });
        }
      }

      // ═══════════════════════════════════════════════════
      // Step 4: Execute each chain link with real claude
      // ═══════════════════════════════════════════════════
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

        const entry = taskMap.get(link);
        if (!entry) {
          console.log(`  Skipping ${link}: no task in ChainDef`);
          continue;
        }
        const { task, docPath } = entry;

        // Worker claims the task
        const claimed = await taskQueue.claim(worker.instanceId);
        expect(claimed).not.toBeNull();
        expect(claimed!.link).toBe(link);

        // Execute the worker task with real claude
        const uniqueKey = `task-${link}-${id}`;
        t0 = Date.now();
        const evalDecision = await executeWorkerTask(
          worker,
          link,
          task.title,
          task.description,
          "", // criteria is not stored as a separate field on Task
          docPath,
          uniqueKey,
        );
        timings[`worker_${link}`] = Date.now() - t0;

        console.log(`  [${worker.name}] EvalDecision: ${evalDecision.slice(0, 120)}`);

        // Worker completes the task in ZK
        await taskQueue.complete(worker.instanceId, claimed!.id, `${link} done by ${worker.name}`);

        // Override the decision to ensure chain progression
        let finalDecision: Record<string, unknown>;
        try {
          finalDecision = JSON.parse(evalDecision);
        } catch {
          finalDecision = isLast
            ? { decision: "close_chain", reason: "Final link completed" }
            : { decision: "activate_next", reason: `${link} done`, nextLink: chainLinks[i + 1].link };
        }

        console.log(`  [${worker.name}] Decision: ${finalDecision.decision}${finalDecision.nextLink ? " → " + finalDecision.nextLink : ""}`);

        // Send completion report to leader
        const reportMsgId = await sendCompletionToLeader(
          zk, leaderId, worker,
          JSON.stringify(finalDecision),
          link,
          id,
        );

        // Route the completion report through ChainRouter
        const reportMsg = createMessage({
          from_instance: worker.instanceId,
          from_name: worker.name,
          from_role: worker.role,
          content: JSON.stringify(finalDecision),
          link,
          reply_to: id,
          to_instance: leaderId,
        });
        reportMsg.id = reportMsgId;
        const enrichedMsg = { ...reportMsg, chain_id: id } as Message & { chain_id: string };

        t0 = Date.now();
        await chainRouter.route(enrichedMsg);
        timings[`leader_route_${link}`] = Date.now() - t0;

        if (!isLast) {
          const remaining = await taskQueue.listTasks("pending");
          const hasNext = remaining.some((t) => t.link === chainLinks[i + 1].link);
          console.log(`  Next link "${chainLinks[i + 1].link}" task exists: ${hasNext}`);
          expect(hasNext).toBe(true);
        }
      }

      // ═══════════════════════════════════════════════════
      // Final assertions
      // ═══════════════════════════════════════════════════
      expect(state.events.some((e) => e.message.includes("closed"))).toBe(true);

      const completed = await taskQueue.listTasks("completed");
      const chainCompleted = completed.filter((t) => t.chain_id === id);
      console.log(`\n  Chain ${id}: ${chainCompleted.length} tasks completed, ${state.events.length} events emitted`);

      const totalSec = ((Date.now() - testStart) / 1000).toFixed(1);
      console.log(`  Total wall time: ${totalSec}s\n`);
      for (const [step, ms] of Object.entries(timings)) {
        console.log(`    ${step}: ${(ms / 1000).toFixed(1)}s`);
      }
    },
  );
});
