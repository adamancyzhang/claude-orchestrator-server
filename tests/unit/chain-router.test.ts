import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChainRouter } from "../../src/leader/chain-router.js";
import type { Message } from "../../src/models/schemas.js";

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-001",
    type: "direct",
    from_instance: "worker1",
    from_name: "TestWorker",
    from_role: "builder",
    to_instance: "leader1",
    to_name: null,
    content: "test content",
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

function makeMockZk() {
  return {
    listInstances: vi.fn().mockResolvedValue([]),
    createMessage: vi.fn().mockResolvedValue("msg-new"),
    getMessage: vi.fn(),
  } as unknown as {
    listInstances: ReturnType<typeof vi.fn>;
    createMessage: ReturnType<typeof vi.fn>;
    getMessage: ReturnType<typeof vi.fn>;
  };
}

function makeMockTaskQueue() {
  return {
    push: vi.fn().mockResolvedValue({ id: "task-001", title: "test", link: "build" }),
  } as unknown as {
    push: ReturnType<typeof vi.fn>;
  };
}

function makeMockMessageRouter() {
  return {
    send: vi.fn().mockResolvedValue([{ id: "msg-001", to_instance: "worker1" }]),
  } as unknown as {
    send: ReturnType<typeof vi.fn>;
  };
}

function makeMockEventBus() {
  return {
    emit: vi.fn(),
    onAll: vi.fn(),
    on: vi.fn(),
  } as unknown as {
    emit: ReturnType<typeof vi.fn>;
    onAll: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
}

function makeMockRunner() {
  return {
    taskDocPath: vi.fn().mockImplementation((id: string) => `/tmp/cache/tasks/${id}.md`),
    ensureDir: vi.fn(),
    run: vi.fn().mockResolvedValue({ code: 0 }),
    resultPath: vi.fn().mockImplementation((key: string) => `/tmp/cache/results/${key}-result.md`),
    logPath: vi.fn().mockImplementation((key: string) => `/tmp/cache/logs/${key}.log`),
  } as unknown as {
    taskDocPath: ReturnType<typeof vi.fn>;
    ensureDir: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    resultPath: ReturnType<typeof vi.fn>;
    logPath: ReturnType<typeof vi.fn>;
  };
}

function makeMockTemplateEngine() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    loadAll: vi.fn().mockResolvedValue(undefined),
    render: vi.fn().mockReturnValue("rendered prompt"),
    loadFile: vi.fn(),
  } as unknown as {
    get: ReturnType<typeof vi.fn>;
    loadAll: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
  };
}

describe("ChainRouter", () => {
  let zk: ReturnType<typeof makeMockZk>;
  let taskQueue: ReturnType<typeof makeMockTaskQueue>;
  let messageRouter: ReturnType<typeof makeMockMessageRouter>;
  let eventBus: ReturnType<typeof makeMockEventBus>;
  let runner: ReturnType<typeof makeMockRunner>;
  let templateEngine: ReturnType<typeof makeMockTemplateEngine>;
  let router: ChainRouter;

  beforeEach(() => {
    zk = makeMockZk();
    taskQueue = makeMockTaskQueue();
    messageRouter = makeMockMessageRouter();
    eventBus = makeMockEventBus();
    runner = makeMockRunner();
    templateEngine = makeMockTemplateEngine();
    router = new ChainRouter(
      zk as any, taskQueue as any, messageRouter as any, eventBus as any,
      "leader1", "Leader", runner as any, templateEngine as any,
    );
  });

  describe("handleRequirement (no link)", () => {
    it("forwards requirement to an idle planner worker", async () => {
      zk.listInstances.mockResolvedValue([
        { id: "planner1", name: "Alice", role: "planner", status: "idle" },
      ]);

      const msg = makeMsg({ link: null, content: "Build a login page" });
      await router.route(msg);

      expect(zk.createMessage).toHaveBeenCalledWith(
        "planner1",
        expect.objectContaining({ content: "Build a login page" }),
      );
      const call = zk.createMessage.mock.calls[0];
      const messageData = call[1];
      expect(messageData.link).toBe("decompose");
    });

    it("logs error when no planner worker is available", async () => {
      zk.listInstances.mockResolvedValue([
        { id: "worker1", name: "Bob", role: "builder", status: "idle" },
      ]);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const msg = makeMsg({ link: null, content: "Build a login page" });
      await router.route(msg);

      expect(zk.createMessage).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No planner worker available"),
      );
      consoleSpy.mockRestore();
    });

    it("skips busy planner workers", async () => {
      zk.listInstances.mockResolvedValue([
        { id: "planner1", name: "Alice", role: "planner", status: "busy" },
        { id: "planner2", name: "Charlie", role: "planner", status: "idle" },
      ]);

      const msg = makeMsg({ link: null, content: "Build a login page" });
      await router.route(msg);

      expect(zk.createMessage).toHaveBeenCalledWith(
        "planner2",
        expect.objectContaining({ content: "Build a login page" }),
      );
    });
  });

  describe("handleTaskDefinitions (link=task_defs)", () => {
    it("parses ChainDef JSON and pushes tasks", async () => {
      const chainDef = {
        chain_id: "chain-1",
        chain_title: "Test Chain",
        tasks: {
          plan: null,
          build: { title: "Build X", description: "Build it", criteria: "Done", priority: 1 },
          verify: { title: "Verify X", description: "Verify it", criteria: "Passes", priority: 1 },
          review: { title: "Review X", description: "Review it", criteria: "Approved", priority: 1 },
          accept: { title: "Accept X", description: "Accept it", criteria: "Signed off", priority: 1 },
        },
      };

      const msg = makeMsg({ link: "task_defs", content: JSON.stringify(chainDef) });
      await router.route(msg);

      expect(taskQueue.push).toHaveBeenCalledTimes(4);
      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "chain_activated", chainId: "chain-1" }),
      );
    });

    it("includes optional plan task when present", async () => {
      const chainDef = {
        chain_id: "chain-2",
        chain_title: "Full Chain",
        tasks: {
          plan: { title: "Plan Y", description: "Plan it", criteria: "Blueprint done", priority: 0 },
          build: { title: "Build Y", description: "Build it", criteria: "Done", priority: 1 },
          verify: { title: "Verify Y", description: "Verify it", criteria: "Passes", priority: 1 },
          review: { title: "Review Y", description: "Review it", criteria: "Approved", priority: 1 },
          accept: { title: "Accept Y", description: "Accept it", criteria: "Signed", priority: 1 },
        },
      };

      const msg = makeMsg({ link: "task_defs", content: JSON.stringify(chainDef) });
      await router.route(msg);

      expect(taskQueue.push).toHaveBeenCalledTimes(5);
    });

    it("handles malformed JSON gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const msg = makeMsg({ link: "task_defs", content: "not json" });
      await router.route(msg);

      expect(taskQueue.push).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain("Failed to parse task definitions");
      consoleSpy.mockRestore();
    });
  });

  describe("handleCompletionReport (standard chain link)", () => {
    it("auto-advances to next link on activate_next decision", async () => {
      const evalDecision = {
        decision: "activate_next",
        reason: "Build completed successfully",
        nextLink: "verify",
      };

      const msg = makeMsg({ link: "build", content: JSON.stringify(evalDecision) });
      await router.route(msg);

      expect(taskQueue.push).toHaveBeenCalledWith(
        expect.any(String), "", 1, "leader1", undefined, "Leader", undefined, "verify", null,
      );
      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task_created" }),
      );
    });

    it("sends feedback to worker on feedback decision", async () => {
      const evalDecision = {
        decision: "feedback",
        reason: "Missing edge case handling",
        feedback: "Please add tests for empty input",
      };

      const msg = makeMsg({
        link: "build",
        content: JSON.stringify(evalDecision),
        from_instance: "worker1",
      });
      await router.route(msg);

      expect(messageRouter.send).toHaveBeenCalledWith(
        "leader1", "Leader", "Please add tests for empty input", "worker1",
      );
    });

    it("emits chain_closed on close_chain decision", async () => {
      const evalDecision = {
        decision: "close_chain",
        reason: "Accept completed, all criteria met",
      };

      const msg = makeMsg({ link: "accept", content: JSON.stringify(evalDecision) });
      // Inject chain_id into message metadata
      (msg as any).chain_id = "chain-1";
      await router.route(msg);

      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "chain_closed", chainId: "chain-1" }),
      );
    });

    it("falls back to auto-advance when content is not valid JSON", async () => {
      const msg = makeMsg({ link: "build", content: "Task completed. Leader, please review." });
      await router.route(msg);

      expect(taskQueue.push).toHaveBeenCalledWith(
        expect.any(String), "", 1, "leader1", undefined, "Leader", undefined, "verify", null,
      );
    });

    it("falls back to close_chain for accept link with non-JSON content", async () => {
      const msg = makeMsg({ link: "accept", content: "Acceptance complete." });
      await router.route(msg);

      expect(taskQueue.push).not.toHaveBeenCalled();
    });
  });
});
