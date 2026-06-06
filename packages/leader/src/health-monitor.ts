import type {
  IEventBus,
  IInstanceRegistry,
  Instance,
  InstanceId,
  LeaderEvent,
} from "@co/contracts";
import type { ILogger } from "@co/contracts";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds
const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds

export interface HealthMonitorOptions {
  registry: IInstanceRegistry;
  bus: IEventBus<LeaderEvent>;
  logger: ILogger;
  heartbeat_interval_ms?: number;
  timeout_ms?: number;
  on_worker_timeout?: (instance: Instance) => Promise<void>;
}

export interface WorkerHealthStatus {
  instance_id: InstanceId;
  name: string;
  status: "healthy" | "unhealthy" | "unknown";
  last_heartbeat: string | null;
  connected_since: string;
  seconds_since_heartbeat: number | null;
}

export class HealthMonitor {
  private stopped = false;
  private interval_timer: ReturnType<typeof setInterval> | null = null;
  private readonly registry: IInstanceRegistry;
  private readonly bus: IEventBus<LeaderEvent>;
  private readonly logger: ILogger;
  private readonly heartbeat_interval_ms: number;
  private readonly timeout_ms: number;
  private readonly on_worker_timeout?: (instance: Instance) => Promise<void>;

  constructor(opts: HealthMonitorOptions) {
    this.registry = opts.registry;
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.heartbeat_interval_ms = opts.heartbeat_interval_ms ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.on_worker_timeout = opts.on_worker_timeout;
  }

  start(): void {
    this.interval_timer = setInterval(() => {
      void this.checkHealth();
    }, this.heartbeat_interval_ms);
    this.logger.info("health monitor started", {
      heartbeat_interval_ms: this.heartbeat_interval_ms,
      timeout_ms: this.timeout_ms,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.interval_timer) {
      clearInterval(this.interval_timer);
      this.interval_timer = null;
    }
  }

  async checkHealth(): Promise<void> {
    if (this.stopped) return;

    try {
      const instances = await this.registry.list();
      const now = Date.now();

      for (const instance of instances) {
        if (instance.role === "leader") continue;

        const lastHeartbeat = instance.last_heartbeat
          ? new Date(instance.last_heartbeat).getTime()
          : new Date(instance.connected_since).getTime();

        const secondsSinceHeartbeat = (now - lastHeartbeat) / 1000;

        if (secondsSinceHeartbeat > this.timeout_ms / 1000) {
          this.logger.warn("worker heartbeat timeout", {
            instance_id: instance.id,
            name: instance.name,
            seconds_since_heartbeat: Math.floor(secondsSinceHeartbeat),
            timeout_ms: this.timeout_ms,
          });

          this.bus.emit({
            type: "worker_health_timeout",
            instance_id: instance.id,
            name: instance.name,
            last_heartbeat: instance.last_heartbeat,
            seconds_since_heartbeat: Math.floor(secondsSinceHeartbeat),
          });

          if (this.on_worker_timeout) {
            await this.on_worker_timeout(instance);
          }
        }
      }
    } catch (err) {
      this.logger.error("health check failed", { error: String(err) });
    }
  }

  async getWorkerHealthStatuses(): Promise<WorkerHealthStatus[]> {
    const instances = await this.registry.list();
    const now = Date.now();
    const statuses: WorkerHealthStatus[] = [];

    for (const instance of instances) {
      if (instance.role === "leader") continue;

      const lastHeartbeat = instance.last_heartbeat
        ? new Date(instance.last_heartbeat).getTime()
        : new Date(instance.connected_since).getTime();

      const secondsSinceHeartbeat = (now - lastHeartbeat) / 1000;
      const isHealthy = secondsSinceHeartbeat <= this.timeout_ms / 1000;

      statuses.push({
        instance_id: instance.id,
        name: instance.name,
        status: instance.last_heartbeat
          ? isHealthy
            ? "healthy"
            : "unhealthy"
          : "unknown",
        last_heartbeat: instance.last_heartbeat,
        connected_since: instance.connected_since,
        seconds_since_heartbeat: Math.floor(secondsSinceHeartbeat),
      });
    }

    return statuses;
  }
}