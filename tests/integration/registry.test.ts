import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

const TEST_ROOT = vi.hoisted(() => {
  const root = `/test-registry-${Date.now()}`;
  process.env.ZK_ROOT_PATH = root;
  return root;
});

import { ZkClient } from "../../src/zk/client.js";
import { InstanceRegistry } from "../../src/modules/registry.js";

describe("InstanceRegistry", () => {
  let zk: ZkClient;
  let registry: InstanceRegistry;

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();
    registry = new InstanceRegistry(zk);
  });

  afterAll(async () => {
    await zk.disconnect();
  });

  describe("register", () => {
    it("registers a new instance with auto-generated ID", async () => {
      const instance = await registry.register("TestWorker", "builder");
      expect(instance.id).toBeTruthy();
      expect(instance.id).not.toContain("-"); // UUID without hyphens
      expect(instance.name).toBe("TestWorker");
      expect(instance.role).toBe("builder");
      expect(instance.status).toBe("idle");
      expect(instance.connected_since).toBeTruthy();
    });

    it("defaults role to builder", async () => {
      const instance = await registry.register("DefaultRole");
      expect(instance.role).toBe("builder");
    });

    it("invalid role defaults to builder", async () => {
      const instance = await registry.register("BadRole", "invalid_role" as any);
      expect(instance.role).toBe("builder");
    });

    it("accepts all valid roles", async () => {
      for (const role of ["planner", "builder", "verifier", "reviewer", "accepter", "leader"]) {
        const instance = await registry.register(`Worker-${role}`, role);
        expect(instance.role).toBe(role);
      }
    });

    it("deduplicates by instanceId — reuses existing node", async () => {
      const first = await registry.register("First", "builder");
      const second = await registry.register("Updated", "verifier", first.id);
      expect(second.id).toBe(first.id);
      expect(second.name).toBe("Updated");
      expect(second.role).toBe("verifier");
    });

    it("deduplicates by name — reuses existing when no instanceId", async () => {
      const first = await registry.register("NameDedup", "builder");
      const second = await registry.register("NameDedup", "planner");
      expect(second.id).toBe(first.id);
      expect(second.role).toBe("planner");
    });

    it("generates unique IDs for distinct names", async () => {
      const a = await registry.register("UniqueA");
      const b = await registry.register("UniqueB");
      expect(a.id).not.toBe(b.id);
    });
  });

  describe("heartbeat", () => {
    it("updates current_task_id and status to busy", async () => {
      const instance = await registry.register("HeartbeatWorker");
      await registry.heartbeat(instance.id, "task-123");
      const updated = await registry.get(instance.id);
      expect(updated!.current_task_id).toBe("task-123");
      expect(updated!.status).toBe("busy");
    });

    it("sets status to idle when no currentTask", async () => {
      const instance = await registry.register("IdleWorker");
      await registry.heartbeat(instance.id); // no currentTask
      const updated = await registry.get(instance.id);
      expect(updated!.status).toBe("idle");
    });

    it("throws for non-existent instance", async () => {
      await expect(registry.heartbeat("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("get", () => {
    it("returns parsed Instance for existing ID", async () => {
      const instance = await registry.register("GetWorker");
      const found = await registry.get(instance.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("GetWorker");
    });

    it("returns null for non-existent ID", async () => {
      const found = await registry.get("nonexistent-id");
      expect(found).toBeNull();
    });
  });

  describe("listAll", () => {
    it("returns all registered instances", async () => {
      await registry.register("ListA");
      await registry.register("ListB");
      const instances = await registry.listAll();
      expect(instances.some((i) => i.name === "ListA")).toBe(true);
      expect(instances.some((i) => i.name === "ListB")).toBe(true);
    });
  });

  describe("unregister", () => {
    it("removes instance from ZK", async () => {
      const instance = await registry.register("TempWorker");
      await registry.unregister(instance.id);
      const found = await registry.get(instance.id);
      expect(found).toBeNull();
    });
  });
});
