// CORE-RETENTION
// Locks in: WorkerWatcher's dispatch entry early-return paths —
// (a) when a chain-link task is assigned to ANOTHER worker, the
//     watcher dismisses the message and returns WITHOUT touching the
//     downstream pipeline (runner / hooks / evaluator / commit_checker
//     / docs_committer). The legitimate assignee will pick it up.
// (b) duplicate message ids are deduped via the inFlight set so
//     processMessage runs exactly once for a repeated delivery.
// (c) processMessage wraps processTask in try/finally with
//     registry.heartbeat(busy) before and heartbeat(idle) after; both
//     calls are made even on early dispatch return.
// (d) registry.heartbeat rejections are absorbed via .catch() — the
//     dispatch continues; a flaky heartbeat write must not break the
//     watch loop.
// (e) stop() prevents any new processMessage from starting; the
//     waitForMessage callback returns at the stopped check.
// Critical because: every chain message routes through processMessage.
// A regression in any of these gates either silently drops legitimate
// work (false dismiss), double-runs the same task (no dedup), leaves
// the worker stuck on "busy" forever (no idle heartbeat), or crashes
// the watch loop on a heartbeat ZK blip (no .catch absorption).
// The full 8-step pipeline (claim → claude run → git rebase → commit
// → hook → ack → registry → completion) is OUT OF SCOPE here; this
// test only locks the dispatch entry.
// Primary sources: packages/worker/src/watcher.ts (start, processMessage)

import { describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  asMessageId,
  asTaskId,
  cachePaths,
  type CachePathOptions,
  type CreateInstanceInput,
  type CreateTaskInput,
  type ClaimRecord,
  type IClaudeRunner,
  type IHookEngine,
  type IInstanceRegistry,
  type ILogger,
  type IMessageRouter,
  type ITaskQueue,
  type ITemplateEngine,
  type Instance,
  type InstanceId,
  type InstanceRole,
  type Message,
  type RunOptions,
  type RunResult,
  type SendMessageInput,
  type Task,
  type TaskId,
} from "@co/contracts";
import { WorkerWatcher } from "../src/watcher.js";
import type { SelfEvaluator } from "../src/evaluator.js";
import type { CommitChecker } from "../src/commit-checker.js";
import type { WorkerDocsCommitter } from "../src/docs-committer.js";

const SELF = asInstanceId("worker-self");
const OTHER = asInstanceId("worker-other");
const LEADER = asInstanceId("leader");

// TRUST-JUSTIFICATION: All stubs below implement boundary interfaces
// from @co/contracts. The watcher is the SUT; the stubs replace its
// downstream collaborators ONLY enough to drive the dispatch entry
// path. Any method NOT used by the dispatch early-return paths throws,
// so a regression that drifts into the 8-step pipeline surfaces
// immediately as a thrown error.
// Downstream coverage: each collaborator (registry / queue / router /
// runner / evaluator / commit_checker / docs_committer / hooks) has
// its own focused tests in its package — see contracts coordination
// runtime tests + commit-checker.test.ts + evaluator.test.ts.

// CapturingLogger is a test data structure (not a mock) — no
// TRUST-JUSTIFICATION needed.
class CapturingLogger implements ILogger {
  public readonly warns: string[] = [];
  debug(): void {}
  info(): void {}
  warn(msg: string): void {
    this.warns.push(msg);
  }
  error(): void {}
  child(): ILogger {
    return this;
  }
}

// ── IMessageRouter stub: captures waitForMessage cb + dismiss calls ──
class StubMessageRouter implements IMessageRouter {
  private cb: ((msg: Message) => void) | null = null;
  public readonly dismissed: string[] = [];

  deliver(msg: Message): void {
    this.cb?.(msg);
  }

  async waitForMessage(
    _id: unknown,
    cb: (msg: Message) => void,
  ): Promise<void> {
    this.cb = cb;
  }

  async dismiss(_instanceId: InstanceId, messageId: string): Promise<void> {
    this.dismissed.push(messageId);
  }

  async send(_: SendMessageInput): Promise<Message> {
    throw new Error("StubMessageRouter.send unused");
  }
  async poll(): Promise<Message[]> {
    throw new Error("StubMessageRouter.poll unused");
  }
}

// ── IInstanceRegistry stub: counts heartbeat calls; optionally rejects ──
class StubRegistry implements IInstanceRegistry {
  public readonly heartbeats: Array<{
    status: string;
    current_task_id: TaskId | null;
  }> = [];
  public rejectHeartbeat = false;

  async heartbeat(
    _instanceId: InstanceId,
    patch: Partial<Instance>,
  ): Promise<void> {
    this.heartbeats.push({
      status: String(patch.status ?? ""),
      current_task_id: (patch.current_task_id as TaskId | null) ?? null,
    });
    if (this.rejectHeartbeat) {
      throw new Error("synthetic heartbeat failure");
    }
  }

  async register(_: CreateInstanceInput): Promise<Instance> {
    throw new Error("StubRegistry.register unused");
  }
  async unregister(): Promise<void> {
    throw new Error("StubRegistry.unregister unused");
  }
  async list(): Promise<Instance[]> {
    throw new Error("StubRegistry.list unused");
  }
  async get(): Promise<Instance | null> {
    throw new Error("StubRegistry.get unused");
  }
  async watch(): Promise<Instance[]> {
    throw new Error("StubRegistry.watch unused");
  }
}

// ── ITaskQueue stub: getPending returns a configurable task; rest throws ──
class StubTaskQueue implements ITaskQueue {
  private pending: Task | null = null;

  setPending(t: Task | null): void {
    this.pending = t;
  }

  async getPending(_taskId: TaskId): Promise<Task | null> {
    return this.pending;
  }

  async push(_: CreateTaskInput): Promise<Task> {
    throw new Error("StubTaskQueue.push unused");
  }
  async claim(_c: InstanceId, _r: InstanceRole): Promise<Task | null> {
    throw new Error("StubTaskQueue.claim unused");
  }
  async claimById(): Promise<Task | null> {
    throw new Error("StubTaskQueue.claimById unused (dispatch should dismiss)");
  }
  async assign(): Promise<Task | null> {
    throw new Error("StubTaskQueue.assign unused");
  }
  async complete(): Promise<void> {
    throw new Error("StubTaskQueue.complete unused");
  }
  async fail(): Promise<void> {
    throw new Error("StubTaskQueue.fail unused");
  }
  async retry(): Promise<Task> {
    throw new Error("StubTaskQueue.retry unused");
  }
  async listPending(): Promise<Task[]> {
    throw new Error("StubTaskQueue.listPending unused");
  }
  async listClaimed(): Promise<ClaimRecord[]> {
    throw new Error("StubTaskQueue.listClaimed unused");
  }
  async getCompleted(): Promise<Task | null> {
    throw new Error("StubTaskQueue.getCompleted unused");
  }
  async watchPending(): Promise<TaskId[]> {
    throw new Error("StubTaskQueue.watchPending unused");
  }
  async watchClaimed(): Promise<ClaimRecord[]> {
    throw new Error("StubTaskQueue.watchClaimed unused");
  }
}

// ── NEVER_* throw-on-any-call stubs: any reach beyond dispatch fails the test ──
const NEVER_RUNNER: IClaudeRunner = {
  async run(_: RunOptions): Promise<RunResult> {
    throw new Error("NEVER_RUNNER invoked — dispatch reached the 8-step pipeline");
  },
};

const NEVER_HOOKS: IHookEngine = {
  async fire(): Promise<void> {
    throw new Error("NEVER_HOOKS invoked");
  },
};

const NEVER_TEMPLATE: ITemplateEngine = {
  has: () => {
    throw new Error("NEVER_TEMPLATE.has invoked");
  },
  load: () => {
    throw new Error("NEVER_TEMPLATE.load invoked");
  },
  render: () => {
    throw new Error("NEVER_TEMPLATE.render invoked");
  },
};

const NEVER_EVALUATOR = {
  evaluate: () => {
    throw new Error("NEVER_EVALUATOR.evaluate invoked");
  },
} as unknown as SelfEvaluator;

const NEVER_COMMIT_CHECKER = {
  check: () => {
    throw new Error("NEVER_COMMIT_CHECKER.check invoked");
  },
} as unknown as CommitChecker;

const NEVER_DOCS_COMMITTER = {
  commitIfChanged: () => {
    throw new Error("NEVER_DOCS_COMMITTER.commitIfChanged invoked");
  },
} as unknown as WorkerDocsCommitter;

const CACHE_PATHS: CachePathOptions = {
  projects_root: "/tmp/co-test-projects-never-used",
  leader_instance_id: LEADER,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: asTaskId("task-1"),
    title: "t",
    description: "",
    criteria: "",
    priority: 1,
    status: "pending",
    link: "execute",
    chain_id: null,
    result_path: null,
    retry_count: 0,
    fail_reason: null,
    created_by: null,
    created_by_name: "",
    assigned_to: null,
    assigned_to_name: null,
    claimed_by: null,
    completed_by_name: null,
    created_at: "2026-05-25T00:00:00Z",
    claimed_at: null,
    completed_at: null,
    duration_seconds: null,
    leader_only: false,
    result: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: asMessageId("msg-1"),
    type: "direct",
    from_instance: LEADER,
    from_name: "Leader",
    from_role: "leader",
    to_instance: SELF,
    to_name: "Self",
    content: "go",
    link: "execute",
    chain_id: null,
    task_id: asTaskId("task-1"),
    task_title: "do",
    task_description: "do it",
    task_criteria: null,
    result_path: null,
    original_requirement_path: null,
    reply_to: null,
    read: false,
    created_at: "2026-05-25T00:00:00Z",
    ...overrides,
  };
}

function makeWatcher(opts: {
  router: StubMessageRouter;
  registry: StubRegistry;
  task_queue: StubTaskQueue;
}): WorkerWatcher {
  return new WorkerWatcher({
    instance_id: SELF,
    leader_id: LEADER,
    worker_name: "Self",
    worker_role: "executor",
    worktree_path: "/tmp/wt-never",
    worktree_branch: "br",
    registry: opts.registry,
    message_router: opts.router,
    task_queue: opts.task_queue,
    runner: NEVER_RUNNER,
    template_engine: NEVER_TEMPLATE,
    hooks: NEVER_HOOKS,
    evaluator: NEVER_EVALUATOR,
    commit_checker: NEVER_COMMIT_CHECKER,
    docs_committer: NEVER_DOCS_COMMITTER,
    cache_paths: CACHE_PATHS,
    identity_system_prompt: "",
    logger: new CapturingLogger(),
    git_remote: null,
    magic_mode: false,
  });
}

async function flushPromises(): Promise<void> {
  // processMessage runs via void this.processMessage(msg) inside the
  // waitForMessage callback; drain microtasks before asserting.
  await new Promise((r) => setTimeout(r, 10));
}

describe("WorkerWatcher dispatch — assigned_to !== self", () => {
  it("dismisses the dispatch message and does NOT enter the 8-step pipeline", async () => {
    const router = new StubMessageRouter();
    const registry = new StubRegistry();
    const queue = new StubTaskQueue();
    const watcher = makeWatcher({ router, registry, task_queue: queue });

    // The pending task is pinned to OTHER, not us.
    queue.setPending(
      makeTask({ id: asTaskId("task-1"), assigned_to: OTHER }),
    );

    await watcher.start();
    router.deliver(makeMessage({ id: asMessageId("disp-1") }));
    await flushPromises();

    // dispatch dismissed the message — NEVER_* stubs were not reached.
    expect(router.dismissed).toEqual(["disp-1"]);
    watcher.stop();
  });
});

describe("WorkerWatcher dispatch — inFlight dedup", () => {
  it("the same message id delivered twice runs processMessage exactly once", async () => {
    const router = new StubMessageRouter();
    const registry = new StubRegistry();
    const queue = new StubTaskQueue();
    const watcher = makeWatcher({ router, registry, task_queue: queue });

    queue.setPending(makeTask({ assigned_to: OTHER }));

    await watcher.start();
    const msg = makeMessage({ id: asMessageId("dup-1") });
    router.deliver(msg);
    router.deliver(msg); // second delivery — should be deduped.
    await flushPromises();

    // dismiss called once (one processMessage execution), not twice.
    expect(router.dismissed).toEqual(["dup-1"]);
    watcher.stop();
  });
});

describe("WorkerWatcher dispatch — heartbeat busy/idle ordering", () => {
  it("processMessage calls heartbeat(busy) then heartbeat(idle) around the dispatch", async () => {
    const router = new StubMessageRouter();
    const registry = new StubRegistry();
    const queue = new StubTaskQueue();
    const watcher = makeWatcher({ router, registry, task_queue: queue });

    queue.setPending(makeTask({ assigned_to: OTHER })); // forces early dismiss

    await watcher.start();
    router.deliver(makeMessage({ id: asMessageId("hb-1") }));
    await flushPromises();

    expect(registry.heartbeats).toHaveLength(2);
    expect(registry.heartbeats[0].status).toBe("busy");
    expect(registry.heartbeats[0].current_task_id).toBe(asTaskId("task-1"));
    expect(registry.heartbeats[1].status).toBe("idle");
    expect(registry.heartbeats[1].current_task_id).toBeNull();
    watcher.stop();
  });
});

describe("WorkerWatcher dispatch — heartbeat failure absorption", () => {
  it("processMessage continues even when registry.heartbeat rejects", async () => {
    const router = new StubMessageRouter();
    const registry = new StubRegistry();
    const queue = new StubTaskQueue();
    const watcher = makeWatcher({ router, registry, task_queue: queue });

    registry.rejectHeartbeat = true;
    queue.setPending(makeTask({ assigned_to: OTHER }));

    await watcher.start();
    router.deliver(makeMessage({ id: asMessageId("hb-fail") }));
    await flushPromises();

    // Despite both heartbeats rejecting, the dispatch still dismissed.
    expect(router.dismissed).toEqual(["hb-fail"]);
    expect(registry.heartbeats).toHaveLength(2);
    watcher.stop();
  });
});

describe("WorkerWatcher dispatch — stop()", () => {
  it("messages delivered after stop() do not trigger processMessage", async () => {
    const router = new StubMessageRouter();
    const registry = new StubRegistry();
    const queue = new StubTaskQueue();
    const watcher = makeWatcher({ router, registry, task_queue: queue });

    queue.setPending(makeTask({ assigned_to: OTHER }));

    await watcher.start();
    watcher.stop();
    router.deliver(makeMessage({ id: asMessageId("post-stop") }));
    await flushPromises();

    // No dismiss, no heartbeats — the start() callback exited at the
    // stopped check before adding to inFlight or invoking processMessage.
    expect(router.dismissed).toEqual([]);
    expect(registry.heartbeats).toEqual([]);
  });
});
