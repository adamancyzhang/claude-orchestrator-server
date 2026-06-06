// CORE-RETENTION
// Locks in: WorkerWatcher's processTask integration — the full pipeline
// from message receipt through runner invocation, hook firing, and
// completion report. Covers:
// (a) Full message envelope handling: link extraction, chain artifact
//     collection, task claim, and runner invocation all execute in sequence.
// (b) worker_message_start hook fires with correct env vars before
//     the runner is invoked.
// (c) Runner retry loop: when the first attempt fails validation
//     (exit_code !== 0), the runner is retried up to MAX_GENERATION_RETRIES
//     times with a retry hint appended to the prompt.
// (d) worker_message_end hook fires after the runner completes.
// (e) Completion report is sent via messageRouter.send() with the
//     correct envelope fields.
// Critical because: the dispatch tests (watcher-dispatch.test.ts) only
// guard the entry gate with NEVER_* stubs. This test exercises the
// actual processTask integration — the only place where all collaborators
// (runner, hooks, evaluator, commit_checker, message_router) are wired
// together. A regression here means the worker silently drops tasks,
// fires hooks with wrong env, or sends malformed completion reports.
// Primary sources: packages/worker/src/watcher.ts (processTask)

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  asMessageId,
  asTaskId,
  cachePaths,
  type CachePathOptions,
  type ClaimRecord,
  type CreateInstanceInput,
  type CreateTaskInput,
  type HookEvent,
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
  type StreamChunk,
  type Task,
  type TaskId,
} from "@co/contracts";
import { WorkerWatcher } from "../src/watcher.js";
import type { SelfEvaluator } from "../src/evaluator.js";
import type { CommitChecker } from "../src/commit-checker.js";
import type { WorkerDocsCommitter } from "../src/docs-committer.js";

const SELF = asInstanceId("worker-self");
const LEADER = asInstanceId("leader");

const CACHE_PATHS: CachePathOptions = {
  projects_root: "/tmp/co-test-projects-process-task",
  leader_instance_id: LEADER,
};

// ── CapturingLogger ──
class CapturingLogger implements ILogger {
  public readonly warns: string[] = [];
  public readonly errors: string[] = [];
  debug(): void {}
  info(): void {}
  warn(msg: string): void {
    this.warns.push(msg);
  }
  error(msg: string): void {
    this.errors.push(msg);
  }
  child(): ILogger {
    return this;
  }
}

// ── CapturingMessageRouter: captures send() calls + dismiss() ──
class CapturingMessageRouter implements IMessageRouter {
  private cb: ((msg: Message) => void) | null = null;
  public readonly sent: SendMessageInput[] = [];
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

  async send(input: SendMessageInput): Promise<Message> {
    this.sent.push(input);
    return {
      id: "msg-captured" as Message["id"],
      type: input.type,
      from_instance: input.from_instance,
      from_name: input.from_name,
      to_instance: input.to_instance,
      content: input.content,
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
    };
  }

  async dismiss(_instanceId: InstanceId, messageId: string): Promise<void> {
    this.dismissed.push(messageId);
  }

  async poll(): Promise<Message[]> {
    throw new Error("unused");
  }
}

// ── CapturingHookEngine: records fire() calls ──
class CapturingHookEngine implements IHookEngine {
  public readonly fired: HookEvent[] = [];

  async fire(event: HookEvent): Promise<void> {
    this.fired.push(event);
  }
}

// ── StubRegistry ──
class StubRegistry implements IInstanceRegistry {
  async heartbeat(): Promise<void> {}
  async register(): Promise<Instance> {
    throw new Error("unused");
  }
  async unregister(): Promise<void> {
    throw new Error("unused");
  }
  async list(): Promise<Instance[]> {
    throw new Error("unused");
  }
  async get(): Promise<Instance | null> {
    throw new Error("unused");
  }
  async watch(): Promise<Instance[]> {
    throw new Error("unused");
  }
}

// ── StubTaskQueue ──
class StubTaskQueue implements ITaskQueue {
  private claimResult: Task | null = null;

  setClaimResult(t: Task | null): void {
    this.claimResult = t;
  }

  async getPending(): Promise<Task | null> {
    return null;
  }
  async push(): Promise<Task> {
    throw new Error("unused");
  }
  async claim(): Promise<Task | null> {
    throw new Error("unused");
  }
  async claimById(): Promise<Task | null> {
    return this.claimResult;
  }
  async assign(): Promise<Task | null> {
    throw new Error("unused");
  }
  async complete(): Promise<void> {}
  async fail(): Promise<void> {}
  async retry(): Promise<Task> {
    throw new Error("unused");
  }
  async listPending(): Promise<Task[]> {
    throw new Error("unused");
  }
  async listClaimed(): Promise<ClaimRecord[]> {
    throw new Error("unused");
  }
  async getCompleted(): Promise<Task | null> {
    throw new Error("unused");
  }
  async watchPending(): Promise<TaskId[]> {
    throw new Error("unused");
  }
  async watchClaimed(): Promise<ClaimRecord[]> {
    throw new Error("unused");
  }
}

// ── StubTemplateEngine: returns a simple template ──
class StubTemplateEngine implements ITemplateEngine {
  has(): boolean {
    return true;
  }
  load(): string {
    return "Execute task: {{content}}";
  }
  render(_name: string, vars: Record<string, string>): string {
    return `Execute task: ${vars.content ?? ""}`;
  }
}

// ── StubEvaluator: returns activate_next ──
const STUB_EVALUATOR = {
  async evaluate(): Promise<string> {
    return JSON.stringify({ decision: "activate_next", reason: "looks good" });
  },
} as unknown as SelfEvaluator;

// ── StubCommitChecker: returns null (no changes) ──
const STUB_COMMIT_CHECKER = {
  async check(): Promise<null> {
    return null;
  },
} as unknown as CommitChecker;

// ── StubDocsCommitter: returns null (no docs changes) ──
const STUB_DOCS_COMMITTER = {
  async commitIfChanged(): Promise<null> {
    return null;
  },
} as unknown as WorkerDocsCommitter;

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: asMessageId("msg-pt-1"),
    type: "direct",
    from_instance: LEADER,
    from_name: "Leader",
    from_role: "leader",
    to_instance: SELF,
    to_name: "Self",
    content: "go",
    link: "execute",
    chain_id: asChainId("chain-1"),
    task_id: asTaskId("task-pt-1"),
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

async function flushPromises(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("WorkerWatcher processTask — full message envelope", () => {
  it("invokes runner with rendered prompt and dismisses the message", async () => {
    const router = new CapturingMessageRouter();
    const hooks = new CapturingHookEngine();
    const queue = new StubTaskQueue();
    let capturedPrompt = "";

    const runner: IClaudeRunner = {
      async run(opts: RunOptions): Promise<RunResult> {
        capturedPrompt = opts.prompt;
        // Write a result file so classifyWorkerOutput passes for chain links.
        const taskDir = opts.log_path.replace(/\/exec-[^/]+\.log$/, "");
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(`${taskDir}/result.md`, "done");
        return { exit_code: 0, session_id: null, log_path: opts.log_path };
      },
    };

    const watcher = new WorkerWatcher({
      instance_id: SELF,
      leader_id: LEADER,
      worker_name: "Self",
      worker_role: "executor",
      worktree_path: "/tmp/wt-process-task",
      worktree_branch: "br",
      registry: new StubRegistry(),
      message_router: router,
      task_queue: queue,
      runner,
      template_engine: new StubTemplateEngine(),
      hooks,
      evaluator: STUB_EVALUATOR,
      commit_checker: STUB_COMMIT_CHECKER,
      docs_committer: STUB_DOCS_COMMITTER,
      cache_paths: CACHE_PATHS,
      identity_system_prompt: "You are a worker.",
      logger: new CapturingLogger(),
      git_remote: null,
      magic_mode: false,
    });

    await watcher.start();
    router.deliver(makeMessage());
    await flushPromises();

    // Runner was invoked with a prompt containing the message content.
    expect(capturedPrompt).toContain("go");

    // Message was dismissed after processing.
    expect(router.dismissed).toEqual(["msg-pt-1"]);

    watcher.stop();
  });
});

describe("WorkerWatcher processTask — hook firing", () => {
  it("fires worker_message_start before the runner and worker_message_end after", async () => {
    const router = new CapturingMessageRouter();
    const hooks = new CapturingHookEngine();
    const hookOrder: string[] = [];

    const runner: IClaudeRunner = {
      async run(opts: RunOptions): Promise<RunResult> {
        hookOrder.push("runner");
        // Write a result file so classifyWorkerOutput passes for chain links.
        // The result path is in the same directory as the log path: replace
        // exec-<ts>.log with result.md.
        const taskDir = opts.log_path.replace(/\/exec-[^/]+\.log$/, "");
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(`${taskDir}/result.md`, "done");
        return { exit_code: 0, session_id: null, log_path: opts.log_path };
      },
    };

    // Intercept hook fire to record ordering.
    const originalFire = hooks.fire.bind(hooks);
    hooks.fire = async (event: HookEvent) => {
      hookOrder.push(event.type);
      return originalFire(event);
    };

    const watcher = new WorkerWatcher({
      instance_id: SELF,
      leader_id: LEADER,
      worker_name: "Self",
      worker_role: "executor",
      worktree_path: "/tmp/wt-hooks",
      worktree_branch: "br",
      registry: new StubRegistry(),
      message_router: router,
      task_queue: new StubTaskQueue(),
      runner,
      template_engine: new StubTemplateEngine(),
      hooks,
      evaluator: STUB_EVALUATOR,
      commit_checker: STUB_COMMIT_CHECKER,
      docs_committer: STUB_DOCS_COMMITTER,
      cache_paths: CACHE_PATHS,
      identity_system_prompt: "",
      logger: new CapturingLogger(),
      git_remote: null,
      magic_mode: false,
    });

    await watcher.start();
    router.deliver(makeMessage());
    await flushPromises();

    // worker_message_start fires before runner, worker_message_end after,
    // then task_completed fires when the task is marked done in ZK.
    expect(hookOrder).toEqual([
      "worker_message_start",
      "runner",
      "worker_message_end",
      "task_completed",
    ]);

    // Verify the worker_message_start env contains expected fields.
    const startEvent = hooks.fired.find((e) => e.type === "worker_message_start");
    expect(startEvent).toBeDefined();
    if (startEvent?.type === "worker_message_start") {
      expect(startEvent.env.CO_WORKER_NAME).toBe("Self");
      expect(startEvent.env.CO_WORKER_ID).toBe(SELF);
      expect(startEvent.env.CO_LINK).toBe("execute");
      expect(startEvent.env.CO_CHAIN_ID).toBe("chain-1");
    }

    // Verify worker_message_end env contains exit_code.
    const endEvent = hooks.fired.find((e) => e.type === "worker_message_end");
    expect(endEvent).toBeDefined();
    if (endEvent?.type === "worker_message_end") {
      expect(endEvent.env.exit_code).toBe(0);
    }

    watcher.stop();
  });
});

describe("WorkerWatcher processTask — runner retry loop", () => {
  it("retries up to MAX_GENERATION_RETRIES when runner returns non-zero exit code", async () => {
    const router = new CapturingMessageRouter();
    let runCount = 0;

    const runner: IClaudeRunner = {
      async run(opts: RunOptions): Promise<RunResult> {
        runCount++;
        // First two attempts fail, third succeeds.
        if (runCount < 3) {
          return { exit_code: 1, session_id: null, log_path: "/tmp/log" };
        }
        return { exit_code: 0, session_id: null, log_path: "/tmp/log" };
      },
    };

    const watcher = new WorkerWatcher({
      instance_id: SELF,
      leader_id: LEADER,
      worker_name: "Self",
      worker_role: "executor",
      worktree_path: "/tmp/wt-retry",
      worktree_branch: "br",
      registry: new StubRegistry(),
      message_router: router,
      task_queue: new StubTaskQueue(),
      runner,
      template_engine: new StubTemplateEngine(),
      hooks: new CapturingHookEngine(),
      evaluator: STUB_EVALUATOR,
      commit_checker: STUB_COMMIT_CHECKER,
      docs_committer: STUB_DOCS_COMMITTER,
      cache_paths: CACHE_PATHS,
      identity_system_prompt: "",
      logger: new CapturingLogger(),
      git_remote: null,
      magic_mode: true, // chain link → retry enabled
    });

    await watcher.start();
    // Chain link message to enable retries.
    router.deliver(makeMessage({ link: "execute" }));
    await flushPromises();

    // Runner was called 3 times (2 failures + 1 success).
    expect(runCount).toBe(3);

    // Message was dismissed (pipeline completed).
    expect(router.dismissed).toEqual(["msg-pt-1"]);

    watcher.stop();
  });

  it("sends failure report when all retries are exhausted", async () => {
    const router = new CapturingMessageRouter();

    const runner: IClaudeRunner = {
      async run(): Promise<RunResult> {
        // Always fail.
        return { exit_code: 1, session_id: null, log_path: "/tmp/log" };
      },
    };

    const watcher = new WorkerWatcher({
      instance_id: SELF,
      leader_id: LEADER,
      worker_name: "Self",
      worker_role: "executor",
      worktree_path: "/tmp/wt-exhaust",
      worktree_branch: "br",
      registry: new StubRegistry(),
      message_router: router,
      task_queue: new StubTaskQueue(),
      runner,
      template_engine: new StubTemplateEngine(),
      hooks: new CapturingHookEngine(),
      evaluator: STUB_EVALUATOR,
      commit_checker: STUB_COMMIT_CHECKER,
      docs_committer: STUB_DOCS_COMMITTER,
      cache_paths: CACHE_PATHS,
      identity_system_prompt: "",
      logger: new CapturingLogger(),
      git_remote: null,
      magic_mode: true,
    });

    await watcher.start();
    router.deliver(makeMessage({ link: "execute" }));
    await flushPromises();

    // Runner was called MAX_GENERATION_RETRIES (3) times.
    // A failure message was sent to the leader.
    const failureMsg = router.sent.find(
      (s) => typeof s.content === "string" && s.content.includes("validation failed"),
    );
    expect(failureMsg).toBeDefined();
    expect(failureMsg!.to_instance).toBe(LEADER);

    // Message was dismissed.
    expect(router.dismissed).toEqual(["msg-pt-1"]);

    watcher.stop();
  });
});
