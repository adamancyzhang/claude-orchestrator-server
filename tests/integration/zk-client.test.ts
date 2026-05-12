import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

const TEST_ROOT = vi.hoisted(() => {
  const root = `/test-zk-client-${Date.now()}`;
  process.env.ZK_ROOT_PATH = root;
  return root;
});

// Import after vi.hoisted sets ZK_ROOT_PATH so paths.ts sees the test root
import { ZkClient, isNoNode, isNodeExists } from "../../src/zk/client.js";

describe("ZkClient", () => {
  let zk: ZkClient;

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();
  });

  afterAll(async () => {
    await zk.disconnect();
  });

  // ── Connection lifecycle ──

  describe("connection lifecycle", () => {
    it("connected returns true after connect", () => {
      expect(zk.connected).toBe(true);
    });

    it("connect is idempotent", async () => {
      const zk2 = new ZkClient(ZK_HOSTS);
      await zk2.connect();
      expect(zk2.connected).toBe(true);
      await zk2.disconnect();
    });
  });

  // ── mkdirp ──

  describe("mkdirp", () => {
    it("creates nested paths", async () => {
      const nested = `${TEST_ROOT}/a/b/c`;
      await zk.mkdirp(nested);
      const children = await zk.getChildren(`${TEST_ROOT}/a/b`);
      expect(children).toContain("c");
    });

    it("is idempotent on existing paths", async () => {
      const p = `${TEST_ROOT}/mkdirp-test`;
      await zk.mkdirp(p);
      await zk.mkdirp(p);
      const exists = await zk.exists(p);
      expect(exists).toBe(true);
    });
  });

  // ── Low-level CRUD ──

  describe("create / getData / setData / remove / exists", () => {
    const testPath = `${TEST_ROOT}/crud-test`;

    it("create and getData", async () => {
      const data = Buffer.from(JSON.stringify({ hello: "world" }));
      await zk.create(testPath, data, 0);
      const result = await zk.getData(testPath);
      expect(result).not.toBeNull();
      expect(JSON.parse(result!.toString())).toEqual({ hello: "world" });
    });

    it("getData returns null for missing node", async () => {
      const result = await zk.getData(`${TEST_ROOT}/nonexistent`);
      expect(result).toBeNull();
    });

    it("setData updates node", async () => {
      const updated = Buffer.from(JSON.stringify({ updated: true }));
      await zk.setData(testPath, updated);
      const result = await zk.getData(testPath);
      expect(JSON.parse(result!.toString())).toEqual({ updated: true });
    });

    it("exists returns true for existing node", async () => {
      const exists = await zk.exists(testPath);
      expect(exists).toBe(true);
    });

    it("exists returns false for missing node", async () => {
      const exists = await zk.exists(`${TEST_ROOT}/nonexistent`);
      expect(exists).toBe(false);
    });

    it("getChildren returns child names", async () => {
      const parent = `${TEST_ROOT}/children-test`;
      await zk.mkdirp(parent);
      await zk.create(`${parent}/child-a`, Buffer.alloc(0), 0);
      await zk.create(`${parent}/child-b`, Buffer.alloc(0), 0);
      const children = await zk.getChildren(parent);
      expect(children).toContain("child-a");
      expect(children).toContain("child-b");
    });

    it("getChildren returns empty array for missing node", async () => {
      const children = await zk.getChildren(`${TEST_ROOT}/nonexistent-parent`);
      expect(children).toEqual([]);
    });

    it("remove deletes node", async () => {
      const p = `${TEST_ROOT}/remove-test`;
      await zk.create(p, Buffer.alloc(0), 0);
      await zk.remove(p);
      const exists = await zk.exists(p);
      expect(exists).toBe(false);
    });

    it("remove is idempotent on missing node", async () => {
      await zk.remove(`${TEST_ROOT}/nonexistent-remove`);
    });
  });

  // ── Error helpers ──

  describe("isNoNode / isNodeExists", () => {
    it("isNoNode returns false for non-ZK errors", () => {
      expect(isNoNode(new Error("generic"))).toBe(false);
      expect(isNoNode(null)).toBe(false);
      expect(isNoNode("string")).toBe(false);
    });

    it("isNodeExists returns false for non-ZK errors", () => {
      expect(isNodeExists(new Error("generic"))).toBe(false);
      expect(isNodeExists(null)).toBe(false);
    });
  });

  // ── Leader operations ──

  describe("leader operations", () => {
    it("createLeader and getLeader", async () => {
      await zk.createLeader({ name: "TestLeader", version: "1.0" });
      const data = await zk.getLeader();
      expect(data).not.toBeNull();
      expect(data!.name).toBe("TestLeader");
    });
  });

  // ── Instance operations ──

  describe("instance operations", () => {
    const instId = "test-inst-001";

    it("registerInstance and getInstance", async () => {
      await zk.registerInstance(instId, { name: "TestWorker", role: "builder" });
      const data = await zk.getInstance(instId);
      expect(data).not.toBeNull();
      expect(data!.name).toBe("TestWorker");
    });

    it("updateInstance modifies data", async () => {
      await zk.updateInstance(instId, { name: "TestWorker", role: "builder", status: "busy" });
      const data = await zk.getInstance(instId);
      expect(data!.status).toBe("busy");
    });

    it("listInstances returns all instances", async () => {
      await zk.registerInstance("test-inst-002", { name: "Worker2" });
      const instances = await zk.listInstances();
      expect(instances.some((i) => i.name === "TestWorker")).toBe(true);
      expect(instances.some((i) => i.name === "Worker2")).toBe(true);
    });

    it("deleteInstance removes instance", async () => {
      await zk.deleteInstance("test-inst-002");
      const data = await zk.getInstance("test-inst-002");
      expect(data).toBeNull();
    });
  });

  // ── Task operations ──

  describe("task operations", () => {
    it("createPendingTask returns sequential ID", async () => {
      const taskId = await zk.createPendingTask({ title: "Task 1" });
      expect(taskId).toMatch(/^task-\d+$/);
      const data = await zk.getPendingTask(taskId);
      expect(data).not.toBeNull();
      expect(data!.title).toBe("Task 1");
    });

    it("listPendingTasks returns sorted tasks", async () => {
      const tasks = await zk.listPendingTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      const ids = tasks.map(([id]) => id);
      expect(ids).toEqual([...ids].sort());
    });

    it("claimTask returns true on success", async () => {
      const taskId = await zk.createPendingTask({ title: "Claimable" });
      const ok = await zk.claimTask("worker-1", taskId, Buffer.from(JSON.stringify({ title: "Claimable" })));
      expect(ok).toBe(true);
      const data = await zk.getClaimedTask("worker-1", taskId);
      expect(data.title).toBe("Claimable");
    });

    it("claimTask returns false on conflicting claim (same instanceId)", async () => {
      const taskId = await zk.createPendingTask({ title: "Conflicting" });
      const data = Buffer.from(JSON.stringify({ title: "Conflicting" }));
      await zk.claimTask("worker-1", taskId, data);
      const ok = await zk.claimTask("worker-1", taskId, data);
      expect(ok).toBe(false);
    });

    it("listClaimedTasks returns parsed instanceId/taskId", async () => {
      const taskId = await zk.createPendingTask({ title: "Claimed task" });
      await zk.claimTask("claimworker1", taskId, Buffer.from(JSON.stringify({ title: "Claimed task" })));
      const claimed = await zk.listClaimedTasks();
      const found = claimed.find(([, tid]) => tid === taskId);
      expect(found).toBeDefined();
      expect(found![0]).toBe("claimworker1");
    });

    it("updateClaimedTask modifies data", async () => {
      const taskId = await zk.createPendingTask({ title: "Updatable" });
      await zk.claimTask("worker-1", taskId);
      await zk.updateClaimedTask("worker-1", taskId, { title: "Updated", status: "claimed" });
      const data = await zk.getClaimedTask("worker-1", taskId);
      expect(data.title).toBe("Updated");
    });

    it("deleteClaimedTask removes the claim", async () => {
      const taskId = await zk.createPendingTask({ title: "Deletable claim" });
      await zk.claimTask("worker-1", taskId);
      await zk.deleteClaimedTask("worker-1", taskId);
      const data = await zk.getClaimedTask("worker-1", taskId);
      expect(data).toEqual({});
    });

    it("deletePendingTask removes pending task", async () => {
      const taskId = await zk.createPendingTask({ title: "Deletable pending" });
      await zk.deletePendingTask(taskId);
      const data = await zk.getPendingTask(taskId);
      expect(data).toBeNull();
    });

    it("saveCompletedTask and getCompletedTask", async () => {
      await zk.saveCompletedTask("task-done-1", { title: "Done", status: "completed" });
      const data = await zk.getCompletedTask("task-done-1");
      expect(data).not.toBeNull();
      expect(data!.title).toBe("Done");
    });

    it("listCompletedTasks returns all completed", async () => {
      await zk.saveCompletedTask("task-done-2", { title: "Done 2" });
      const completed = await zk.listCompletedTasks();
      expect(completed.some((t) => t.title === "Done")).toBe(true);
      expect(completed.some((t) => t.title === "Done 2")).toBe(true);
    });
  });

  // ── Message operations ──

  describe("message operations", () => {
    const instId = "msg-test-inst";

    beforeAll(async () => {
      await zk.registerInstance(instId, { name: "MsgTarget" });
    });

    it("createMessage returns sequential ID", async () => {
      const msgId = await zk.createMessage(instId, { content: "Hello" });
      expect(msgId).toMatch(/^msg-\d+$/);
      const data = await zk.getMessage(instId, msgId);
      expect(data).not.toBeNull();
      expect(data!.content).toBe("Hello");
    });

    it("listMessages returns sorted messages", async () => {
      await zk.createMessage(instId, { content: "Msg A" });
      await zk.createMessage(instId, { content: "Msg B" });
      const msgs = await zk.listMessages(instId);
      expect(msgs.length).toBeGreaterThanOrEqual(3);
      const ids = msgs.map(([id]) => id);
      expect(ids).toEqual([...ids].sort());
    });

    it("updateMessage modifies message", async () => {
      const msgId = await zk.createMessage(instId, { content: "Original" });
      await zk.updateMessage(instId, msgId, { content: "Updated", read: true });
      const data = await zk.getMessage(instId, msgId);
      expect(data!.content).toBe("Updated");
      expect(data!.read).toBe(true);
    });

    it("deleteMessage removes message", async () => {
      const msgId = await zk.createMessage(instId, { content: "Deletable" });
      await zk.deleteMessage(instId, msgId);
      const data = await zk.getMessage(instId, msgId);
      expect(data).toBeNull();
    });
  });

  // ── Watch operations ──

  describe("watch operations", () => {
    it("watchInstances returns children and fires on change", async () => {
      const received: string[][] = [];
      const children = await zk.watchInstances((c) => received.push(c));
      expect(Array.isArray(children)).toBe(true);

      await zk.registerInstance("watch-test-inst", { name: "WatchTarget" });

      await new Promise((r) => setTimeout(r, 500));
      expect(received.length).toBeGreaterThan(0);
    });

    it("watchPendingTasks returns children and fires on change", async () => {
      const received: string[][] = [];
      const children = await zk.watchPendingTasks((c) => received.push(c));
      expect(Array.isArray(children)).toBe(true);

      await zk.createPendingTask({ title: "Watch task" });

      await new Promise((r) => setTimeout(r, 500));
      expect(received.length).toBeGreaterThan(0);
    });

    it("watchClaimedTasks returns children and fires on change", async () => {
      const received: string[][] = [];
      const children = await zk.watchClaimedTasks((c) => received.push(c));
      expect(Array.isArray(children)).toBe(true);

      const taskId = await zk.createPendingTask({ title: "Claim watch" });
      await zk.claimTask("watch-worker", taskId);

      await new Promise((r) => setTimeout(r, 500));
      expect(received.length).toBeGreaterThan(0);
    });

    it("watchMessageDir returns children and fires on change", async () => {
      const received: string[][] = [];
      const children = await zk.watchMessageDir("msg-test-inst", (c) => received.push(c));
      expect(Array.isArray(children)).toBe(true);

      await zk.createMessage("msg-test-inst", { content: "Watch msg" });

      await new Promise((r) => setTimeout(r, 500));
      expect(received.length).toBeGreaterThan(0);
    });
  });

  // ── disconnect ──

  describe("disconnect", () => {
    it("connected returns false after disconnect", async () => {
      const zk2 = new ZkClient(ZK_HOSTS);
      await zk2.connect();
      expect(zk2.connected).toBe(true);
      await zk2.disconnect();
      expect(zk2.connected).toBe(false);
    });
  });
});
