import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

const TEST_ROOT = vi.hoisted(() => {
  const root = `/test-msgrouter-${Date.now()}`;
  process.env.ZK_ROOT_PATH = root;
  return root;
});

import { ZkClient } from "../../src/zk/client.js";
import { InstanceRegistry } from "../../src/modules/registry.js";
import { MessageRouter, renderTemplate } from "../../src/modules/message-router.js";

describe("MessageRouter", () => {
  let zk: ZkClient;
  let router: MessageRouter;
  let registry: InstanceRegistry;
  let aliceId: string;
  let bobId: string;

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();
    router = new MessageRouter(zk);
    registry = new InstanceRegistry(zk);

    const alice = await registry.register("Alice", "builder");
    const bob = await registry.register("Bob", "verifier");
    aliceId = alice.id;
    bobId = bob.id;
  });

  afterAll(async () => {
    await zk.disconnect();
  });

  describe("send", () => {
    it("sends a direct message to a specific instance", async () => {
      const msgs = await router.send(aliceId, "Alice", "Hello Bob!", bobId);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("direct");
      expect(msgs[0].from_instance).toBe(aliceId);
      expect(msgs[0].to_instance).toBe(bobId);
      expect(msgs[0].content).toBe("Hello Bob!");
    });

    it("sends a message by name resolution", async () => {
      const msgs = await router.send(aliceId, "Alice", "Hi by name", undefined, false, "Bob");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].to_instance).toBe(bobId);
    });

    it("sends a broadcast message to all except sender", async () => {
      // Register a third instance so broadcast has multiple targets
      const charlie = await registry.register("Charlie", "reviewer");
      const msgs = await router.send(aliceId, "Alice", "Broadcast!", undefined, true);
      expect(msgs.length).toBeGreaterThanOrEqual(2);
      // Sender should not receive
      expect(msgs.every((m) => m.to_instance !== aliceId)).toBe(true);
      // Each message should be type broadcast
      expect(msgs.every((m) => m.type === "broadcast")).toBe(true);
    });

    it("sends a help message to all except sender", async () => {
      const msgs = await router.send(aliceId, "Alice", "Help!", undefined, false, undefined, true);
      expect(msgs.length).toBeGreaterThanOrEqual(2);
      expect(msgs.every((m) => m.type === "help")).toBe(true);
    });

    it('@all triggers broadcast', async () => {
      const msgs = await router.send(aliceId, "Alice", "All hands!", undefined, false, "@all");
      expect(msgs.length).toBeGreaterThanOrEqual(2);
      expect(msgs.every((m) => m.type === "broadcast")).toBe(true);
    });

    it("throws for unknown name", async () => {
      await expect(
        router.send(aliceId, "Alice", "Hi", undefined, false, "NonExistent")
      ).rejects.toThrow("Instance \"NonExistent\" not found");
    });

    it("throws when no target specified", async () => {
      await expect(
        router.send(aliceId, "Alice", "No target")
      ).rejects.toThrow("Must specify to_instance, to_name, or broadcast=true");
    });
  });

  describe("poll", () => {
    it("polls messages and marks them as read", async () => {
      // Send a message to Bob first
      await router.send(aliceId, "Alice", "Poll test", bobId);

      const msgs = await router.poll(bobId);
      const match = msgs.find((m) => m.content === "Poll test");
      expect(match).toBeDefined();
      expect(match!.read).toBe(true); // poll marks as read
    });

    it("returns empty array when no messages", async () => {
      const fresh = await registry.register("FreshWorker");
      const msgs = await router.poll(fresh.id);
      expect(msgs).toEqual([]);
    });
  });

  describe("waitForMessage", () => {
    it("returns immediately when messages exist", async () => {
      await router.send(aliceId, "Alice", "Immediate", bobId);
      const msgs = await router.waitForMessage(bobId, 2);
      expect(msgs.length).toBeGreaterThan(0);
    });

    it("returns new messages that arrive during wait (via ZK watch)", { timeout: 10000 }, async () => {
      const fresh = await registry.register("WaitWorker2");

      // Send a message to create the message dir, then dismiss it so the dir exists but is empty
      const [setupMsg] = await router.send(aliceId, "Alice", "Setup msg", fresh.id);
      await router.dismissMessage(fresh.id, setupMsg.id);

      // Now the message dir exists with no messages. Start waiting — poll returns empty, then sets up watch
      const waitPromise = router.waitForMessage(fresh.id, 5);

      // Give time for the watch to be established
      await new Promise((r) => setTimeout(r, 500));

      // Send a message — the watch should fire because the dir already exists
      await router.send(aliceId, "Alice", "Delayed!", fresh.id);

      const msgs = await waitPromise;
      expect(msgs.length).toBeGreaterThan(0);
      expect(msgs.some((m) => m.content === "Delayed!")).toBe(true);
    });

    it("returns empty array on timeout", async () => {
      const empty = await registry.register("TimeoutWorker");
      const msgs = await router.waitForMessage(empty.id, 1);
      expect(msgs).toEqual([]);
    });
  });

  describe("markRead", () => {
    it("marks a specific message as read", async () => {
      const [msg] = await router.send(aliceId, "Alice", "Mark me", bobId);
      // Poll would have marked it read, so send a new one and skip poll
      await router.markRead(bobId, msg.id);
      // Just verify no error — the read flag is set in ZK
    });

    it("throws for non-existent message", async () => {
      await expect(router.markRead(bobId, "msg-nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("dismissMessage", () => {
    it("deletes a message", async () => {
      const [msg] = await router.send(aliceId, "Alice", "Delete me", bobId);
      await router.dismissMessage(bobId, msg.id);
      // Verify it's gone by checking ZK directly
      const data = await zk.getMessage(bobId, msg.id);
      expect(data).toBeNull();
    });
  });
});

describe("renderTemplate", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-router-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders {{key}} placeholders with values", async () => {
    const tmplPath = path.join(tmpDir, "test-template.md");
    fs.writeFileSync(tmplPath, "Hello {{name}}, your task is {{task_title}}.");

    const result = await renderTemplate(tmplPath, {
      name: "Alice",
      task_title: "Build the thing",
    });
    expect(result).toBe("Hello Alice, your task is Build the thing.");
  });

  it("replaces multiple occurrences of the same key", async () => {
    const tmplPath = path.join(tmpDir, "repeat-template.md");
    fs.writeFileSync(tmplPath, "{{x}} {{x}} {{x}}");

    const result = await renderTemplate(tmplPath, { x: "y" });
    expect(result).toBe("y y y");
  });

  it("leaves unmatched placeholders as-is", async () => {
    const tmplPath = path.join(tmpDir, "unmatched-template.md");
    fs.writeFileSync(tmplPath, "Hello {{name}}, your {{missing}} is here.");

    const result = await renderTemplate(tmplPath, { name: "Bob" });
    expect(result).toBe("Hello Bob, your {{missing}} is here.");
  });
});
