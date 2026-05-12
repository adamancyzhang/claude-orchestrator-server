import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

const TEST_ROOT = vi.hoisted(() => {
  const root = `/test-taskqueue-${Date.now()}`;
  process.env.ZK_ROOT_PATH = root;
  return root;
});

import { ZkClient } from "../../src/zk/client.js";
import { InstanceRegistry } from "../../src/modules/registry.js";
import { TaskQueue } from "../../src/modules/task-queue.js";

describe("TaskQueue", () => {
  let zk: ZkClient;
  let taskQueue: TaskQueue;
  let registry: InstanceRegistry;

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();
    taskQueue = new TaskQueue(zk);
    registry = new InstanceRegistry(zk);
  });

  afterAll(async () => {
    await zk.disconnect();
  });

  // Drain all pending/claimed tasks to get a clean slate
  async function drainQueue() {
    let claimed = await taskQueue.claim("drainer");
    while (claimed) {
      try {
        await taskQueue.complete("drainer", claimed.id, "drained");
      } catch {
        // ignore — might not be claimable by drainer
      }
      claimed = await taskQueue.claim("drainer");
    }
  }

  describe("push", () => {
    it("creates a pending task with generated ID", async () => {
      const task = await taskQueue.push("Test task", "A description", 1, "creator-1");
      expect(task.id).toMatch(/^task-\d+$/);
      expect(task.title).toBe("Test task");
      expect(task.description).toBe("A description");
      expect(task.status).toBe("pending");
      expect(task.retry_count).toBe(0);
    });

    it("defaults priority to 1 (MEDIUM)", async () => {
      const task = await taskQueue.push("Default prio");
      expect(task.priority).toBe(1);
    });

    it("clamps invalid priority to 1", async () => {
      const task = await taskQueue.push("Bad prio", "", 999 as any, "creator-1");
      expect(task.priority).toBe(1);
    });

    it("stores chain link and chain_id", async () => {
      const task = await taskQueue.push("Chain task", "", 1, "creator-1", undefined, undefined, undefined, "build", "chain-001");
      expect(task.link).toBe("build");
      expect(task.chain_id).toBe("chain-001");
    });

    it("stores depends_on and blocked_by", async () => {
      const task = await taskQueue.push("Dep task", "", 1, "creator-1", undefined, undefined, undefined, undefined, undefined, ["task-1"], ["task-2"]);
      expect(task.depends_on).toEqual(["task-1"]);
      expect(task.blocked_by).toEqual(["task-2"]);
    });
  });

  describe("claim", () => {
    // Each sub-test drains first for a clean slate
    it("claims a pending task", async () => {
      await drainQueue();
      const task = await taskQueue.push("Solo claimable");
      const claimed = await taskQueue.claim("worker-1");
      expect(claimed).not.toBeNull();
      expect(claimed!.title).toBe("Solo claimable");
      expect(claimed!.status).toBe("claimed");
      expect(claimed!.claimed_by).toBe("worker-1");
    });

    it("returns null when no pending tasks", async () => {
      await drainQueue();
      const claimed = await taskQueue.claim("no-tasks-worker");
      expect(claimed).toBeNull();
    });

    it("sorts by assigned_to first", async () => {
      await drainQueue();
      const inst = await registry.register("AssignedWorker2", "builder");
      await taskQueue.push("Unassigned", "", 0, "creator-1");
      const assigned = await taskQueue.push("Assigned task", "", 2, "creator-1", inst.id);

      const claimed = await taskQueue.claim(inst.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(assigned.id);
    });

    it("sorts by role-link match second", async () => {
      await drainQueue();
      const inst = await registry.register("RoleMatchWorker2", "builder");
      await taskQueue.push("Plan task", "", 0, "creator-1", undefined, undefined, undefined, "plan", null);
      const buildTask = await taskQueue.push("Build task", "", 1, "creator-1", undefined, undefined, undefined, "build", null);

      const claimed = await taskQueue.claim(inst.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(buildTask.id);
    });

    it("role-link mapping: accepter prefers accept", async () => {
      await drainQueue();
      const inst = await registry.register("AccepterWorker2", "accepter");
      await taskQueue.push("Build first", "", 0, "creator-1", undefined, undefined, undefined, "build", null);
      const acceptTask = await taskQueue.push("Accept task", "", 1, "creator-1", undefined, undefined, undefined, "accept", null);

      const claimed = await taskQueue.claim(inst.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(acceptTask.id);
      expect(claimed!.link).toBe("accept");
    });
  });

  describe("complete", () => {
    it("completes a claimed task", async () => {
      await drainQueue();
      const task = await taskQueue.push("To complete");
      const claimed = await taskQueue.claim("worker-1");
      expect(claimed).not.toBeNull();
      const completed = await taskQueue.complete("worker-1", claimed!.id, "All done");
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("All done");
    });

    it("throws if task not claimed by instance", async () => {
      await drainQueue();
      const task = await taskQueue.push("Not yours");
      const claimed = await taskQueue.claim("worker-1");
      await expect(taskQueue.complete("worker-2", task.id, "nope")).rejects.toThrow("not claimed by worker-2");
    });
  });

  describe("block", () => {
    it("blocks a claimed task", async () => {
      await drainQueue();
      const task = await taskQueue.push("Blockable");
      const claimed = await taskQueue.claim("worker-1");
      expect(claimed).not.toBeNull();
      const blocked = await taskQueue.block("worker-1", claimed!.id, "Waiting for dep");
      expect(blocked.status).toBe("blocked");
      expect(blocked.blocked_reason).toBe("Waiting for dep");
    });

    it("throws if task not claimed by instance", async () => {
      await drainQueue();
      const task = await taskQueue.push("Not your block");
      await taskQueue.claim("worker-1");
      await expect(taskQueue.block("worker-2", task.id, "nope")).rejects.toThrow("not claimed by worker-2");
    });
  });

  describe("fail", () => {
    it("fails a claimed task", async () => {
      await drainQueue();
      const task = await taskQueue.push("Failable");
      const claimed = await taskQueue.claim("worker-1");
      expect(claimed).not.toBeNull();
      const failed = await taskQueue.fail("worker-1", claimed!.id, "Dependency timeout");
      expect(failed.status).toBe("failed");
      expect(failed.fail_reason).toBe("Dependency timeout");
    });
  });

  describe("retry", () => {
    it("creates a new pending task with incremented retry_count", async () => {
      await drainQueue();
      const task = await taskQueue.push("Retryable");
      const claimed = await taskQueue.claim("worker-1");
      expect(claimed).not.toBeNull();
      await taskQueue.fail("worker-1", claimed!.id, "Transient error");

      const retried = await taskQueue.retry(claimed!.id);
      expect(retried.status).toBe("pending");
      expect(retried.retry_count).toBe(1);
      expect(retried.title).toBe("Retryable");
    });

    it("throws if task not found in completed", async () => {
      await expect(taskQueue.retry("nonexistent-task")).rejects.toThrow("not found");
    });
  });

  describe("listTasks", () => {
    it("returns all tasks when no status filter", async () => {
      const tasks = await taskQueue.listTasks();
      expect(tasks.length).toBeGreaterThan(0);
    });

    it("filters by status: pending", async () => {
      const tasks = await taskQueue.listTasks("pending");
      expect(tasks.every((t) => t.status === "pending")).toBe(true);
    });

    it("filters by status: completed", async () => {
      const tasks = await taskQueue.listTasks("completed");
      expect(tasks.every((t) => t.status === "completed")).toBe(true);
    });
  });
});
