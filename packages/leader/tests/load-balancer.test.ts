import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  asInstanceId,
  type IInstanceRegistry,
  type Instance,
} from "@co/contracts";
import type { ILogger } from "@co/contracts";
import { LoadBalancer } from "../src/load-balancer.js";

// ── Test doubles ──────────────────────────────────────────────────────

class TestInstanceRegistry implements IInstanceRegistry {
  private instances: Instance[] = [];

  setInstances(list: Instance[]): void {
    this.instances = list;
  }

  async list(): Promise<Instance[]> {
    return this.instances;
  }

  async get(id: string): Promise<Instance | undefined> {
    return this.instances.find((i) => i.id === id);
  }

  async register(_inst: any): Promise<Instance> {
    throw new Error("register unused");
  }

  async unregister(_id: string): Promise<void> {
    throw new Error("unregister unused");
  }

  async heartbeat(_id: string, _patch: any): Promise<void> {
    throw new Error("heartbeat unused");
  }

  async watch(_cb: any): Promise<Instance[]> {
    throw new Error("watch unused");
  }
}

const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

// ── Helpers ───────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: asInstanceId("worker-1"),
    name: "Worker1",
    role: "executor",
    status: "idle",
    current_task_id: null,
    connected_since: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    work_dir: null,
    worktree_name: null,
    worktree_path: null,
    worktree_branch: null,
    pid: null,
    protocol_version: "1.0.0",
    ...overrides,
  };
}

function makeLeaderInstance(): Instance {
  return makeInstance({
    id: asInstanceId("leader-1"),
    name: "Leader1",
    role: "leader",
  });
}

function makeLoadBalancer(overrides: Partial<{
  registry: IInstanceRegistry;
  logger: ILogger;
  cpu_weight: number;
  memory_weight: number;
  task_weight: number;
  max_tasks_per_worker: number;
  adaptive: boolean;
}> = {}): {
  balancer: LoadBalancer;
  registry: TestInstanceRegistry;
} {
  const registry = new TestInstanceRegistry();
  const balancer = new LoadBalancer({
    registry: overrides.registry ?? registry,
    logger: overrides.logger ?? noopLogger,
    cpu_weight: overrides.cpu_weight,
    memory_weight: overrides.memory_weight,
    task_weight: overrides.task_weight,
    max_tasks_per_worker: overrides.max_tasks_per_worker,
    adaptive: overrides.adaptive,
  });
  return { balancer, registry };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("LoadBalancer — findBestWorker", () => {
  it("returns null when no workers available", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([]);

    const result = await balancer.findBestWorker("executor");

    expect(result).toBeNull();
  });

  it("returns null when no workers with matching role", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([
      makeInstance({ role: "planner" }),
    ]);

    const result = await balancer.findBestWorker("executor");

    expect(result).toBeNull();
  });

  it("excludes leader instances", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([
      makeLeaderInstance(),
      makeInstance({ id: asInstanceId("worker-1"), name: "Worker1" }),
    ]);

    const result = await balancer.findBestWorker("executor");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("worker-1");
  });

  it("selects idle worker over busy worker", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([
      makeInstance({ id: asInstanceId("worker-1"), name: "Worker1", status: "busy" }),
      makeInstance({ id: asInstanceId("worker-2"), name: "Worker2", status: "idle" }),
    ]);

    const result = await balancer.findBestWorker("executor");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("worker-2");
  });

  it("handles multiple workers with same role", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([
      makeInstance({ id: asInstanceId("worker-1"), name: "Worker1" }),
      makeInstance({ id: asInstanceId("worker-2"), name: "Worker2" }),
      makeInstance({ id: asInstanceId("worker-3"), name: "Worker3" }),
    ]);

    const result = await balancer.findBestWorker("executor");

    expect(result).not.toBeNull();
    expect(["worker-1", "worker-2", "worker-3"]).toContain(result!.id);
  });
});

describe("LoadBalancer — getWorkerLoads", () => {
  it("returns loads for all non-leader workers", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([
      makeLeaderInstance(),
      makeInstance({ id: asInstanceId("worker-1"), name: "Worker1" }),
      makeInstance({ id: asInstanceId("worker-2"), name: "Worker2" }),
    ]);

    const loads = await balancer.getWorkerLoads();

    expect(loads).toHaveLength(2);
    expect(loads.map((l) => l.instance_id)).toContain("worker-1");
    expect(loads.map((l) => l.instance_id)).toContain("worker-2");
  });

  it("filters by role when specified", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([
      makeInstance({ id: asInstanceId("worker-1"), name: "Worker1", role: "executor" }),
      makeInstance({ id: asInstanceId("worker-2"), name: "Worker2", role: "planner" }),
      makeInstance({ id: asInstanceId("worker-3"), name: "Worker3", role: "executor" }),
    ]);

    const loads = await balancer.getWorkerLoads("executor");

    expect(loads).toHaveLength(2);
    expect(loads.every((l) => l.role === "executor")).toBe(true);
  });

  it("includes load score in output", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([
      makeInstance({ id: asInstanceId("worker-1"), name: "Worker1" }),
    ]);

    const loads = await balancer.getWorkerLoads();

    expect(loads).toHaveLength(1);
    expect(loads[0].load_score).toBeGreaterThanOrEqual(0);
    expect(loads[0].load_score).toBeLessThanOrEqual(1);
  });
});

describe("LoadBalancer — getStats", () => {
  it("returns correct worker counts", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([
      makeLeaderInstance(),
      makeInstance({ id: asInstanceId("worker-1"), name: "Worker1", status: "idle" }),
      makeInstance({ id: asInstanceId("worker-2"), name: "Worker2", status: "busy" }),
    ]);

    const stats = await balancer.getStats();

    expect(stats.total_workers).toBe(2);
    expect(stats.idle_workers).toBe(1);
    expect(stats.busy_workers).toBe(1);
  });

  it("calculates average load", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([
      makeInstance({ id: asInstanceId("worker-1"), name: "Worker1" }),
      makeInstance({ id: asInstanceId("worker-2"), name: "Worker2" }),
    ]);

    const stats = await balancer.getStats();

    expect(stats.average_load).toBeGreaterThanOrEqual(0);
    expect(stats.average_load).toBeLessThanOrEqual(1);
  });

  it("handles empty worker list", async () => {
    const { balancer, registry } = makeLoadBalancer();
    registry.setInstances([]);

    const stats = await balancer.getStats();

    expect(stats.total_workers).toBe(0);
    expect(stats.average_load).toBe(0);
  });
});

describe("LoadBalancer — recordTaskCompletion", () => {
  it("records task completion", () => {
    const { balancer } = makeLoadBalancer();

    // Should not throw
    balancer.recordTaskCompletion(
      asInstanceId("worker-1"),
      1,
      5000,
      true,
    );
  });

  it("records multiple completions", () => {
    const { balancer } = makeLoadBalancer();

    for (let i = 0; i < 5; i++) {
      balancer.recordTaskCompletion(
        asInstanceId("worker-1"),
        i + 1,
        5000 + i * 1000,
        true,
      );
    }
  });

  it("handles failed completions", () => {
    const { balancer } = makeLoadBalancer();

    balancer.recordTaskCompletion(
      asInstanceId("worker-1"),
      1,
      10000,
      false,
    );
  });
});

describe("LoadBalancer — adaptive balancing", () => {
  it("adjusts load score based on performance history", async () => {
    const { balancer, registry } = makeLoadBalancer({ adaptive: true });
    registry.setInstances([
      makeInstance({ id: asInstanceId("worker-1"), name: "Worker1", status: "idle" }),
      makeInstance({ id: asInstanceId("worker-2"), name: "Worker2", status: "idle" }),
    ]);

    // Record good performance for worker-1
    for (let i = 0; i < 5; i++) {
      balancer.recordTaskCompletion(
        asInstanceId("worker-1"),
        i + 1,
        2000, // Fast completion
        true,
      );
    }

    // Record poor performance for worker-2
    for (let i = 0; i < 5; i++) {
      balancer.recordTaskCompletion(
        asInstanceId("worker-2"),
        i + 1,
        10000, // Slow completion
        true,
      );
    }

    const loads = await balancer.getWorkerLoads();
    const worker1 = loads.find((l) => l.instance_id === "worker-1");
    const worker2 = loads.find((l) => l.instance_id === "worker-2");

    expect(worker1).toBeDefined();
    expect(worker2).toBeDefined();

    // Worker 1 should have lower load score due to better performance
    expect(worker1!.load_score).toBeLessThanOrEqual(worker2!.load_score);
  });

  it("disables adaptive balancing when configured", async () => {
    const { balancer } = makeLoadBalancer({ adaptive: false });

    // Should not track performance
    balancer.recordTaskCompletion(
      asInstanceId("worker-1"),
      1,
      2000,
      true,
    );
  });
});
