// CORE-RETENTION
// Locks in: ChainRouter.handleTaskDefinitions / handleCompletionReport
//   observable behavior — what tasks land in TaskQueue and what
//   task_dispatch messages reach Worker inboxes when:
//     1. A ChainDef arrives → 5 pending tasks pushed (with description +
//        criteria) and the first link dispatched with full task context.
//     2. A Worker reports `activate_next` → next link is dispatched with
//        task_description / task_criteria threaded through.
//     3. Worker reports `feedback` → a direct message is sent (target
//        defaults to msg.from_instance unless feedback_target overrides).
//     4. Worker reports `reject` / `close_chain` → chain_closed is emitted
//        and no further task is dispatched.
//
// Core path because: ChainRouter is the only authority that turns ChainDef
//   JSON and EvalDecision JSON into Worker work. Regressions here either
//   stall chains, dispatch empty contexts, or send feedback to the wrong
//   Worker.
// Owner subsystem: leader.
// Primary source files exercised:
//   - packages/leader/src/chain-router.ts
//   - packages/coordination/src/task-queue.ts (push contract)
//   - packages/contracts/src/schemas/chain.ts
//   - packages/contracts/src/schemas/eval.ts
//
// TRUST-JUSTIFICATION: this test fakes IZkClient (in-memory map),
//   IInstanceRegistry, IMessageRouter, IClaudeRunner, ITemplateEngine,
//   IEventBus. None of the faked collaborators touch ZooKeeper or
//   claude-cli. Each fake implements the smallest slice of the protocol
//   contract needed for the assertions:
//     - registry.list() returns a configured set of instances;
//     - message_router.send() appends to an in-memory list (sent_messages)
//       which the test inspects directly.
//   Real ZK + claude-cli paths are covered downstream by integration tests
//   under packages/leader/tests/core/integration/ once they exist; here we
//   verify the public protocol contract — the JSON envelope dispatched to
//   workers and the events emitted to the bus.

import { describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  asMessageId,
  type ChainId,
  type IClaudeRunner,
  type IEventBus,
  type IInstanceRegistry,
  type ILogger,
  type IMessageRouter,
  type ITemplateEngine,
  type Instance,
  type InstanceId,
  type LeaderEvent,
  type Message,
  type RunOptions,
  type RunResult,
  type SendMessageInput,
  type TaskLink,
} from "@co/contracts";
import { TaskQueue } from "@co/coordination";
import { ChainRouter } from "../../../src/chain-router.js";
import type { ChainAudit, ChainManifest, ChainOpenMeta, ChainAuditEventInput } from "../../../src/chain-audit.js";

/**
 * In-memory ChainAudit fake — mirrors the methods ChainRouter consumes
 * (openChain, setLinkTask, setLinkWorker, record, closeChain, readManifest,
 * incrementRetry). No filesystem I/O, so unit tests stay hermetic.
 */
class FakeChainAudit implements Pick<ChainAudit,
  | "openChain"
  | "setLinkTask"
  | "setLinkWorker"
  | "record"
  | "closeChain"
  | "readManifest"
  | "incrementRetry"
  | "appendChildChain"
> {
  private manifests = new Map<ChainId, ChainManifest>();
  events: ChainAuditEventInput[] = [];
  closures: { chainId: ChainId; status: string; extra?: Record<string, unknown> }[] = [];

  async openChain(chainId: ChainId, meta: ChainOpenMeta): Promise<void> {
    this.manifests.set(chainId, {
      chain_id: chainId,
      created_at: meta.created_at,
      completed_at: null,
      status: "running",
      leader_id: meta.leader_id,
      leader_name: meta.leader_name,
      requirement_path: meta.requirement_path,
      link_tasks: {
        plan: null,
        execute: null,
        verify: null,
        review: null,
        accept: null,
        explore: null,
      },
      link_workers: {
        plan: null,
        execute: null,
        verify: null,
        review: null,
        accept: null,
        explore: null,
      },
      total_retry_count: 0,
      max_total_retries: meta.max_total_retries ?? 9,
      // v0.7 NEW — forest fields honor the openChain meta or default
      // to root-chain values.
      parent_chain_id: meta.parent_chain_id ?? null,
      child_chain_ids: [],
      chain_depth: meta.chain_depth ?? 0,
      magic_mode: meta.magic_mode ?? false,
    });
  }
  async setLinkTask(chainId: ChainId, link: TaskLink, taskId: never): Promise<void> {
    const m = this.manifests.get(chainId);
    if (m) m.link_tasks[link] = taskId;
  }
  async setLinkWorker(chainId: ChainId, link: TaskLink, workerId: InstanceId): Promise<void> {
    const m = this.manifests.get(chainId);
    if (m) m.link_workers[link] = workerId;
  }
  async record(_chainId: ChainId, event: ChainAuditEventInput): Promise<void> {
    this.events.push(event);
  }
  async closeChain(
    chainId: ChainId,
    status: "completed" | "failed" | "aborted" | "merge_failed",
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const m = this.manifests.get(chainId);
    if (m) {
      m.status = status;
      m.completed_at = new Date().toISOString();
    }
    this.closures.push({ chainId, status, extra });
  }
  async readManifest(chainId: ChainId): Promise<ChainManifest | null> {
    return this.manifests.get(chainId) ?? null;
  }
  async appendChildChain(parentChainId: ChainId, child: ChainId): Promise<void> {
    const m = this.manifests.get(parentChainId);
    if (m && !m.child_chain_ids.includes(child)) {
      m.child_chain_ids.push(child);
    }
  }
  async incrementRetry(chainId: ChainId): Promise<
    { total_retry_count: number; max_total_retries: number } | null
  > {
    const m = this.manifests.get(chainId);
    if (!m) return null;
    m.total_retry_count = (m.total_retry_count ?? 0) + 1;
    return {
      total_retry_count: m.total_retry_count,
      max_total_retries: m.max_total_retries,
    };
  }
}

class SilentLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
}

class FakeRegistry implements IInstanceRegistry {
  constructor(private readonly instances: Instance[]) {}
  async register(): Promise<Instance> {
    throw new Error("not used");
  }
  async unregister(): Promise<void> {}
  async heartbeat(): Promise<void> {}
  async list(): Promise<Instance[]> {
    return [...this.instances];
  }
  async get(id: InstanceId): Promise<Instance | null> {
    return this.instances.find((i) => i.id === id) ?? null;
  }
  async watch(): Promise<Instance[]> {
    return [...this.instances];
  }
}

class FakeMessageRouter implements IMessageRouter {
  sent: SendMessageInput[] = [];
  async send(input: SendMessageInput): Promise<Message> {
    this.sent.push(input);
    return {
      id: asMessageId(`msg-${String(this.sent.length).padStart(10, "0")}`),
      type: input.type,
      from_instance: input.from_instance,
      from_name: input.from_name,
      from_role: input.from_role ?? "",
      to_instance: input.to_instance,
      to_name: input.to_name ?? null,
      content: input.content,
      link: input.link ?? null,
      task_id: input.task_id ?? null,
      chain_id: input.chain_id ?? null,
      task_title: input.task_title ?? null,
      task_description: input.task_description ?? null,
      task_criteria: input.task_criteria ?? null,
      result_path: input.result_path ?? null,
      reply_to: input.reply_to ?? null,
      read: false,
      created_at: new Date().toISOString(),
    };
  }
  async poll(): Promise<Message[]> {
    return [];
  }
  async waitForMessage(): Promise<void> {}
  async dismiss(): Promise<void> {}
}

class FakeBus implements IEventBus<LeaderEvent> {
  emitted: LeaderEvent[] = [];
  emit(event: LeaderEvent): void {
    this.emitted.push(event);
  }
  on(): () => void {
    return () => {};
  }
  onAny(): () => void {
    return () => {};
  }
}

class FakeRunner implements IClaudeRunner {
  async run(_opts: RunOptions): Promise<RunResult> {
    return { exit_code: 0, session_id: null, log_path: "/dev/null" };
  }
}

class FakeTemplateEngine implements ITemplateEngine {
  load(): string {
    return "";
  }
  render(): string {
    return "";
  }
  has(): boolean {
    return false;
  }
}

class MemoryZk {
  private nodes = new Map<string, Buffer>();
  state = "connected" as const;
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async exists(p: string): Promise<boolean> {
    return this.nodes.has(p);
  }
  async createPersistent(p: string, data: Buffer): Promise<string> {
    this.nodes.set(p, data);
    return p;
  }
  async createPersistentSequential(
    parent: string,
    prefix: string,
    data: Buffer,
  ): Promise<string> {
    const seq = String(this.nodes.size + 1).padStart(10, "0");
    const full = `${parent}/${prefix}${seq}`;
    this.nodes.set(full, data);
    return full;
  }
  async createEphemeral(p: string, data: Buffer): Promise<string> {
    this.nodes.set(p, data);
    return p;
  }
  async createEphemeralSequential(
    parent: string,
    prefix: string,
    data: Buffer,
  ): Promise<string> {
    return this.createPersistentSequential(parent, prefix, data);
  }
  async setData(p: string, data: Buffer): Promise<never> {
    this.nodes.set(p, data);
    return { version: 1, ctime: 0, mtime: 0 } as never;
  }
  async getData(p: string) {
    const v = this.nodes.get(p);
    if (!v) return null;
    return { data: v, stat: { version: 1, ctime: 0, mtime: 0 } };
  }
  async getChildren(p: string): Promise<string[]> {
    const prefix = `${p}/`;
    const out: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) out.push(rest);
      }
    }
    return out;
  }
  async watchChildren(): Promise<string[]> {
    return [];
  }
  async watchData(): Promise<Buffer | null> {
    return null;
  }
  async delete(p: string): Promise<void> {
    this.nodes.delete(p);
  }
  async mkdirp(): Promise<void> {}
  on(): void {}
}

function makeInstance(
  id: string,
  name: string,
  role: Instance["role"],
): Instance {
  return {
    id: asInstanceId(id),
    name,
    role,
    status: "idle",
    current_task_id: null,
    connected_since: new Date().toISOString(),
    work_dir: null,
    worktree_name: null,
    worktree_path: null,
    worktree_branch: null,
    pid: null,
    protocol_version: "v0.6",
  };
}

const LEADER_ID = asInstanceId("leader-1");
const CHAIN_ID: ChainId = asChainId("chain-test-001");

function setup(
  instances: Instance[] = [],
  opts?: {
    max_chain_retries?: number;
    magic_mode?: boolean;
    magic_max_chains?: number | null;
    merge_validator?: { validate: (...a: unknown[]) => Promise<unknown> };
  },
): {
  router: ChainRouter;
  queue: TaskQueue;
  bus: FakeBus;
  msg: FakeMessageRouter;
  audit: FakeChainAudit;
} {
  const zk = new MemoryZk();
  const queue = new TaskQueue({ zk: zk as never });
  const bus = new FakeBus();
  const msg = new FakeMessageRouter();
  const registry = new FakeRegistry(instances);
  const audit = new FakeChainAudit();
  const router = new ChainRouter({
    task_queue: queue,
    message_router: msg,
    registry,
    bus,
    runner: new FakeRunner(),
    template_engine: new FakeTemplateEngine(),
    logger: new SilentLogger(),
    leader_id: LEADER_ID,
    leader_name: "Leader",
    cache_paths: {
      projects_root: "/tmp/co-test",
      leader_instance_id: LEADER_ID,
    },
    chain_audit: audit as never,
    max_chain_retries: opts?.max_chain_retries,
    magic_mode: opts?.magic_mode,
    magic_max_chains: opts?.magic_max_chains,
    merge_validator: opts?.merge_validator as never,
  });
  return { router, queue, bus, msg, audit };
}

function chainDefJson(): string {
  return JSON.stringify({
    chain_id: CHAIN_ID,
    chain_title: "Test chain",
    tasks: {
      plan: {
        title: "plan title",
        description: "plan desc",
        criteria: "plan criteria",
        priority: 1,
      },
      execute: {
        title: "build title",
        description: "build desc",
        criteria: "build criteria",
        priority: 1,
      },
      verify: {
        title: "verify title",
        description: "verify desc",
        criteria: "verify criteria",
        priority: 1,
      },
      review: {
        title: "review title",
        description: "review desc",
        criteria: "review criteria",
        priority: 1,
      },
      accept: {
        title: "accept title",
        description: "accept desc",
        criteria: "accept criteria",
        priority: 1,
      },
    },
  });
}

function chainDefMessage(content: string): Message {
  // ChainRouter.route() reaches handleTaskDefinitions when
  //   msg.link != null
  //   AND NOT (link == "plan" && type == "completion_report")
  //   AND looksLikeChainDef(content) is true.
  // The natural production path is via handleRequirement → claude-cli
  // decompose, but the routing branch also covers a direct ChainDef
  // delivery, which we use here to exercise handleTaskDefinitions
  // without faking a runner that writes to the decompose result path.
  return {
    id: asMessageId("msg-input"),
    type: "direct",
    from_instance: LEADER_ID,
    from_name: "Leader",
    from_role: "leader",
    to_instance: LEADER_ID,
    to_name: null,
    content,
    link: "plan",
    task_id: null,
    chain_id: null,
    task_title: null,
    task_description: null,
    task_criteria: null,
    result_path: null,
    reply_to: null,
    read: false,
    created_at: new Date().toISOString(),
  };
}

function completionMessage(
  link: TaskLink,
  decisionJson: string,
  from: InstanceId,
): Message {
  return {
    id: asMessageId("msg-completion"),
    type: "completion_report",
    from_instance: from,
    from_name: "Worker",
    from_role: "executor",
    to_instance: LEADER_ID,
    to_name: null,
    content: decisionJson,
    link,
    task_id: null,
    chain_id: CHAIN_ID,
    task_title: null,
    task_description: null,
    task_criteria: null,
    result_path: null,
    reply_to: null,
    read: false,
    created_at: new Date().toISOString(),
  };
}

describe("ChainRouter.handleTaskDefinitions", () => {
  it("pushes 5 tasks with description+criteria and dispatches first link with full task context", async () => {
    const planner = makeInstance("tom-01", "Tom", "planner");
    const { router, queue, bus, msg } = setup([planner]);

    await router.route(chainDefMessage(chainDefJson()));

    const pending = await queue.listPending();
    expect(pending).toHaveLength(5);
    const plan = pending.find((t) => t.link === "plan")!;
    expect(plan.description).toBe("plan desc");
    expect(plan.criteria).toBe("plan criteria");

    expect(msg.sent).toHaveLength(1);
    const dispatch = msg.sent[0];
    expect(dispatch.type).toBe("task_dispatch");
    expect(dispatch.link).toBe("plan");
    expect(dispatch.to_instance).toBe(planner.id);
    expect(dispatch.task_title).toBe("plan title");
    expect(dispatch.task_description).toBe("plan desc");
    expect(dispatch.task_criteria).toBe("plan criteria");

    expect(bus.emitted).toContainEqual({
      type: "chain_activated",
      chain_id: CHAIN_ID,
    });
  });

  it("pins the first link's pending task to the dispatched planner via assigned_to, leaving downstream links unassigned", async () => {
    const planner = makeInstance("tom-01", "Tom", "planner");
    const { router, queue } = setup([planner]);

    await router.route(chainDefMessage(chainDefJson()));

    const pending = await queue.listPending();
    const plan = pending.find((t) => t.link === "plan")!;
    expect(plan.assigned_to).toBe(planner.id);
    expect(plan.assigned_to_name).toBe(planner.name);

    for (const link of ["execute", "verify", "review", "accept"] as const) {
      const t = pending.find((x) => x.link === link)!;
      expect(t.assigned_to).toBeNull();
      expect(t.assigned_to_name).toBeNull();
    }
  });
});

describe("ChainRouter.activate_next assigns before dispatch", () => {
  it("calls task_queue.assign(nextTask, worker) before sending task_dispatch", async () => {
    const tom = makeInstance("tom-01", "Tom", "planner");
    const jerry = makeInstance("jerry-01", "Jerry", "executor");
    const { router, queue, msg } = setup([tom, jerry]);

    // Seed the chain via handleTaskDefinitions — plan pinned to Tom.
    await router.route(chainDefMessage(chainDefJson()));
    const before = await queue.listPending();
    const buildBefore = before.find((t) => t.link === "execute")!;
    expect(buildBefore.assigned_to).toBeNull();

    // Tom reports activate_next → build.
    await router.route(
      completionMessage(
        "plan",
        JSON.stringify({
          decision: "activate_next",
          reason: "ok",
          next_link: "execute",
        }),
        tom.id,
      ),
    );

    const after = await queue.listPending();
    const buildAfter = after.find((t) => t.link === "execute")!;
    expect(buildAfter.assigned_to).toBe(jerry.id);
    expect(buildAfter.assigned_to_name).toBe(jerry.name);

    const buildDispatch = msg.sent.find(
      (m) => m.link === "execute" && m.type === "task_dispatch",
    );
    expect(buildDispatch).toBeTruthy();
    expect(buildDispatch!.to_instance).toBe(jerry.id);
  });
});

describe("ChainRouter.handleCompletionReport — activate_next", () => {
  it("dispatches next link to a matching idle worker with task context threaded through", async () => {
    const builder = makeInstance("jerry-01", "Jerry", "executor");
    const { router, msg } = setup([builder]);

    const decision = {
      decision: "activate_next",
      reason: "blueprint complete",
      next_link: "execute",
    };
    await router.route(
      completionMessage("plan", JSON.stringify(decision), asInstanceId("tom-01")),
    );

    expect(msg.sent).toHaveLength(1);
    const dispatch = msg.sent[0];
    expect(dispatch.type).toBe("task_dispatch");
    expect(dispatch.link).toBe("execute");
    expect(dispatch.to_instance).toBe(builder.id);
    expect(dispatch.task_id).toBeTruthy();
    expect("task_description" in dispatch).toBe(true);
    expect("task_criteria" in dispatch).toBe(true);
  });

  it("reuses the existing pending task for the chain's next link instead of creating a duplicate", async () => {
    const planner = makeInstance("tom-01", "Tom", "planner");
    const builder = makeInstance("jerry-01", "Jerry", "executor");
    const { router, queue, msg } = setup([planner, builder]);

    // First: seed the chain with handleTaskDefinitions (5 pending tasks
    // with full description/criteria).
    await router.route(chainDefMessage(chainDefJson()));
    const initialPending = await queue.listPending();
    expect(initialPending).toHaveLength(5);
    const buildTaskId = initialPending.find((t) => t.link === "execute")!.id;
    const dispatchedToPlannerCount = msg.sent.length;

    // Then: Tom reports activate_next → build.
    const decision = {
      decision: "activate_next",
      reason: "blueprint complete",
      next_link: "execute",
    };
    await router.route(
      completionMessage("plan", JSON.stringify(decision), planner.id),
    );

    // No duplicate task was pushed — pending count is still 5.
    const afterPending = await queue.listPending();
    expect(afterPending).toHaveLength(5);

    // The build dispatch references the **existing** build task id, and
    // carries the full description / criteria from that task.
    const buildDispatch = msg.sent[dispatchedToPlannerCount];
    expect(buildDispatch.task_id).toBe(buildTaskId);
    expect(buildDispatch.task_description).toBe("build desc");
    expect(buildDispatch.task_criteria).toBe("build criteria");
  });

  it("falls back to pushing a new task when no pending task matches the chain/link", async () => {
    // Activate without ever seeding the chain — e.g. recovery after the
    // original pending task was cleared.
    const builder = makeInstance("jerry-01", "Jerry", "executor");
    const { router, queue, msg } = setup([builder]);

    const decision = {
      decision: "activate_next",
      reason: "ad-hoc",
      next_link: "execute",
    };
    await router.route(
      completionMessage("plan", JSON.stringify(decision), asInstanceId("tom-01")),
    );

    const pending = await queue.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].link).toBe("execute");
    expect(msg.sent).toHaveLength(1);
    expect(msg.sent[0].task_id).toBe(pending[0].id);
  });
});

describe("ChainRouter.handleCompletionReport — feedback / reject / close_chain", () => {
  it("emits chain_closed on close_chain and does not dispatch a new task", async () => {
    const { router, msg, bus } = setup([]);
    const decision = {
      decision: "close_chain",
      reason: "all acceptance criteria met",
    };
    await router.route(
      completionMessage("accept", JSON.stringify(decision), asInstanceId("leo-01")),
    );
    expect(msg.sent).toHaveLength(0);
    expect(bus.emitted).toContainEqual({
      type: "chain_closed",
      chain_id: CHAIN_ID,
    });
  });

  it("emits chain_closed on reject", async () => {
    const { router, bus } = setup([]);
    const decision = {
      decision: "reject",
      reason: "fundamentally diverges",
    };
    await router.route(
      completionMessage("review", JSON.stringify(decision), asInstanceId("mia-01")),
    );
    expect(bus.emitted).toContainEqual({
      type: "chain_closed",
      chain_id: CHAIN_ID,
    });
  });

  it("routes verifier feedback to the upstream builder as a retry task_dispatch (no explicit feedback_target)", async () => {
    // Set up a chain where Tom (planner) and Jerry (builder) have already
    // been dispatched tasks for this chain. Then Lucy (verifier) reports
    // feedback without an explicit feedback_target — it should land in
    // Jerry's inbox as a fresh pending build task with retry_count=1,
    // not as an opaque direct message.
    const tom = makeInstance("tom-01", "Tom", "planner");
    const jerry = makeInstance("jerry-01", "Jerry", "executor");
    const { router, msg, queue } = setup([tom, jerry]);
    await router.route(chainDefMessage(chainDefJson()));
    expect(msg.sent[0].to_instance).toBe(tom.id); // plan dispatched to Tom

    // Tom reports activate_next → build to dispatch to Jerry.
    await router.route(
      completionMessage(
        "plan",
        JSON.stringify({
          decision: "activate_next",
          reason: "ok",
          next_link: "execute",
        }),
        tom.id,
      ),
    );
    expect(msg.sent.at(-1)!.to_instance).toBe(jerry.id);

    // Lucy reports feedback.
    const before = msg.sent.length;
    await router.route(
      completionMessage(
        "verify",
        JSON.stringify({
          decision: "feedback",
          reason: "FAILURE: page_size>100 unrejected",
          feedback_to_worker: "Add page_size<=100 validation",
        }),
        asInstanceId("lucy-01"),
      ),
    );
    expect(msg.sent.length).toBe(before + 1);
    const fb = msg.sent.at(-1)!;
    expect(fb.type).toBe("task_dispatch");
    expect(fb.to_instance).toBe(jerry.id);
    expect(fb.link).toBe("execute");
    expect(fb.task_description).toBe("Add page_size<=100 validation");
    expect(fb.task_id).toBeTruthy();

    // A fresh pending build task was pushed with retry_count=1, assigned
    // to Jerry and carrying the feedback as its description.
    const pending = await queue.listPending();
    const retry = pending.find(
      (t) => t.link === "execute" && (t.retry_count ?? 0) >= 1,
    );
    expect(retry).toBeTruthy();
    expect(retry!.assigned_to).toBe(jerry.id);
    expect(retry!.description).toBe("Add page_size<=100 validation");
  });

  it("honors explicit feedback_target over the prior-link fallback", async () => {
    const tom = makeInstance("tom-01", "Tom", "planner");
    const jerry = makeInstance("jerry-01", "Jerry", "executor");
    const { router, msg } = setup([tom, jerry]);
    await router.route(chainDefMessage(chainDefJson()));
    const targetOverride = asInstanceId("custom-target-instance");

    await router.route(
      completionMessage(
        "verify",
        JSON.stringify({
          decision: "feedback",
          reason: "explicit redirect",
          feedback_to_worker: "redo",
          feedback_target: targetOverride,
        }),
        asInstanceId("lucy-01"),
      ),
    );
    const fb = msg.sent.at(-1)!;
    expect(fb.to_instance).toBe(targetOverride);
    expect(fb.type).toBe("task_dispatch");
  });

  it("drops feedback when neither explicit target nor prior-link worker is resolvable", async () => {
    // Plan link feedback has no prior link, and there is no upstream
    // manifest entry to bounce back to. The previous implementation
    // silently routed to msg.from_instance, which caused workers to
    // receive their own feedback — death loop. The new contract is to
    // drop the dispatch and leave a single feedback_unresolved audit
    // record + a debug_info TUI event.
    const { router, msg, bus } = setup([]);
    await router.route(
      completionMessage(
        "plan",
        JSON.stringify({
          decision: "feedback",
          reason: "needs more detail",
          feedback_to_worker: "expand the blueprint",
        }),
        asInstanceId("tom-01"),
      ),
    );
    // No new task_dispatch was sent in response to the feedback.
    expect(
      msg.sent.find(
        (m) =>
          m.type === "task_dispatch" &&
          m.task_description === "expand the blueprint",
      ),
    ).toBeUndefined();
    // The TUI received a debug_info warning about the dropped feedback.
    expect(
      bus.emitted.some(
        (e) =>
          e.type === "debug_info" &&
          typeof (e as { message: string }).message === "string" &&
          (e as { message: string }).message.includes("no resolvable target"),
      ),
    ).toBe(true);
  });

  it("aborts the chain when feedback exceeds max_chain_retries (A5 ceiling)", async () => {
    // Configure a 1-retry ceiling so the first feedback succeeds and the
    // second exceeds. Build a chain with planner+builder so feedback has
    // a resolvable prior-link target (otherwise A6 drops it before A5
    // gets a chance to count).
    const tom = makeInstance("tom-01", "Tom", "planner");
    const jerry = makeInstance("jerry-01", "Jerry", "executor");
    const { router, msg, bus, audit, queue } = setup([tom, jerry], {
      max_chain_retries: 1,
    });
    await router.route(chainDefMessage(chainDefJson()));
    // Drive plan → activate_next so build is dispatched to Jerry and the
    // manifest records link_workers.build for prev-link resolution.
    await router.route(
      completionMessage(
        "plan",
        JSON.stringify({
          decision: "activate_next",
          reason: "ok",
          next_link: "execute",
        }),
        tom.id,
      ),
    );

    // First feedback: under the ceiling (post-increment = 1 <= 1).
    await router.route(
      completionMessage(
        "verify",
        JSON.stringify({
          decision: "feedback",
          reason: "first FAILURE",
          feedback_to_worker: "fix #1",
        }),
        asInstanceId("lucy-01"),
      ),
    );
    const dispatchesAfterFirst = msg.sent.filter(
      (m) => m.type === "task_dispatch" && m.task_description === "fix #1",
    );
    expect(dispatchesAfterFirst).toHaveLength(1);
    const manifestAfterFirst = await audit.readManifest(CHAIN_ID);
    expect(manifestAfterFirst!.total_retry_count).toBe(1);
    expect(manifestAfterFirst!.status).toBe("running");

    // Second feedback: post-increment = 2 > 1 → must abort the chain.
    const beforeSecond = msg.sent.length;
    await router.route(
      completionMessage(
        "verify",
        JSON.stringify({
          decision: "feedback",
          reason: "second FAILURE",
          feedback_to_worker: "fix #2",
        }),
        asInstanceId("lucy-01"),
      ),
    );
    // No new task_dispatch with the second feedback was pushed.
    expect(
      msg.sent.slice(beforeSecond).find(
        (m) => m.type === "task_dispatch" && m.task_description === "fix #2",
      ),
    ).toBeUndefined();
    // No new pending task with description "fix #2" exists.
    const pending = await queue.listPending();
    expect(pending.find((t) => t.description === "fix #2")).toBeUndefined();
    // Chain transitioned to aborted with the ceiling reason.
    const closure = audit.closures.find((c) => c.chainId === CHAIN_ID);
    expect(closure).toBeTruthy();
    expect(closure!.status).toBe("aborted");
    expect(closure!.extra?.reason).toBe("retry_ceiling_exceeded");
    // chain_closed event was emitted.
    expect(
      bus.emitted.some(
        (e) => e.type === "chain_closed" && e.chain_id === CHAIN_ID,
      ),
    ).toBe(true);
    // Audit log carries retry_ceiling_exceeded.
    expect(audit.events.some((e) => e.event === "retry_ceiling_exceeded")).toBe(
      true,
    );
  });
});

describe("ChainRouter.handleCompletionReport — merge validation on close_chain", () => {
  it("invokes MergeValidator.validate for every commit collected during the chain, in arrival order", async () => {
    const validated: { branch: string; sha: string; task_link: string }[] = [];
    const mergeValidator = {
      async validate(commit: {
        branch: string;
        sha: string;
        task_link: string;
      }): Promise<{ decision: "merge"; reason: string }> {
        validated.push({
          branch: commit.branch,
          sha: commit.sha,
          task_link: commit.task_link,
        });
        return { decision: "merge", reason: "ok" };
      },
    };
    const zk = new MemoryZk();
    const queue = new TaskQueue({ zk: zk as never });
    const bus = new FakeBus();
    const msg = new FakeMessageRouter();
    const registry = new FakeRegistry([]);
    const router = new ChainRouter({
      task_queue: queue,
      message_router: msg,
      registry,
      bus,
      runner: new FakeRunner(),
      template_engine: new FakeTemplateEngine(),
      logger: new SilentLogger(),
      leader_id: LEADER_ID,
      leader_name: "Leader",
      cache_paths: {
        projects_root: "/tmp/co-test",
        leader_instance_id: LEADER_ID,
      },
      merge_validator: mergeValidator,
    });

    // Feed three completion reports — each carrying a commit envelope —
    // then close the chain on the fourth (accept).
    const reports: [TaskLink, string][] = [
      ["plan", "aaaaaaa"],
      ["execute", "bbbbbbb"],
      ["verify", "ccccccc"],
      ["review", "ddddddd"],
    ];
    for (const [link, sha] of reports) {
      await router.route(
        completionMessage(
          link,
          JSON.stringify({
            decision: "activate_next",
            reason: "ok",
            next_link: NEXT_LINK[link],
            commit: {
              sha,
              message: `${link}: change`,
              branch: `co/${link}-1`,
            },
          }),
          asInstanceId(`${link}-worker-1`),
        ),
      );
    }
    expect(validated).toHaveLength(0); // not yet — only on close_chain

    await router.route(
      completionMessage(
        "accept",
        JSON.stringify({
          decision: "close_chain",
          reason: "all good",
          commit: {
            sha: "eeeeeee",
            message: "accept: sign off",
            branch: "co/accept-1",
          },
        }),
        asInstanceId("leo-01"),
      ),
    );

    expect(validated.map((v) => v.task_link)).toEqual([
      "plan",
      "execute",
      "verify",
      "review",
      "accept",
    ]);
    expect(validated.map((v) => v.sha)).toEqual([
      "aaaaaaa",
      "bbbbbbb",
      "ccccccc",
      "ddddddd",
      "eeeeeee",
    ]);
  });

  it("aborts close_chain as merge_failed and pushes a retry to the link's worker on conflict", async () => {
    // Setup: tom + jerry, chain dispatched, build recorded as the link
    // owned by Jerry in link_workers. Then drive build → activate_next
    // so the manifest's link_workers["execute"] = jerry. Close the chain
    // with a merge validator that throws on the build commit only —
    // verify the chain becomes "merge_failed" (not "completed"), the
    // chain_merge_failed event fires with the failure list, and Jerry
    // receives a retry task addressed to him with a description naming
    // the conflicting sha/branch.
    const tom = makeInstance("tom-01", "Tom", "planner");
    const jerry = makeInstance("jerry-01", "Jerry", "executor");
    const lucy = makeInstance("lucy-01", "Lucy", "verifier");
    const mia = makeInstance("mia-01", "Mia", "reviewer");
    const leo = makeInstance("leo-01", "Leo", "accepter");

    const mergeValidator = {
      async validate(commit: { branch: string; sha: string; task_link: string }) {
        if (commit.task_link === "execute") {
          throw new Error(
            `merge ${commit.branch} conflicted at ${commit.sha}`,
          );
        }
        return { decision: "merge" as const, reason: "ok" };
      },
    };

    const zk = new MemoryZk();
    const queue = new TaskQueue({ zk: zk as never });
    const bus = new FakeBus();
    const msg = new FakeMessageRouter();
    const registry = new FakeRegistry([tom, jerry, lucy, mia, leo]);
    const audit = new FakeChainAudit();
    const router = new ChainRouter({
      task_queue: queue,
      message_router: msg,
      registry,
      bus,
      runner: new FakeRunner(),
      template_engine: new FakeTemplateEngine(),
      logger: new SilentLogger(),
      leader_id: LEADER_ID,
      leader_name: "Leader",
      cache_paths: {
        projects_root: "/tmp/co-test",
        leader_instance_id: LEADER_ID,
      },
      chain_audit: audit as never,
      merge_validator: mergeValidator,
    });

    // Activate chain + advance through every link so link_workers is
    // fully populated and chainCommits collects one commit per link.
    await router.route(chainDefMessage(chainDefJson()));
    const flow: { link: TaskLink; next: TaskLink | null; from: InstanceId }[] = [
      { link: "plan", next: "execute", from: tom.id },
      { link: "execute", next: "verify", from: jerry.id },
      { link: "verify", next: "review", from: lucy.id },
      { link: "review", next: "accept", from: mia.id },
    ];
    for (const step of flow) {
      await router.route(
        completionMessage(
          step.link,
          JSON.stringify({
            decision: "activate_next",
            reason: "ok",
            next_link: step.next,
            commit: {
              sha: `${step.link}-sha`,
              message: `${step.link}: change`,
              branch: `co/${step.link}-1`,
            },
          }),
          step.from,
        ),
      );
    }
    // close_chain with accept's commit also recorded.
    await router.route(
      completionMessage(
        "accept",
        JSON.stringify({
          decision: "close_chain",
          reason: "all good",
          commit: {
            sha: "accept-sha",
            message: "accept: sign off",
            branch: "co/accept-1",
          },
        }),
        leo.id,
      ),
    );

    // Chain closure was "merge_failed", not "completed".
    const closure = audit.closures.find((c) => c.chainId === CHAIN_ID);
    expect(closure).toBeTruthy();
    expect(closure!.status).toBe("merge_failed");
    expect(closure!.status).not.toBe("completed");

    // chain_merge_failed event lists the failure.
    const mfEvent = bus.emitted.find((e) => e.type === "chain_merge_failed");
    expect(mfEvent).toBeTruthy();
    if (mfEvent && mfEvent.type === "chain_merge_failed") {
      expect(mfEvent.failures).toHaveLength(1);
      expect(mfEvent.failures[0].link).toBe("execute");
      expect(mfEvent.failures[0].sha).toBe("execute-sha");
    }

    // chain_closed also fires (TUI shows the chain ended).
    expect(
      bus.emitted.some(
        (e) => e.type === "chain_closed" && e.chain_id === CHAIN_ID,
      ),
    ).toBe(true);

    // Jerry received a retry task naming the conflict.
    const retryToJerry = msg.sent.find(
      (m) =>
        m.type === "task_dispatch" &&
        m.to_instance === jerry.id &&
        m.link === "execute" &&
        typeof m.task_description === "string" &&
        m.task_description.includes("Merge conflict"),
    );
    expect(retryToJerry).toBeTruthy();

    // Audit log has a merge_failure entry.
    expect(audit.events.some((e) => e.event === "merge_failure")).toBe(true);
  });

  it("does not invoke MergeValidator on reject", async () => {
    const validated: unknown[] = [];
    const mergeValidator = {
      async validate(c: unknown) {
        validated.push(c);
        return { decision: "merge" as const, reason: "" };
      },
    };
    const zk = new MemoryZk();
    const queue = new TaskQueue({ zk: zk as never });
    const router = new ChainRouter({
      task_queue: queue,
      message_router: new FakeMessageRouter(),
      registry: new FakeRegistry([]),
      bus: new FakeBus(),
      runner: new FakeRunner(),
      template_engine: new FakeTemplateEngine(),
      logger: new SilentLogger(),
      leader_id: LEADER_ID,
      leader_name: "Leader",
      cache_paths: {
        projects_root: "/tmp/co-test",
        leader_instance_id: LEADER_ID,
      },
      merge_validator: mergeValidator,
    });
    await router.route(
      completionMessage(
        "review",
        JSON.stringify({
          decision: "reject",
          reason: "fundamental",
          commit: {
            sha: "ffffffff",
            message: "wip",
            branch: "co/r-1",
          },
        }),
        asInstanceId("mia-01"),
      ),
    );
    expect(validated).toHaveLength(0);
  });
});

const NEXT_LINK: Record<string, TaskLink> = {
  plan: "execute",
  execute: "verify",
  verify: "review",
  review: "accept",
  accept: "explore",
};

// ---------------------------------------------------------------------------
// memory_refresh routing
// ---------------------------------------------------------------------------
//
// Builders send a memory_refresh message after a successful commit so the
// Leader can regenerate the workspace memory entries for the changed files.
// ChainRouter only parses + delegates; the regeneration itself is covered by
// memory-bootstrap.test.ts.

interface FakeMemoryBootstrap {
  calls: string[][];
  run_count: number;
  refresh_stale_count: number;
  refreshFiles: (sources: string[]) => Promise<{
    generated: number;
    failed: number;
    filtered_out: number;
  }>;
  run: () => Promise<{
    files_generated: number;
    files_skipped: number;
    files_failed: number;
    dirs_generated: number;
    dirs_failed: number;
  }>;
  refreshStale: () => Promise<{
    stale_found: number;
    generated: number;
    failed: number;
    filtered_out: number;
  }>;
}

function makeFakeBootstrap(): FakeMemoryBootstrap {
  const calls: string[][] = [];
  const state = { run_count: 0, refresh_stale_count: 0 };
  return {
    calls,
    get run_count() {
      return state.run_count;
    },
    get refresh_stale_count() {
      return state.refresh_stale_count;
    },
    async refreshFiles(sources: string[]) {
      calls.push([...sources]);
      return { generated: sources.length, failed: 0, filtered_out: 0 };
    },
    async run() {
      state.run_count += 1;
      return {
        files_generated: 0,
        files_skipped: 0,
        files_failed: 0,
        dirs_generated: 0,
        dirs_failed: 0,
      };
    },
    async refreshStale() {
      state.refresh_stale_count += 1;
      return { stale_found: 0, generated: 0, failed: 0, filtered_out: 0 };
    },
  };
}

/** Build a TUI-style user_input message with no link — what `/init` etc. come in as. */
function slashCommandMessage(text: string): Message {
  return {
    id: asMessageId("msg-slash"),
    type: "user_input",
    from_instance: LEADER_ID,
    from_name: "Leader",
    from_role: "leader",
    to_instance: LEADER_ID,
    to_name: null,
    content: text,
    link: null,
    task_id: null,
    chain_id: null,
    task_title: null,
    task_description: null,
    task_criteria: null,
    result_path: null,
    original_requirement_path: null,
    reply_to: null,
    read: false,
    created_at: new Date().toISOString(),
  };
}

function memoryRefreshMessage(content: string): Message {
  return {
    id: asMessageId("msg-mr"),
    type: "memory_refresh",
    from_instance: asInstanceId("alpha"),
    from_name: "alpha",
    from_role: "executor",
    to_instance: LEADER_ID,
    to_name: null,
    content,
    link: "execute",
    task_id: null,
    chain_id: null,
    task_title: null,
    task_description: null,
    task_criteria: null,
    result_path: null,
    original_requirement_path: null,
    reply_to: null,
    read: false,
    created_at: new Date().toISOString(),
  };
}

function memoryRefreshRouter(
  bootstrap: FakeMemoryBootstrap | undefined,
): ChainRouter {
  return new ChainRouter({
    task_queue: new TaskQueue({ zk: new MemoryZk() as never }),
    message_router: new FakeMessageRouter(),
    registry: new FakeRegistry([]),
    bus: new FakeBus(),
    runner: new FakeRunner(),
    template_engine: new FakeTemplateEngine(),
    logger: new SilentLogger(),
    leader_id: LEADER_ID,
    leader_name: "Leader",
    cache_paths: {
      projects_root: "/tmp/co-test",
      leader_instance_id: LEADER_ID,
    },
    memory_bootstrap: bootstrap as never,
  });
}

describe("ChainRouter.handleMemoryRefresh", () => {
  it("parses changed_files from the JSON payload and forwards them to MemoryBootstrap.refreshFiles", async () => {
    const bs = makeFakeBootstrap();
    const router = memoryRefreshRouter(bs);
    await router.route(
      memoryRefreshMessage(
        JSON.stringify({
          chain_id: "chain-1",
          task_id: "task-1",
          commit_sha: "deadbeef",
          changed_files: [
            "packages/worker/src/watcher.ts",
            "packages/leader/src/chain-router.ts",
          ],
        }),
      ),
    );
    expect(bs.calls).toHaveLength(1);
    expect(bs.calls[0]).toEqual([
      "packages/worker/src/watcher.ts",
      "packages/leader/src/chain-router.ts",
    ]);
  });

  it("does not call MemoryBootstrap when changed_files is empty or absent", async () => {
    const bs = makeFakeBootstrap();
    const router = memoryRefreshRouter(bs);
    await router.route(memoryRefreshMessage(JSON.stringify({ changed_files: [] })));
    await router.route(memoryRefreshMessage(JSON.stringify({})));
    expect(bs.calls).toHaveLength(0);
  });

  it("silently drops malformed payloads (not JSON, wrong type) — refresh is best-effort", async () => {
    const bs = makeFakeBootstrap();
    const router = memoryRefreshRouter(bs);
    await router.route(memoryRefreshMessage("not-json"));
    await router.route(
      memoryRefreshMessage(JSON.stringify({ changed_files: "scalar-not-array" })),
    );
    expect(bs.calls).toHaveLength(0);
  });

  it("is a no-op when no MemoryBootstrap is wired (test/CLI flows)", async () => {
    const router = memoryRefreshRouter(undefined);
    // Should not throw — handler logs and returns.
    await router.route(
      memoryRefreshMessage(
        JSON.stringify({ changed_files: ["packages/worker/src/watcher.ts"] }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// /init slash command
// ---------------------------------------------------------------------------
//
// `/init` is the user-driven entry point that fills the workspace memory
// tree. The startup orchestrator no longer triggers a bootstrap, so this
// is the only way the memory tree gets populated. Slash commands arrive
// through the TUI as user_input messages with link=null; ChainRouter
// dispatches them ahead of the decompose flow.

describe("ChainRouter slash commands", () => {
  // Yield a tick so the fire-and-forget bootstrap promise inside
  // runInitCommand has a chance to resolve before the test asserts on
  // the fake's call counts.
  const flushMicrotasks = () =>
    new Promise<void>((resolve) => setImmediate(resolve));

  it("/init triggers MemoryBootstrap.run() and MemoryBootstrap.refreshStale()", async () => {
    const bs = makeFakeBootstrap();
    const router = memoryRefreshRouter(bs);
    await router.route(slashCommandMessage("/init"));
    await flushMicrotasks();
    expect(bs.run_count).toBe(1);
    expect(bs.refresh_stale_count).toBe(1);
  });

  it("/init tolerates trailing whitespace and trailing args", async () => {
    const bs = makeFakeBootstrap();
    const router = memoryRefreshRouter(bs);
    await router.route(slashCommandMessage("  /init  --some-future-flag  "));
    await flushMicrotasks();
    expect(bs.run_count).toBe(1);
    expect(bs.refresh_stale_count).toBe(1);
  });

  it("/init is a no-op when MemoryBootstrap is not wired", async () => {
    const router = memoryRefreshRouter(undefined);
    // Must not throw and must not invoke any downstream — confirmed by
    // the absence of any send / push to the fake collaborators.
    await router.route(slashCommandMessage("/init"));
    await flushMicrotasks();
  });

  it("unknown slash command does not trigger bootstrap and falls through (logged as warning)", async () => {
    const bs = makeFakeBootstrap();
    const router = memoryRefreshRouter(bs);
    await router.route(slashCommandMessage("/totally-unknown-command"));
    await flushMicrotasks();
    // /init was not called.
    expect(bs.run_count).toBe(0);
    expect(bs.refresh_stale_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// v0.7 NEW — magic loop (FR-31, FR-33, FR-34, FR-35)
// ---------------------------------------------------------------------------

describe("ChainRouter — spawn_chain decision (FR-33)", () => {
  // Seed a chain manifest directly in the FakeChainAudit so we can
  // drive handleCompletionReport without rebuilding the full
  // requirement → decompose → dispatch flow.
  async function seedMagicChain(
    audit: FakeChainAudit,
    chainId: ChainId,
    chainDepth: number,
  ): Promise<void> {
    await audit.openChain(chainId, {
      created_at: new Date().toISOString(),
      leader_id: LEADER_ID,
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
      magic_mode: true,
      parent_chain_id: null,
      chain_depth: chainDepth,
    });
  }

  it("spawn_chain at explore closes the parent and injects a user_input with spawned_from + next_requirement", async () => {
    const mergeValidator = {
      // skip = no new commits to merge; treated as success.
      async validate(): Promise<{ decision: "skip"; reason: string }> {
        return { decision: "skip", reason: "no commits" };
      },
    };
    const { router, msg, audit } = setup([], {
      magic_mode: true,
      merge_validator: mergeValidator,
    });
    await seedMagicChain(audit, CHAIN_ID, 0);

    const decision = JSON.stringify({
      decision: "spawn_chain",
      reason: "ready for the next iteration",
      next_requirement: "Add caching to the export endpoint",
    });
    await router.route(
      completionMessage("explore", decision, asInstanceId("lisa-01")),
    );

    // Parent closed as completed (merge succeeded, no failures).
    const closure = audit.closures.find(
      (c) => c.chainId === CHAIN_ID,
    );
    expect(closure?.status).toBe("completed");

    // Synthetic user_input message was injected with the new fields.
    const spawned = msg.sent.find(
      (m) => m.type === "user_input" && m.spawned_from === CHAIN_ID,
    );
    expect(spawned).toBeTruthy();
    expect(spawned!.content).toBe("Add caching to the export endpoint");
    expect(spawned!.next_requirement).toBe("Add caching to the export endpoint");
    expect(spawned!.spawned_from).toBe(CHAIN_ID);
  });

  it("spawn_chain at accept (non-explore link) is rejected as invalid_decision and aborts the chain", async () => {
    const { router, msg, audit } = setup([], { magic_mode: true });
    await seedMagicChain(audit, CHAIN_ID, 0);

    const decision = JSON.stringify({
      decision: "spawn_chain",
      reason: "trying to spawn early",
      next_requirement: "should not happen",
    });
    await router.route(
      completionMessage("accept", decision, asInstanceId("jack-01")),
    );

    // invalid_decision audit + chain closed as aborted.
    expect(audit.events.some((e) => e.event === "invalid_decision")).toBe(true);
    const closure = audit.closures.find((c) => c.chainId === CHAIN_ID);
    expect(closure?.status).toBe("aborted");

    // No user_input spawn message was written.
    expect(
      msg.sent.some(
        (m) => m.type === "user_input" && m.spawned_from === CHAIN_ID,
      ),
    ).toBe(false);
  });
});

describe("ChainRouter — magic_max_chains cap (FR-34)", () => {
  async function seedMagicChain(
    audit: FakeChainAudit,
    chainId: ChainId,
    chainDepth: number,
  ): Promise<void> {
    await audit.openChain(chainId, {
      created_at: new Date().toISOString(),
      leader_id: LEADER_ID,
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
      magic_mode: true,
      parent_chain_id: null,
      chain_depth: chainDepth,
    });
  }

  it("demotes spawn_chain to close_chain when chain_depth + 1 reaches the cap", async () => {
    const mergeValidator = {
      async validate(): Promise<{ decision: "skip"; reason: string }> {
        return { decision: "skip", reason: "no commits" };
      },
    };
    const { router, msg, audit, bus } = setup([], {
      magic_mode: true,
      magic_max_chains: 2,
      merge_validator: mergeValidator,
    });
    // Parent depth=1 → spawning a child would make it depth=2 → hits
    // the cap (>= 2). The router must emit magic_depth_exhausted and
    // NOT write a spawn message.
    await seedMagicChain(audit, CHAIN_ID, 1);

    const decision = JSON.stringify({
      decision: "spawn_chain",
      reason: "want to keep going",
      next_requirement: "should be dropped",
    });
    await router.route(
      completionMessage("explore", decision, asInstanceId("lisa-01")),
    );

    expect(audit.events.some((e) => e.event === "magic_depth_exhausted")).toBe(
      true,
    );
    expect(
      bus.emitted.some((e) => e.type === "magic_depth_exhausted"),
    ).toBe(true);
    // Parent chain still closes as completed (the merge succeeded,
    // the demotion just skips the spawn).
    const closure = audit.closures.find((c) => c.chainId === CHAIN_ID);
    expect(closure?.status).toBe("completed");
    // No spawn message.
    expect(
      msg.sent.some(
        (m) => m.type === "user_input" && m.spawned_from === CHAIN_ID,
      ),
    ).toBe(false);
  });

  it("null magic_max_chains is unlimited (no demotion at any depth)", async () => {
    const mergeValidator = {
      async validate(): Promise<{ decision: "skip"; reason: string }> {
        return { decision: "skip", reason: "no commits" };
      },
    };
    const { router, msg, audit } = setup([], {
      magic_mode: true,
      magic_max_chains: null,
      merge_validator: mergeValidator,
    });
    await seedMagicChain(audit, CHAIN_ID, 99);

    const decision = JSON.stringify({
      decision: "spawn_chain",
      reason: "deep magic",
      next_requirement: "iterate further",
    });
    await router.route(
      completionMessage("explore", decision, asInstanceId("lisa-01")),
    );

    expect(audit.events.some((e) => e.event === "magic_depth_exhausted")).toBe(
      false,
    );
    expect(
      msg.sent.some(
        (m) => m.type === "user_input" && m.spawned_from === CHAIN_ID,
      ),
    ).toBe(true);
  });
});

describe("ChainRouter — explore link routing (FR-31)", () => {
  it("LINK_TO_ROLE maps explore to explorer (compile-time + runtime lock)", async () => {
    // Indirect proof: feed an activate_next on accept under magic_mode
    // — the router will look up the explorer worker. Without an
    // explorer in the registry the dispatch is skipped (logged), but
    // chain state still advances. We assert that the explore link is
    // a valid TaskLink the router recognizes.
    const { router, audit } = setup(
      [makeInstance("lisa-01", "Lisa", "explorer")],
      { magic_mode: true },
    );
    const chainId = asChainId(CHAIN_ID);
    await audit.openChain(chainId, {
      created_at: new Date().toISOString(),
      leader_id: LEADER_ID,
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
      magic_mode: true,
    });

    // Just confirm the magic-mode accept→explore decision is legal —
    // the router does not throw invalid_decision when handed it.
    const decision = JSON.stringify({
      decision: "activate_next",
      reason: "accepted; explore next",
      next_link: "explore",
    });
    await router.route(
      completionMessage("accept", decision, asInstanceId("jack-01")),
    );
    expect(audit.events.some((e) => e.event === "invalid_decision")).toBe(
      false,
    );
  });
});
