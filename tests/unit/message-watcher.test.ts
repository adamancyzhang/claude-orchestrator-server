import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mockSpawn }));

import { WorkerWatcher } from "../../src/worker/watcher.js";

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
    ...overrides,
  };
}

function makeMockZkClient() {
  return {
    mkdirp: vi.fn().mockResolvedValue(undefined),
    watchMessageDir: vi.fn(),
    getMessage: vi.fn(),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("WorkerWatcher", () => {
  let watcher: WorkerWatcher;
  let zk: ReturnType<typeof makeMockZkClient>;

  beforeEach(() => {
    zk = makeMockZkClient();
    watcher = new WorkerWatcher(zk, "worker-inst-1", "/test/workdir", "claude", "~/.cache/test", "leader-1");
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

    it("processes unread messages via execWithTee", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, _onChange: unknown) => Promise.resolve(["msg-1"])
      );
      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child);

      await watcher.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSpawn).toHaveBeenCalled();
      const callArgs = mockSpawn.mock.calls[0];
      expect(callArgs[0]).toBe("sh");
      expect(callArgs[1][1]).toContain("tee");

      child.emit("exit", 0);
    });

    it("marks message as read after processing", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, _onChange: unknown) => Promise.resolve(["msg-1"])
      );
      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child);

      await watcher.start();
      await new Promise((r) => setTimeout(r, 50));

      child.emit("exit", 0);
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

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child);

      await watcher.start();
      await new Promise((r) => setTimeout(r, 50));

      child.emit("exit", 1);
      await new Promise((r) => setTimeout(r, 50));

      expect(zk.updateMessage).toHaveBeenCalledWith(
        "worker-inst-1",
        "msg-1",
        expect.objectContaining({ read: true })
      );
    });

    it("handles spawn error gracefully", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, _onChange: unknown) => Promise.resolve(["msg-1"])
      );
      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child);

      await watcher.start();
      await new Promise((r) => setTimeout(r, 50));

      child.emit("error", new Error("claude not found"));
      await new Promise((r) => setTimeout(r, 50));

      expect(zk.updateMessage).toHaveBeenCalled();
    });

    it("stops gracefully", () => {
      expect(() => watcher.stop()).not.toThrow();
      expect(watcher.stopped).toBe(true);
    });
  });
});
