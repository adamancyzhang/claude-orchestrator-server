// CORE-RETENTION
// Locks in: HealthMonitor's worker health detection — healthy worker check,
// timeout detection, getWorkerHealthStatuses() output, and start/stop lifecycle.
// Critical because: health monitoring is the cluster's heartbeat — missed
// timeouts leave dead workers consuming resources, and false positives
// cause unnecessary restarts.
// Primary sources: packages/leader/src/health-monitor.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  asInstanceId,
  type IEventBus,
  type IInstanceRegistry,
  type Instance,
  type LeaderEvent,
} from "@co/contracts";
import type { ILogger } from "@co/contracts";
import { HealthMonitor } from "../src/health-monitor.js";
import { LeaderEventBus } from "../src/event-bus.js";

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
    connected_since: new Date(Date.now() - 10000).toISOString(), // 10 seconds ago
    last_heartbeat: new Date(Date.now() - 5000).toISOString(), // 5 seconds ago
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
    last_heartbeat: null,
  });
}

function makeMonitor(overrides: Partial<{
  registry: IInstanceRegistry;
  bus: IEventBus<LeaderEvent>;
  logger: ILogger;
  heartbeat_interval_ms: number;
  timeout_ms: number;
  on_worker_timeout: (instance: Instance) => Promise<void>;
}> = {}): {
  monitor: HealthMonitor;
  registry: TestInstanceRegistry;
  bus: LeaderEventBus;
} {
  const registry = new TestInstanceRegistry();
  const bus = new LeaderEventBus();
  const logger = overrides.logger ?? noopLogger;
  const monitor = new HealthMonitor({
    registry: overrides.registry ?? registry,
    bus: overrides.bus ?? bus,
    logger,
    heartbeat_interval_ms: overrides.heartbeat_interval_ms ?? 100,
    timeout_ms: overrides.timeout_ms ?? 1000, // 1 second for fast tests
    on_worker_timeout: overrides.on_worker_timeout,
  });
  return { monitor, registry, bus };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("HealthMonitor — checkHealth", () => {
  it("does not emit timeout for healthy workers", async () => {
    const { monitor, registry, bus } = makeMonitor({ timeout_ms: 5000 });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({
        last_heartbeat: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      }),
    ]);

    await monitor.checkHealth();

    expect(events.filter((e) => e.type === "worker_health_timeout")).toHaveLength(0);
  });

  it("emits timeout for workers exceeding timeout threshold", async () => {
    const { monitor, registry, bus } = makeMonitor({ timeout_ms: 1000 });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({
        last_heartbeat: new Date(Date.now() - 2000).toISOString(), // 2 seconds ago
      }),
    ]);

    await monitor.checkHealth();

    const timeoutEvents = events.filter((e) => e.type === "worker_health_timeout");
    expect(timeoutEvents).toHaveLength(1);
    expect((timeoutEvents[0] as any).instance_id).toBe("worker-1");
    expect((timeoutEvents[0] as any).name).toBe("Worker1");
  });

  it("skips leader instances", async () => {
    const { monitor, registry, bus } = makeMonitor({ timeout_ms: 1000 });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeLeaderInstance(),
      makeInstance({
        last_heartbeat: new Date(Date.now() - 2000).toISOString(), // 2 seconds ago
      }),
    ]);

    await monitor.checkHealth();

    const timeoutEvents = events.filter((e) => e.type === "worker_health_timeout");
    expect(timeoutEvents).toHaveLength(1);
    expect((timeoutEvents[0] as any).instance_id).toBe("worker-1");
  });

  it("handles empty instance list", async () => {
    const { monitor, registry, bus } = makeMonitor();
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([]);

    await monitor.checkHealth();

    expect(events).toHaveLength(0);
  });

  it("uses connected_since when last_heartbeat is null", async () => {
    const { monitor, registry, bus } = makeMonitor({ timeout_ms: 1000 });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({
        last_heartbeat: null,
        connected_since: new Date(Date.now() - 2000).toISOString(), // 2 seconds ago
      }),
    ]);

    await monitor.checkHealth();

    const timeoutEvents = events.filter((e) => e.type === "worker_health_timeout");
    expect(timeoutEvents).toHaveLength(1);
  });

  it("calls on_worker_timeout callback when worker times out", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    const { monitor, registry } = makeMonitor({
      timeout_ms: 1000,
      on_worker_timeout: callback,
    });

    registry.setInstances([
      makeInstance({
        last_heartbeat: new Date(Date.now() - 2000).toISOString(),
      }),
    ]);

    await monitor.checkHealth();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-1" }));
  });

  it("logs warning on timeout", async () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: vi.fn(),
      error: () => {},
      child: () => logger,
    };
    const { monitor, registry } = makeMonitor({
      timeout_ms: 1000,
      logger,
    });

    registry.setInstances([
      makeInstance({
        last_heartbeat: new Date(Date.now() - 2000).toISOString(),
      }),
    ]);

    await monitor.checkHealth();

    expect(logger.warn).toHaveBeenCalledWith(
      "worker heartbeat timeout",
      expect.objectContaining({ instance_id: "worker-1" }),
    );
  });

  it("logs error when registry.list() fails", async () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: vi.fn(),
      child: () => logger,
    };
    const registry = {
      list: vi.fn().mockRejectedValue(new Error("ZK connection lost")),
    };
    const { monitor } = makeMonitor({ logger, registry: registry as any });

    await monitor.checkHealth();

    expect(logger.error).toHaveBeenCalledWith(
      "health check failed",
      expect.objectContaining({ error: expect.stringContaining("ZK connection lost") }),
    );
  });
});

describe("HealthMonitor — getWorkerHealthStatuses", () => {
  it("returns healthy status for workers with recent heartbeat", async () => {
    const { monitor, registry } = makeMonitor({ timeout_ms: 5000 });

    registry.setInstances([
      makeInstance({
        last_heartbeat: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);

    const statuses = await monitor.getWorkerHealthStatuses();

    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("healthy");
    expect(statuses[0].instance_id).toBe("worker-1");
    expect(statuses[0].name).toBe("Worker1");
  });

  it("returns unhealthy status for workers exceeding timeout", async () => {
    const { monitor, registry } = makeMonitor({ timeout_ms: 1000 });

    registry.setInstances([
      makeInstance({
        last_heartbeat: new Date(Date.now() - 2000).toISOString(),
      }),
    ]);

    const statuses = await monitor.getWorkerHealthStatuses();

    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("unhealthy");
    expect(statuses[0].seconds_since_heartbeat).toBeGreaterThanOrEqual(2);
  });

  it("returns unknown status when last_heartbeat is null", async () => {
    const { monitor, registry } = makeMonitor({ timeout_ms: 5000 });

    registry.setInstances([
      makeInstance({
        last_heartbeat: null,
        connected_since: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);

    const statuses = await monitor.getWorkerHealthStatuses();

    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("unknown");
  });

  it("excludes leader instances", async () => {
    const { monitor, registry } = makeMonitor({ timeout_ms: 5000 });

    registry.setInstances([
      makeLeaderInstance(),
      makeInstance(),
    ]);

    const statuses = await monitor.getWorkerHealthStatuses();

    expect(statuses).toHaveLength(1);
    expect(statuses[0].instance_id).toBe("worker-1");
  });

  it("returns empty array when no workers", async () => {
    const { monitor, registry } = makeMonitor();

    registry.setInstances([]);

    const statuses = await monitor.getWorkerHealthStatuses();

    expect(statuses).toHaveLength(0);
  });

  it("includes last_heartbeat and connected_since in output", async () => {
    const { monitor, registry } = makeMonitor({ timeout_ms: 5000 });
    const now = new Date();
    const connectedSince = new Date(now.getTime() - 60000);
    const lastHeartbeat = new Date(now.getTime() - 5000);

    registry.setInstances([
      makeInstance({
        connected_since: connectedSince.toISOString(),
        last_heartbeat: lastHeartbeat.toISOString(),
      }),
    ]);

    const statuses = await monitor.getWorkerHealthStatuses();

    expect(statuses[0].connected_since).toBe(connectedSince.toISOString());
    expect(statuses[0].last_heartbeat).toBe(lastHeartbeat.toISOString());
  });
});

describe("HealthMonitor — lifecycle", () => {
  it("start begins periodic health checks", async () => {
    vi.useFakeTimers();
    const { monitor, registry, bus } = makeMonitor({ heartbeat_interval_ms: 100 });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({
        last_heartbeat: new Date(Date.now() - 2000).toISOString(),
      }),
    ]);

    monitor.start();

    // Advance time to trigger health check
    await vi.advanceTimersByTimeAsync(150);

    expect(events.filter((e) => e.type === "worker_health_timeout")).toHaveLength(1);

    monitor.stop();
    vi.useRealTimers();
  });

  it("stop prevents further health checks", async () => {
    vi.useFakeTimers();
    const { monitor, registry, bus } = makeMonitor({ heartbeat_interval_ms: 100 });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({
        last_heartbeat: new Date(Date.now() - 2000).toISOString(),
      }),
    ]);

    monitor.start();
    monitor.stop();

    // Reset events
    events.length = 0;

    // Advance time
    await vi.advanceTimersByTimeAsync(200);

    expect(events.filter((e) => e.type === "worker_health_timeout")).toHaveLength(0);

    vi.useRealTimers();
  });

  it("logs start message with configuration", () => {
    const logger = {
      debug: () => {},
      info: vi.fn(),
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    const { monitor } = makeMonitor({
      heartbeat_interval_ms: 5000,
      timeout_ms: 30000,
      logger,
    });

    monitor.start();

    expect(logger.info).toHaveBeenCalledWith(
      "health monitor started",
      expect.objectContaining({
        heartbeat_interval_ms: 5000,
        timeout_ms: 30000,
      }),
    );

    monitor.stop();
  });

});

describe("HealthMonitor — multiple workers", () => {
  it("detects timeout for multiple workers simultaneously", async () => {
    const { monitor, registry, bus } = makeMonitor({ timeout_ms: 1000 });
    const events: LeaderEvent[] = [];
    bus.onAny((e) => events.push(e));

    registry.setInstances([
      makeInstance({
        id: asInstanceId("worker-1"),
        name: "Worker1",
        last_heartbeat: new Date(Date.now() - 2000).toISOString(),
      }),
      makeInstance({
        id: asInstanceId("worker-2"),
        name: "Worker2",
        last_heartbeat: new Date(Date.now() - 3000).toISOString(),
      }),
      makeInstance({
        id: asInstanceId("worker-3"),
        name: "Worker3",
        last_heartbeat: new Date(Date.now() - 500).toISOString(), // healthy
      }),
    ]);

    await monitor.checkHealth();

    const timeoutEvents = events.filter((e) => e.type === "worker_health_timeout");
    expect(timeoutEvents).toHaveLength(2);
    expect(timeoutEvents.map((e) => (e as any).instance_id)).toContain("worker-1");
    expect(timeoutEvents.map((e) => (e as any).instance_id)).toContain("worker-2");
  });

  it("getWorkerHealthStatuses returns all worker statuses", async () => {
    const { monitor, registry } = makeMonitor({ timeout_ms: 1000 });

    registry.setInstances([
      makeInstance({
        id: asInstanceId("worker-1"),
        name: "Worker1",
        last_heartbeat: new Date(Date.now() - 500).toISOString(),
      }),
      makeInstance({
        id: asInstanceId("worker-2"),
        name: "Worker2",
        last_heartbeat: new Date(Date.now() - 2000).toISOString(),
      }),
    ]);

    const statuses = await monitor.getWorkerHealthStatuses();

    expect(statuses).toHaveLength(2);
    expect(statuses.find((s) => s.instance_id === "worker-1")?.status).toBe("healthy");
    expect(statuses.find((s) => s.instance_id === "worker-2")?.status).toBe("unhealthy");
  });
});
