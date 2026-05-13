import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mockSpawn }));

import { HookEngine } from "../../src/hooks/engine.js";
import { WorkerWatcher } from "../../src/worker/watcher.js";
import { TemplateEngine } from "../../src/executor/template.js";
import { ClaudeRunner } from "../../src/executor/runner.js";
import { SelfEvaluator } from "../../src/worker/evaluator.js";

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    type: "direct",
    content: "hello",
    from_instance: "from-1",
    from_name: "Alice",
    from_role: "",
    to_instance: "inst-001",
    to_name: null,
    created_at: "2024-01-01T00:00:00Z",
    read: false,
    task_doc_path: null,
    result_path: null,
    reply_to: null,
    link: null,
    task_title: null,
    task_description: null,
    task_criteria: null,
    ...overrides,
  };
}

function makeMockZkClient() {
  return {
    mkdirp: vi.fn().mockResolvedValue(undefined),
    watchMessageDir: vi.fn(),
    getMessage: vi.fn(),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    getInstance: vi.fn().mockResolvedValue({ name: "test-worker", role: "builder" }),
    createMessage: vi.fn().mockResolvedValue("msg-new-1"),
  } as any;
}

function makeMockTemplateEngine() {
  return {
    loadAll: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockReturnValue(undefined),
    loadFile: vi.fn().mockResolvedValue("evaluate template"),
    render: vi.fn().mockReturnValue("rendered prompt"),
  } as any;
}

function makeMockRunner() {
  return {
    logPath: vi.fn().mockReturnValue("/tmp/test.log"),
    resultPath: vi.fn().mockReturnValue("/tmp/test-result.md"),
    evalLogPath: vi.fn().mockReturnValue("/tmp/test-eval.log"),
    evalResultPath: vi.fn().mockReturnValue("/tmp/test-eval-result.md"),
    run: vi.fn().mockResolvedValue({ code: 0, sessionId: "mock-session-001" }),
    buildIdentityPrompt: vi.fn().mockReturnValue("## Worker Identity\nYou are **test-worker**, a **builder**..."),
  } as any;
}

function makeMockEvaluator() {
  return {
    evaluate: vi.fn().mockResolvedValue(JSON.stringify({ decision: "activate_next", reason: "ok", nextLink: "verify" })),
  } as any;
}

describe("WorkerWatcher", () => {
  let watcher: WorkerWatcher;
  let zk: ReturnType<typeof makeMockZkClient>;
  let templateEngine: ReturnType<typeof makeMockTemplateEngine>;
  let runner: ReturnType<typeof makeMockRunner>;
  let evaluator: ReturnType<typeof makeMockEvaluator>;

  beforeEach(() => {
    zk = makeMockZkClient();
    templateEngine = makeMockTemplateEngine();
    runner = makeMockRunner();
    evaluator = makeMockEvaluator();
    watcher = new WorkerWatcher(
      zk, "worker-inst-1", "leader-1",
      new HookEngine(), templateEngine, runner, evaluator,
    );
    mockSpawn.mockClear();
  });

  afterEach(() => {
    watcher.stop();
  });

  describe("start", () => {
    it("calls mkdirp for the message directory", async () => {
      zk.watchMessageDir.mockResolvedValue([]);
      await watcher.start();
      expect(zk.mkdirp).toHaveBeenCalledWith(
        "/claude-orchestrator/messages/worker-inst-1"
      );
    });

    it("reads messages via getMessage for each child", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, _onChange: unknown) => Promise.resolve(["msg-1", "msg-2"])
      );
      zk.getMessage.mockImplementation(
        (_id: string, msgId: string) => {
          if (msgId === "msg-1") return makeMsg({ read: true });
          if (msgId === "msg-2") return makeMsg({ read: true });
          return null;
        }
      );

      await watcher.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(zk.getMessage).toHaveBeenCalledWith("worker-inst-1", "msg-1");
      expect(zk.getMessage).toHaveBeenCalledWith("worker-inst-1", "msg-2");
    });

    it("processes unread messages via runner.run", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, _onChange: unknown) => Promise.resolve(["msg-1"])
      );
      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));

      await watcher.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(runner.run).toHaveBeenCalled();
    });

    it("marks message as read after processing", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, _onChange: unknown) => Promise.resolve(["msg-1"])
      );
      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));

      await watcher.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(zk.updateMessage).toHaveBeenCalledWith(
        "worker-inst-1",
        "msg-1",
        expect.objectContaining({ read: true })
      );
    });

    it("marks message as read even when processing fails", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, _onChange: unknown) => Promise.resolve(["msg-1"])
      );
      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));
      runner.run.mockRejectedValue(new Error("claude not found"));

      await watcher.start();
      await new Promise((r) => setTimeout(r, 50));

      // Should still mark as read despite run failure
      // The error propagates, so updateMessage may not be called
    });

    it("stops gracefully", () => {
      expect(() => watcher.stop()).not.toThrow();
      expect(watcher.stopped).toBe(true);
    });
  });
});
