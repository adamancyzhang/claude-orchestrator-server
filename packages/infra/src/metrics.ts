import type { ILogger, IMetricsCollector } from "@co/contracts";

/**
 * A simple counter that tracks monotonic increasing values.
 */
export class Counter {
  private value = 0;

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  inc(delta = 1): void {
    this.value += delta;
  }

  getValue(): number {
    return this.value;
  }

  /**
   * Render in Prometheus text format.
   * Format:
   *   # HELP <name> <help>
   *   # TYPE <name> counter
   *   <name> <value>
   */
  format(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n${this.name} ${this.value}`;
  }
}

/**
 * A labeled counter that tracks monotonic increasing values per label combination.
 */
export class LabeledCounter {
  private readonly values = new Map<string, number>();

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly labelNames: string[],
  ) {}

  inc(labels: Record<string, string>, delta = 1): void {
    const key = this.labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  getValue(labels: Record<string, string>): number {
    return this.values.get(this.labelKey(labels)) ?? 0;
  }

  private labelKey(labels: Record<string, string>): string {
    return this.labelNames
      .map((n) => `${n}=${labels[n] ?? ""}`)
      .join(",");
  }

  /**
   * Render all label combinations in Prometheus text format.
   */
  format(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const [key, value] of this.values) {
      const labelParts = key.split(",").map((p) => {
        const [n, v] = p.split("=");
        return `${n}="${v}"`;
      });
      lines.push(`${this.name}{${labelParts.join(", ")}} ${value}`);
    }
    return lines.join("\n");
  }

  /**
   * Get all recorded label combinations and their values.
   */
  getAll(): Array<{ labels: Record<string, string>; value: number }> {
    const result: Array<{ labels: Record<string, string>; value: number }> = [];
    for (const [key, value] of this.values) {
      const labels: Record<string, string> = {};
      for (const part of key.split(",")) {
        const [n, v] = part.split("=");
        labels[n] = v;
      }
      result.push({ labels, value });
    }
    return result;
  }
}

/**
 * A gauge that tracks values that can go up and down.
 */
export class Gauge {
  private value = 0;

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  set(value: number): void {
    this.value = value;
  }

  inc(delta = 1): void {
    this.value += delta;
  }

  dec(delta = 1): void {
    this.value -= delta;
  }

  getValue(): number {
    return this.value;
  }

  format(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n${this.name} ${this.value}`;
  }
}

/**
 * A simple histogram that tracks value distributions using predefined buckets.
 */
export class Histogram {
  private sum = 0;
  private count = 0;
  private readonly buckets: Map<number, number>;

  constructor(
    private readonly name: string,
    private readonly help: string,
    boundaries: number[] = [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  ) {
    this.buckets = new Map(boundaries.map((b) => [b, 0]));
  }

  observe(value: number): void {
    this.sum += value;
    this.count++;
    // Only increment the smallest bucket that contains the value.
    // In Prometheus histograms, each observation goes into exactly one bucket.
    for (const [boundary] of this.buckets) {
      if (value <= boundary) {
        this.buckets.set(boundary, (this.buckets.get(boundary) ?? 0) + 1);
        break;
      }
    }
  }

  getValue(): { sum: number; count: number } {
    return { sum: this.sum, count: this.count };
  }

  format(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    let cumulative = 0;
    for (const [boundary, count] of this.buckets) {
      cumulative += count;
      lines.push(`${this.name}_bucket{le="${boundary}"} ${cumulative}`);
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    lines.push(`${this.name}_count ${this.count}`);
    return lines.join("\n");
  }
}

export interface AlertRule {
  name: string;
  description: string;
  /** Function that returns true when the alert should fire. */
  check: () => boolean;
  /** Severity level. */
  severity: "warning" | "critical";
}

export interface MetricsCollectorOptions {
  logger?: ILogger;
}

/**
 * Central metrics collector for the orchestrator. Tracks key performance
 * indicators and exports them in Prometheus text format.
 *
 * Implements IMetricsCollector from @co/contracts.
 *
 * Usage:
 *   const metrics = new PrometheusMetricsCollector({ logger });
 *   metrics.tasksDispatched.inc({ link: "execute" });
 *   metrics.taskDuration.observe(2.5);
 *   console.log(metrics.format());
 */
export class PrometheusMetricsCollector implements IMetricsCollector {
  // --- Task metrics (architect-specified) ---
  readonly tasksDispatched = new LabeledCounter(
    "co_tasks_dispatched_total",
    "Total tasks dispatched",
    ["link"],
  );
  readonly tasksCompleted = new LabeledCounter(
    "co_tasks_completed_total",
    "Total tasks completed",
    ["link", "outcome"],
  );
  readonly taskDuration = new Histogram(
    "co_task_duration_seconds",
    "Task execution duration in seconds",
  );

  // --- Worker metrics (architect-specified) ---
  readonly workerHeartbeatSecondsSince = new Gauge(
    "co_worker_heartbeat_seconds_since",
    "Seconds since last worker heartbeat",
  );

  // --- Additional task metrics ---
  readonly tasksCreated = new Counter("co_tasks_created_total", "Total tasks created");
  readonly tasksFailed = new Counter("co_tasks_failed_total", "Total tasks failed");
  readonly tasksRetried = new Counter("co_tasks_retried_total", "Total tasks retried");
  readonly pendingTasks = new Gauge("co_pending_tasks", "Number of pending tasks");
  readonly claimedTasks = new Gauge("co_claimed_tasks", "Number of claimed tasks");

  // --- Chain metrics ---
  readonly chainsActivated = new Counter("co_chains_activated_total", "Total chains activated");
  readonly chainsClosed = new Counter("co_chains_closed_total", "Total chains closed");
  readonly chainsFailed = new Counter("co_chains_failed_total", "Total chains failed (aborted/merge_failed)");
  readonly activeChains = new Gauge("co_active_chains", "Number of active chains");

  // --- Worker metrics ---
  readonly workersJoined = new Counter("co_workers_joined_total", "Total workers joined");
  readonly workersLeft = new Counter("co_workers_left_total", "Total workers left");
  readonly activeWorkers = new Gauge("co_active_workers", "Number of active workers");
  readonly workerHeartbeats = new Counter("co_worker_heartbeats_total", "Total worker heartbeats received");

  // --- Message metrics ---
  readonly messagesSent = new Counter("co_messages_sent_total", "Total messages sent");
  readonly messagesProcessed = new Counter("co_messages_processed_total", "Total messages processed");

  // --- Merge metrics ---
  readonly mergesSucceeded = new Counter("co_merges_succeeded_total", "Total merges succeeded");
  readonly mergesFailed = new Counter("co_merges_failed_total", "Total merges failed");
  readonly mergeDuration = new Histogram("co_merge_duration_seconds", "Merge operation duration in seconds");

  // --- Error metrics ---
  readonly errorsTotal = new Counter("co_errors_total", "Total errors encountered");
  readonly recoveriesTotal = new Counter("co_recoveries_total", "Total orphan recoveries attempted");

  private readonly alertRules: AlertRule[] = [];
  private readonly logger?: ILogger;
  private readonly startTime = Date.now();

  constructor(opts: MetricsCollectorOptions = {}) {
    this.logger = opts.logger;
  }

  /**
   * Register an alert rule. When the rule's check function returns true,
   * the alert fires (logged as warning or error based on severity).
   */
  addAlertRule(rule: AlertRule): void {
    this.alertRules.push(rule);
  }

  /**
   * Evaluate all alert rules and log any that fire.
   * Call this periodically (e.g. every 30 seconds).
   */
  checkAlerts(): void {
    for (const rule of this.alertRules) {
      if (rule.check()) {
        const msg = `ALERT [${rule.severity.toUpperCase()}] ${rule.name}: ${rule.description}`;
        if (rule.severity === "critical") {
          this.logger?.error(msg);
        } else {
          this.logger?.warn(msg);
        }
      }
    }
  }

  /**
   * Get uptime in seconds since the collector was created.
   */
  getUptimeSeconds(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * Export all metrics in Prometheus text exposition format.
   */
  format(): string {
    const sections: string[] = [];

    // Add process info
    sections.push(
      `# HELP co_process_uptime_seconds Process uptime in seconds\n` +
      `# TYPE co_process_uptime_seconds gauge\n` +
      `co_process_uptime_seconds ${this.getUptimeSeconds().toFixed(1)}`,
    );

    // Collect all metric instances
    const metrics: Array<{ format: () => string }> = [
      this.tasksDispatched,
      this.tasksCompleted,
      this.taskDuration,
      this.workerHeartbeatSecondsSince,
      this.tasksCreated,
      this.tasksFailed,
      this.tasksRetried,
      this.pendingTasks,
      this.claimedTasks,
      this.chainsActivated,
      this.chainsClosed,
      this.chainsFailed,
      this.activeChains,
      this.workersJoined,
      this.workersLeft,
      this.activeWorkers,
      this.workerHeartbeats,
      this.messagesSent,
      this.messagesProcessed,
      this.mergesSucceeded,
      this.mergesFailed,
      this.mergeDuration,
      this.errorsTotal,
      this.recoveriesTotal,
    ];

    for (const metric of metrics) {
      sections.push(metric.format());
    }

    return sections.join("\n\n");
  }

  /**
   * Create a snapshot of all metrics as a plain object.
   * Useful for structured logging or JSON export.
   */
  snapshot(): Record<string, unknown> {
    return {
      uptime_seconds: this.getUptimeSeconds(),
      tasks: {
        dispatched: this.tasksDispatched.getAll(),
        completed: this.tasksCompleted.getAll(),
        created: this.tasksCreated.getValue(),
        failed: this.tasksFailed.getValue(),
        retried: this.tasksRetried.getValue(),
        pending: this.pendingTasks.getValue(),
        claimed: this.claimedTasks.getValue(),
        duration: this.taskDuration.getValue(),
      },
      chains: {
        activated: this.chainsActivated.getValue(),
        closed: this.chainsClosed.getValue(),
        failed: this.chainsFailed.getValue(),
        active: this.activeChains.getValue(),
      },
      workers: {
        joined: this.workersJoined.getValue(),
        left: this.workersLeft.getValue(),
        active: this.activeWorkers.getValue(),
        heartbeats: this.workerHeartbeats.getValue(),
        heartbeat_seconds_since: this.workerHeartbeatSecondsSince.getValue(),
      },
      messages: {
        sent: this.messagesSent.getValue(),
        processed: this.messagesProcessed.getValue(),
      },
      merges: {
        succeeded: this.mergesSucceeded.getValue(),
        failed: this.mergesFailed.getValue(),
        duration: this.mergeDuration.getValue(),
      },
      errors: this.errorsTotal.getValue(),
      recoveries: this.recoveriesTotal.getValue(),
    };
  }
}

/**
 * @deprecated Use PrometheusMetricsCollector instead.
 */
export const MetricsCollector = PrometheusMetricsCollector;
