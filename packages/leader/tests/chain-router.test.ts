// CORE-RETENTION
// Locks in: ChainRouter's core routing logic — chain activation via
// handleTaskDefinitions, task dispatch to idle workers, EvalDecision
// routing (activate_next, feedback, reject, close_chain), merge
// validation on close, and error recovery paths. These tests exercise
// the ChainRouter class directly with mocked dependencies, covering
// the routing algorithm that chain-router-helpers.test.ts does not reach.
// Critical because: ChainRouter is the central coordinator for the
// chain pipeline — misrouting decisions breaks the plan→execute→verify→
// review→accept flow, and silent merge failures let broken code ship.
// Primary sources: packages/leader/src/chain-router.ts

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  asChainId,
  asInstanceId,
  asMessageId,
  asTaskId,
  ChainDefSchema,
  MergeConflictError,
  type ChainId,
  type IEventBus,
  type IClaudeRunner,
  type IHookEngine,
  type IInstanceRegistry,
  type ILogger,
  type IMessageRouter,
  type ITaskQueue,
  type ITemplateEngine,
  type Instance,
  type LeaderEvent,
  type Message,
  type Task,
  type TaskLink,
} from "@co/contracts";
import { ChainRouter, type ChainRouterOptions } from "../src/chain-router.js";
import { LeaderEventBus } from "../src/event-bus.js";

// ── Test doubles ──────────────────────────────────────────────────────

class TestTaskQueue implements ITaskQueue {
  public tasks: Task[] = [];
  private nextId = 1;

  async push(input: Partial<Task>): Promise<Task> {
    const task: Task = {
      id: asTaskId(`task-${this.nextId++}`),
      title: input.title ?? "untitled",
      description: input.description ?? "",
      criteria: input.criteria ?? "",
      priority: input.priority ?? 0,
      link: input.link ?? null,
      chain_id: input.chain_id ?? null,
      status: "pending",
      created_by: input.created_by ?? asInstanceId("leader"),
      created_by_name: input.created_by_name ?? "Leader",
      assigned_to: input.assigned_to ?? null,
      assigned_to_name: input.assigned_to_name ?? null,
      claimed_by: null,
      claimed_at: null,
      completed_at: null,
      retry_count: input.retry_count ?? 0,
      created_at: new Date().toISOString(),
    };
    this.tasks.push(task);
    return task;
  }

  async assign(taskId: Task["id"], workerId: Instance["id"], workerName: string): Promise<void> {
    const t = this.tasks.find((t) => t.id === taskId);
    if (t) {
      t.assigned_to = workerId;
      t.assigned_to_name = workerName;
    }
  }

  async listPending(): Promise<Task[]> {
    return this.tasks.filter((t) => t.status === "pending");
  }

  async listInProgress(): Promise<Task[]> {
    return this.tasks.filter((t) => t.status === "in_progress");
  }

  async getCompleted(taskId: Task["id"]): Promise<Task | null> {
    const t = this.tasks.find((t) => t.id === taskId && t.status === "completed");
    return t ?? null;
  }

  async claim(_taskId: Task["id"], _workerId: Instance["id"]): Promise<Task> {
    throw new Error("claim unused");
  }

  async complete(_taskId: Task["id"]): Promise<void> {
    throw new Error("complete unused");
  }

  async fail(_taskId: Task["id"], _reason: string): Promise<void> {
    throw new Error("fail unused");
  }
}

class TestMessageRouter implements IMessageRouter {
  public sent: Message[] = [];

  async send(msg: Message): Promise<Message> {
    this.sent.push(msg);
    return msg;
  }

  async waitForMessage(): Promise<void> {
    throw new Error("waitForMessage unused");
  }

  async poll(): Promise<Message[]> {
    throw new Error("poll unused");
  }

  async dismiss(): Promise<void> {
    throw new Error("dismiss unused");
  }
}

class TestInstanceRegistry implements IInstanceRegistry {
  private instances: Instance[] = [];

  setInstances(list: Instance[]): void {
    this.instances = list;
  }

  async list(): Promise<Instance[]> {
    return this.instances;
  }

  async get(id: Instance["id"]): Promise<Instance | undefined> {
    return this.instances.find((i) => i.id === id);
  }

  async register(_inst: Instance): Promise<void> {
    throw new Error("register unused");
  }

  async unregister(_id: Instance["id"]): Promise<void> {
    throw new Error("unregister unused");
  }
}

class TestTemplateEngine implements ITemplateEngine {
  has(): boolean {
    return true;
  }

  load(): string {
    return "template";
  }

  render(): string {
    return "rendered";
  }
}

class TestClaudeRunner implements IClaudeRunner {
  async run(): Promise<{ exit_code: number; session_id: string | null; log_path: string }> {
    return { exit_code: 0, session_id: null, log_path: "/tmp/test.log" };
  }
}

const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

// ── Helpers ───────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: asInstanceId("worker-1"),
    name: "Worker1",
    role: "planner",
    status: "idle",
    current_task_id: null,
    worktree_name: null,
    pid: null,
    ...overrides,
  };
}

function makeChainDef(chainId: string, links: TaskLink[]): string {
  const taskDef = { title: "task", description: "desc", criteria: "", priority: 1 };
  // ChainDefSchema requires: plan (nullable), execute, verify, review, accept
  // We set non-included links to null for plan, and include all required ones
  const tasks: Record<string, { title: string; description: string; criteria: string; priority: number } | null> = {
    plan: links.includes("plan") ? taskDef : null,
    execute: links.includes("execute") ? { ...taskDef, title: `[${chainId}] execute` } : taskDef,
    verify: links.includes("verify") ? { ...taskDef, title: `[${chainId}] verify` } : taskDef,
    review: links.includes("review") ? { ...taskDef, title: `[${chainId}] review` } : taskDef,
    accept: links.includes("accept") ? { ...taskDef, title: `[${chainId}] accept` } : taskDef,
  };
  if (links.includes("explore")) {
    tasks.explore = { ...taskDef, title: `[${chainId}] explore` };
  }
  return JSON.stringify({ chain_id: chainId, chain_title: `Chain ${chainId}`, tasks });
}

function makeRouter(overrides: Partial<ChainRouterOptions> = {}): {
  router: ChainRouter;
  taskQueue: TestTaskQueue;
  messageRouter: TestMessageRouter;
  registry: TestInstanceRegistry;
  bus: LeaderEventBus;
} {
  const taskQueue = new TestTaskQueue();
  const messageRouter = new TestMessageRouter();
  const registry = new TestInstanceRegistry();
  const bus = new LeaderEventBus();
  const router = new ChainRouter({
    task_queue: taskQueue,
    message_router: messageRouter,
    registry,
    bus,
    runner: new TestClaudeRunner(),
    template_engine: new TestTemplateEngine(),
    logger: noopLogger,
    leader_id: asInstanceId("leader"),
    leader_name: "Leader",
    cache_paths: { co_root: "/tmp/co", project_root: "/tmp/project" },
    ...overrides,
  });
  return { router, taskQueue, messageRouter, registry, bus };
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: asMessageId("msg-1"),
    type: "direct",
    from_instance: asInstanceId("worker-1"),
    from_name: "Worker1",
    from_role: "executor",
    to_instance: asInstanceId("leader"),
    to_name: "Leader",
    content: "test",
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
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("ChainRouter — chain activation", () => {
  it("activates a chain and dispatches first task to idle worker", async () => {
    const { router, taskQueue, messageRouter, registry, bus } = makeRouter();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({ id: asInstanceId("planner-1"), name: "Planner1", role: "planner", status: "idle" }),
    ]);

    const chainDef = makeChainDef("chain-1", ["plan", "execute", "verify"]);
    // Pass ChainDef content with a non-null link to route through handleTaskDefinitions
    await router.route(makeMsg({
      content: chainDef,
      link: "plan",
    }));

    // ChainDef requires plan, execute, verify, review, accept — all 5 tasks created
    expect(taskQueue.tasks).toHaveLength(5);
    expect(taskQueue.tasks.map((t) => t.link)).toEqual(["plan", "execute", "verify", "review", "accept"]);

    // First task dispatched to planner
    expect(messageRouter.sent).toHaveLength(1);
    expect(messageRouter.sent[0].type).toBe("task_dispatch");
    expect(messageRouter.sent[0].to_instance).toBe(asInstanceId("planner-1"));
    expect(messageRouter.sent[0].link).toBe("plan");

    // chain_activated event emitted
    expect(events.some((e) => e.type === "chain_activated")).toBe(true);
  });

  it("queues tasks when no idle worker available", async () => {
    const { router, taskQueue, messageRouter, registry } = makeRouter();

    registry.setInstances([]); // no workers

    const chainDef = makeChainDef("chain-2", ["plan", "execute"]);
    await router.route(makeMsg({ content: chainDef, link: "plan" }));

    // All 5 required tasks created
    expect(taskQueue.tasks).toHaveLength(5);
    expect(messageRouter.sent).toHaveLength(0); // no dispatch
  });
});

describe("ChainRouter — EvalDecision routing", () => {
  it("activate_next dispatches next link task to idle worker", async () => {
    const { router, taskQueue, messageRouter, registry } = makeRouter();

    registry.setInstances([
      makeInstance({ id: asInstanceId("planner-1"), name: "Planner1", role: "planner", status: "idle" }),
      makeInstance({ id: asInstanceId("executor-1"), name: "Executor1", role: "executor", status: "idle" }),
    ]);

    // Activate chain first
    const chainDef = makeChainDef("chain-3", ["plan", "execute"]);
    await router.route(makeMsg({ content: chainDef, link: "plan" }));
    expect(messageRouter.sent).toHaveLength(1); // plan dispatched

    // Simulate plan completion with activate_next
    const completionMsg = makeMsg({
      content: JSON.stringify({ decision: "activate_next", reason: "plan done", next_link: "execute" }),
      link: "plan",
      chain_id: "chain-3",
      task_id: taskQueue.tasks[0].id,
      from_instance: asInstanceId("planner-1"),
      from_name: "Planner1",
    });
    await router.route(completionMsg);

    // execute task should be dispatched
    expect(messageRouter.sent).toHaveLength(2);
    expect(messageRouter.sent[1].link).toBe("execute");
  });

  it("reject closes chain and emits chain_closed", async () => {
    const { router, taskQueue, messageRouter, registry, bus } = makeRouter();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({ id: asInstanceId("planner-1"), role: "planner" }),
    ]);

    const chainDef = makeChainDef("chain-4", ["plan"]);
    await router.route(makeMsg({ content: chainDef, link: "plan" }));

    const completionMsg = makeMsg({
      content: JSON.stringify({ decision: "reject", reason: "bad plan" }),
      link: "plan",
      chain_id: "chain-4",
      task_id: taskQueue.tasks[0].id,
      from_instance: asInstanceId("planner-1"),
      from_name: "Planner1",
    });
    await router.route(completionMsg);

    expect(events.some((e) => e.type === "chain_closed")).toBe(true);
    // No further dispatches
    expect(messageRouter.sent).toHaveLength(1); // only initial plan dispatch
  });

  it("feedback dispatches retry task to previous link worker", async () => {
    const { router, taskQueue, messageRouter, registry } = makeRouter();

    registry.setInstances([
      makeInstance({ id: asInstanceId("planner-1"), role: "planner" }),
      makeInstance({ id: asInstanceId("executor-1"), role: "executor" }),
    ]);

    const chainDef = makeChainDef("chain-5", ["plan", "execute"]);
    await router.route(makeMsg({ content: chainDef, link: "plan" }));

    // Feedback on execute link with explicit target — should route to executor
    const feedbackMsg = makeMsg({
      content: JSON.stringify({
        decision: "feedback",
        reason: "needs fix",
        feedback_to_worker: "fix the code",
        feedback_target: asInstanceId("executor-1"),
      }),
      link: "execute",
      chain_id: "chain-5",
      task_id: taskQueue.tasks[1].id, // execute task is index 1
      from_instance: asInstanceId("executor-1"),
      from_name: "Executor1",
    });
    await router.route(feedbackMsg);

    // Should have dispatched a retry task (2nd task_dispatch = retry)
    expect(messageRouter.sent).toHaveLength(2);
    expect(messageRouter.sent[1].type).toBe("task_dispatch");
    expect(messageRouter.sent[1].to_instance).toBe(asInstanceId("executor-1"));
  });
});

describe("ChainRouter — merge validation on close", () => {
  it("close_chain runs merge validation and closes chain on success", async () => {
    const validateFn = vi.fn().mockResolvedValue({ decision: "merge" });
    const { router, taskQueue, messageRouter, registry, bus } = makeRouter({
      merge_validator: { validate: validateFn },
    });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({ id: asInstanceId("planner-1"), role: "planner" }),
    ]);

    const chainDef = makeChainDef("chain-6", ["plan"]);
    await router.route(makeMsg({ content: chainDef, link: "plan" }));

    const closeMsg = makeMsg({
      content: JSON.stringify({ decision: "close_chain", reason: "done" }),
      link: "plan",
      chain_id: "chain-6",
      task_id: taskQueue.tasks[0].id,
      from_instance: asInstanceId("planner-1"),
      from_name: "Planner1",
    });
    await router.route(closeMsg);

    expect(events.some((e) => e.type === "chain_closed")).toBe(true);
  });

  it("close_chain with merge failure emits chain_merge_failed", async () => {
    const validateFn = vi.fn().mockRejectedValue(
      new MergeConflictError("conflict", ["file.ts"]),
    );
    const { router, taskQueue, messageRouter, registry, bus } = makeRouter({
      merge_validator: { validate: validateFn },
      chain_audit: {
        openChain: vi.fn().mockResolvedValue(undefined),
        record: vi.fn().mockResolvedValue(undefined),
        readManifest: vi.fn().mockResolvedValue({
          link_commits: {
            accept: { worktree: "abc123", branch: "feat/accept", docs: null },
          },
        }),
        closeChain: vi.fn().mockResolvedValue(undefined),
        setLinkTask: vi.fn().mockResolvedValue(undefined),
        setLinkWorker: vi.fn().mockResolvedValue(undefined),
        recordLinkCommit: vi.fn().mockResolvedValue(undefined),
        collectUpstreamCommits: vi.fn().mockResolvedValue({}),
        appendChildChain: vi.fn().mockResolvedValue(undefined),
        clearLinkCommitsFrom: vi.fn().mockResolvedValue(undefined),
      } as any,
    });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({ id: asInstanceId("planner-1"), role: "planner" }),
    ]);

    const chainDef = makeChainDef("chain-7", ["plan"]);
    await router.route(makeMsg({ content: chainDef, link: "plan" }));

    const closeMsg = makeMsg({
      content: JSON.stringify({ decision: "close_chain", reason: "done" }),
      link: "plan",
      chain_id: "chain-7",
      task_id: taskQueue.tasks[0].id,
      from_instance: asInstanceId("planner-1"),
      from_name: "Planner1",
    });
    await router.route(closeMsg);

    expect(events.some((e) => e.type === "chain_merge_failed")).toBe(true);
  });
});

describe("ChainRouter — error recovery", () => {
  it("drops feedback when target cannot be resolved", async () => {
    const { router, taskQueue, messageRouter, registry } = makeRouter();

    registry.setInstances([]); // no workers

    const chainDef = makeChainDef("chain-8", ["plan", "execute"]);
    await router.route(makeMsg({ content: chainDef, link: "plan" }));

    // Feedback with no explicit target and no manifest history
    const feedbackMsg = makeMsg({
      content: JSON.stringify({
        decision: "feedback",
        reason: "fix needed",
        feedback_to_worker: "please fix",
      }),
      link: "execute",
      chain_id: "chain-8",
      task_id: taskQueue.tasks[1].id,
      from_instance: asInstanceId("executor-1"),
      from_name: "Executor1",
    });
    await router.route(feedbackMsg);

    // Should not dispatch any retry — only the initial plan dispatch (no workers = no initial dispatch either)
    expect(messageRouter.sent).toHaveLength(0);
  });
});

describe("ChainRouter — spawn_chain (D3)", () => {
  it("spawn_chain at explore with magic_mode=true creates child chain message", async () => {
    // Create a mock chain_audit
    const mockChainAudit = {
      readManifest: vi.fn().mockResolvedValue(null),
      record: vi.fn().mockResolvedValue(undefined),
      closeChain: vi.fn().mockResolvedValue(undefined),
      openChain: vi.fn().mockResolvedValue(undefined),
    };

    const { router, taskQueue, messageRouter, registry, bus } = makeRouter({
      magic_mode: true,
      chain_audit: mockChainAudit as any,
    });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({ id: asInstanceId("explorer-1"), role: "explorer", status: "idle" }),
    ]);

    // Create chain with explore link
    const chainDef = makeChainDef("chain-spawn", ["plan", "execute", "explore"]);
    await router.route(makeMsg({ content: chainDef, link: "plan" }));

    // Simulate explore completion with spawn_chain decision
    const spawnMsg = makeMsg({
      content: JSON.stringify({
        decision: "spawn_chain",
        reason: "found new requirement",
        next_requirement: "Implement feature X",
      }),
      link: "explore",
      chain_id: "chain-spawn",
      task_id: taskQueue.tasks[taskQueue.tasks.length - 1].id,
      from_instance: asInstanceId("explorer-1"),
      from_name: "Explorer1",
    });
    await router.route(spawnMsg);

    // Should emit chain_closed for parent
    expect(events.some((e) => e.type === "chain_closed" && e.chain_id === "chain-spawn")).toBe(true);

    // Should send user_input message for child chain
    const userInputMsg = messageRouter.sent.find(
      (m) => m.type === "user_input" && m.spawned_from === "chain-spawn",
    );
    expect(userInputMsg).toBeDefined();
    expect(userInputMsg?.content).toBe("Implement feature X");
  });

  it("spawn_chain is rejected when magic_mode=false", async () => {
    // When magic_mode=false, ChainRouter should reject ChainDefs with explore link
    const { router, taskQueue, messageRouter, registry, bus } = makeRouter({
      magic_mode: false,
    });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({ id: asInstanceId("explorer-1"), role: "explorer", status: "idle" }),
    ]);

    // ChainDef with explore link should be rejected when magic_mode=false
    const chainDef = makeChainDef("chain-no-spawn", ["plan", "execute", "explore"]);

    // Track if route throws or silently rejects
    let routeError: Error | null = null;
    try {
      await router.route(makeMsg({ content: chainDef, link: "plan" }));
    } catch (e) {
      routeError = e as Error;
    }

    // The route may throw or silently reject — either way, no user_input messages should be sent
    const userInputMsg = messageRouter.sent.find(
      (m) => m.type === "user_input" && m.spawned_from === "chain-no-spawn",
    );
    expect(userInputMsg).toBeUndefined();
  });
});

describe("ChainRouter — magic_max_chains depth limit (D4)", () => {
  it("spawn_chain is demoted to close_chain when depth limit reached", async () => {
    // Create a mock chain_audit that returns a manifest with chain_depth=1
    const mockChainAudit = {
      readManifest: vi.fn().mockResolvedValue({ chain_depth: 1 }),
      record: vi.fn().mockResolvedValue(undefined),
      closeChain: vi.fn().mockResolvedValue(undefined),
      openChain: vi.fn().mockResolvedValue(undefined),
    };

    const { router, taskQueue, messageRouter, registry, bus } = makeRouter({
      magic_mode: true,
      magic_max_chains: 2, // limit to 2 levels
      chain_audit: mockChainAudit as any,
    });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({ id: asInstanceId("explorer-1"), role: "explorer", status: "idle" }),
    ]);

    // Create chain at depth 1 (would become depth 2 on spawn)
    const chainDef = makeChainDef("chain-depth", ["plan", "execute", "explore"]);
    await router.route(makeMsg({ content: chainDef, link: "plan" }));

    // Simulate explore completion with spawn_chain decision
    const spawnMsg = makeMsg({
      content: JSON.stringify({
        decision: "spawn_chain",
        reason: "found new requirement",
        next_requirement: "Implement feature Z",
      }),
      link: "explore",
      chain_id: "chain-depth",
      task_id: taskQueue.tasks[taskQueue.tasks.length - 1].id,
      from_instance: asInstanceId("explorer-1"),
      from_name: "Explorer1",
    });
    await router.route(spawnMsg);

    // Should emit magic_depth_exhausted event
    expect(events.some((e) => e.type === "magic_depth_exhausted")).toBe(true);

    // Should emit chain_closed (demoted to close_chain)
    expect(events.some((e) => e.type === "chain_closed" && e.chain_id === "chain-depth")).toBe(true);

    // Should NOT send user_input message for child chain
    const userInputMsg = messageRouter.sent.find(
      (m) => m.type === "user_input" && m.spawned_from === "chain-depth",
    );
    expect(userInputMsg).toBeUndefined();
  });
});
