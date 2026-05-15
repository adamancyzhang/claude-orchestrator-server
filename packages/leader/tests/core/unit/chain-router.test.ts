// CORE-RETENTION
// Locks in: ChainRouter.handleTaskDefinitions / handleCompletionReport
//   observable behavior — what tasks land in TaskQueue and what
//   task_dispatch messages reach Worker inboxes when:
//     1. A ChainDef arrives → 5 pending tasks pushed (with description +
//        criteria) and the first link dispatched with full task context.
//     2. A Worker reports `activate_next` → next link is dispatched with
//        task_description / task_criteria / task_doc_path threaded through.
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
  async get(): Promise<Instance | null> {
    return null;
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
      task_doc_path: input.task_doc_path ?? null,
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

function setup(instances: Instance[] = []): {
  router: ChainRouter;
  queue: TaskQueue;
  bus: FakeBus;
  msg: FakeMessageRouter;
} {
  const zk = new MemoryZk();
  const queue = new TaskQueue({ zk: zk as never });
  const bus = new FakeBus();
  const msg = new FakeMessageRouter();
  const registry = new FakeRegistry(instances);
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
  });
  return { router, queue, bus, msg };
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
      build: {
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
    task_doc_path: null,
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
    from_role: "builder",
    to_instance: LEADER_ID,
    to_name: null,
    content: decisionJson,
    link,
    task_id: null,
    chain_id: CHAIN_ID,
    task_title: null,
    task_description: null,
    task_criteria: null,
    task_doc_path: null,
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

    for (const link of ["build", "verify", "review", "accept"] as const) {
      const t = pending.find((x) => x.link === link)!;
      expect(t.assigned_to).toBeNull();
      expect(t.assigned_to_name).toBeNull();
    }
  });
});

describe("ChainRouter.activate_next assigns before dispatch", () => {
  it("calls task_queue.assign(nextTask, worker) before sending task_dispatch", async () => {
    const tom = makeInstance("tom-01", "Tom", "planner");
    const jerry = makeInstance("jerry-01", "Jerry", "builder");
    const { router, queue, msg } = setup([tom, jerry]);

    // Seed the chain via handleTaskDefinitions — plan pinned to Tom.
    await router.route(chainDefMessage(chainDefJson()));
    const before = await queue.listPending();
    const buildBefore = before.find((t) => t.link === "build")!;
    expect(buildBefore.assigned_to).toBeNull();

    // Tom reports activate_next → build.
    await router.route(
      completionMessage(
        "plan",
        JSON.stringify({
          decision: "activate_next",
          reason: "ok",
          next_link: "build",
        }),
        tom.id,
      ),
    );

    const after = await queue.listPending();
    const buildAfter = after.find((t) => t.link === "build")!;
    expect(buildAfter.assigned_to).toBe(jerry.id);
    expect(buildAfter.assigned_to_name).toBe(jerry.name);

    const buildDispatch = msg.sent.find(
      (m) => m.link === "build" && m.type === "task_dispatch",
    );
    expect(buildDispatch).toBeTruthy();
    expect(buildDispatch!.to_instance).toBe(jerry.id);
  });
});

describe("ChainRouter.handleCompletionReport — activate_next", () => {
  it("dispatches next link to a matching idle worker with task context threaded through", async () => {
    const builder = makeInstance("jerry-01", "Jerry", "builder");
    const { router, msg } = setup([builder]);

    const decision = {
      decision: "activate_next",
      reason: "blueprint complete",
      next_link: "build",
    };
    await router.route(
      completionMessage("plan", JSON.stringify(decision), asInstanceId("tom-01")),
    );

    expect(msg.sent).toHaveLength(1);
    const dispatch = msg.sent[0];
    expect(dispatch.type).toBe("task_dispatch");
    expect(dispatch.link).toBe("build");
    expect(dispatch.to_instance).toBe(builder.id);
    expect(dispatch.task_id).toBeTruthy();
    expect("task_description" in dispatch).toBe(true);
    expect("task_criteria" in dispatch).toBe(true);
    expect("task_doc_path" in dispatch).toBe(true);
  });

  it("reuses the existing pending task for the chain's next link instead of creating a duplicate", async () => {
    const planner = makeInstance("tom-01", "Tom", "planner");
    const builder = makeInstance("jerry-01", "Jerry", "builder");
    const { router, queue, msg } = setup([planner, builder]);

    // First: seed the chain with handleTaskDefinitions (5 pending tasks
    // with full description/criteria).
    await router.route(chainDefMessage(chainDefJson()));
    const initialPending = await queue.listPending();
    expect(initialPending).toHaveLength(5);
    const buildTaskId = initialPending.find((t) => t.link === "build")!.id;
    const dispatchedToPlannerCount = msg.sent.length;

    // Then: Tom reports activate_next → build.
    const decision = {
      decision: "activate_next",
      reason: "blueprint complete",
      next_link: "build",
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
    const builder = makeInstance("jerry-01", "Jerry", "builder");
    const { router, queue, msg } = setup([builder]);

    const decision = {
      decision: "activate_next",
      reason: "ad-hoc",
      next_link: "build",
    };
    await router.route(
      completionMessage("plan", JSON.stringify(decision), asInstanceId("tom-01")),
    );

    const pending = await queue.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].link).toBe("build");
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

  it("routes verifier feedback to the upstream builder via the chain dispatch map (no explicit feedback_target)", async () => {
    // Set up a chain where Tom (planner) and Jerry (builder) have already
    // been dispatched tasks for this chain. Then Lucy (verifier) reports
    // feedback without an explicit feedback_target — it should land in
    // Jerry's inbox, not Lucy's.
    const tom = makeInstance("tom-01", "Tom", "planner");
    const jerry = makeInstance("jerry-01", "Jerry", "builder");
    const { router, msg } = setup([tom, jerry]);
    await router.route(chainDefMessage(chainDefJson()));
    expect(msg.sent[0].to_instance).toBe(tom.id); // plan dispatched to Tom

    // Tom reports activate_next → build to dispatch to Jerry.
    await router.route(
      completionMessage(
        "plan",
        JSON.stringify({
          decision: "activate_next",
          reason: "ok",
          next_link: "build",
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
    expect(fb.type).toBe("direct");
    expect(fb.to_instance).toBe(jerry.id);
    expect(fb.content).toBe("Add page_size<=100 validation");
  });

  it("honors explicit feedback_target over the prior-link fallback", async () => {
    const tom = makeInstance("tom-01", "Tom", "planner");
    const jerry = makeInstance("jerry-01", "Jerry", "builder");
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
    expect(msg.sent.at(-1)!.to_instance).toBe(targetOverride);
  });

  it("falls back to msg.from_instance only when neither feedback_target nor a prior-link worker exists", async () => {
    // Plan link feedback has no prior link to bounce back to.
    const { router, msg } = setup([]);
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
    const last = msg.sent.at(-1)!;
    expect(last.to_instance).toBe(asInstanceId("tom-01"));
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
      ["build", "bbbbbbb"],
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
      "build",
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
  plan: "build",
  build: "verify",
  verify: "review",
  review: "accept",
};
