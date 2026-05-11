import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mockSpawn }));

import { MessageWatcher } from "../../src/modules/message-watcher.js";

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
    to_instance: "inst-001",
    created_at: "2024-01-01T00:00:00Z",
    read: false,
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

describe("MessageWatcher", () => {
  let watcher: MessageWatcher;
  let zk: ReturnType<typeof makeMockZkClient>;

  beforeEach(() => {
    zk = makeMockZkClient();
    watcher = new MessageWatcher(zk);
    mockSpawn.mockClear();
  });

  afterEach(() => {
    watcher.stopAll();
  });

  describe("startWatching", () => {
    it("calls mkdirp for the message directory", async () => {
      zk.watchMessageDir.mockResolvedValue([]);

      await watcher.startWatching("inst-001", "/test/dir");

      expect(zk.mkdirp).toHaveBeenCalledWith(
        "/claude-orchestrator/messages/inst-001"
      );
    });

    it("stops existing watcher before starting new one", async () => {
      zk.watchMessageDir.mockResolvedValue([]);
      await watcher.startWatching("inst-001", "/test/dir1");
      await watcher.startWatching("inst-001", "/test/dir2");

      expect(zk.mkdirp).toHaveBeenCalledTimes(2);
    });
  });

  describe("stopWatching", () => {
    it("is idempotent for unknown instance", () => {
      expect(() => watcher.stopWatching("nonexistent")).not.toThrow();
    });
  });

  describe("stopAll", () => {
    it("stops all watchers without throwing", async () => {
      zk.watchMessageDir.mockResolvedValue([]);
      await watcher.startWatching("a", "/a");
      await watcher.startWatching("b", "/b");
      watcher.stopAll();
    });
  });

  describe("message handling", () => {
    it("reads messages via getMessage for each child", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, _onChange: unknown) => {
          return Promise.resolve(["msg-1", "msg-2"]);
        }
      );

      zk.getMessage.mockImplementation(
        (_id: string, msgId: string) => {
          if (msgId === "msg-1") return makeMsg({ read: true });
          if (msgId === "msg-2") return makeMsg({ read: true });
          return null;
        }
      );

      await watcher.startWatching("inst-001", "/test/dir");

      // Both messages are read, so no spawning. Verify both were read from ZK.
      expect(zk.getMessage).toHaveBeenCalledWith("inst-001", "msg-1");
      expect(zk.getMessage).toHaveBeenCalledWith("inst-001", "msg-2");
    });

    it("spawns claude -p for an unread message", async () => {
      let watchCb: ((children: string[]) => void) | null = null;
      zk.watchMessageDir.mockImplementation(
        (_id: string, onChange: (children: string[]) => void) => {
          watchCb = onChange;
          return Promise.resolve(["msg-1"]);
        }
      );

      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child);

      await watcher.startWatching("inst-001", "/test/dir");

      // Wait a tick for async processing
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        ["--session-id", "inst-001", "-p", "[direct from Alice] hello"],
        expect.objectContaining({ cwd: "/test/dir" })
      );

      // Simulate successful exit
      child.emit("exit", 0, null);
    });

    it("marks message as read after claude exits", async () => {
      let watchCb: ((children: string[]) => void) | null = null;
      zk.watchMessageDir.mockImplementation(
        (_id: string, onChange: (children: string[]) => void) => {
          watchCb = onChange;
          return Promise.resolve(["msg-1"]);
        }
      );

      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child);

      await watcher.startWatching("inst-001", "/test/dir");
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSpawn).toHaveBeenCalled();

      // Exit the child
      child.emit("exit", 0, null);

      // Wait for async mark-as-read
      await new Promise((r) => setTimeout(r, 50));

      expect(zk.updateMessage).toHaveBeenCalledWith(
        "inst-001",
        "msg-1",
        expect.objectContaining({ read: true })
      );
    });

    it("marks message as read even when claude fails", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, onChange: (children: string[]) => void) => {
          return Promise.resolve(["msg-1"]);
        }
      );

      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child);

      await watcher.startWatching("inst-001", "/test/dir");
      await new Promise((r) => setTimeout(r, 50));

      child.emit("exit", 1, null);

      await new Promise((r) => setTimeout(r, 50));

      expect(zk.updateMessage).toHaveBeenCalledWith(
        "inst-001",
        "msg-1",
        expect.objectContaining({ read: true })
      );
    });

    it("handles spawn error gracefully", async () => {
      zk.watchMessageDir.mockImplementation(
        (_id: string, onChange: (children: string[]) => void) => {
          return Promise.resolve(["msg-1"]);
        }
      );

      zk.getMessage.mockResolvedValue(makeMsg({ read: false }));

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child);

      await watcher.startWatching("inst-001", "/test/dir");
      await new Promise((r) => setTimeout(r, 50));

      child.emit("error", new Error("claude not found"));

      await new Promise((r) => setTimeout(r, 50));

      // Should still mark as read
      expect(zk.updateMessage).toHaveBeenCalled();
    });
  });
});
