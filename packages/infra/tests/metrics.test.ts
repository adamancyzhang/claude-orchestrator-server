import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Counter,
  LabeledCounter,
  Gauge,
  Histogram,
  PrometheusMetricsCollector,
  MetricsCollector,
  type AlertRule,
} from "../src/metrics.js";

describe("Counter", () => {
  it("starts at zero", () => {
    const c = new Counter("test_counter", "Test help");
    expect(c.getValue()).toBe(0);
  });

  it("increments by 1 by default", () => {
    const c = new Counter("test_counter", "Test help");
    c.inc();
    expect(c.getValue()).toBe(1);
  });

  it("increments by custom delta", () => {
    const c = new Counter("test_counter", "Test help");
    c.inc(5);
    expect(c.getValue()).toBe(5);
  });

  it("accumulates increments", () => {
    const c = new Counter("test_counter", "Test help");
    c.inc(3);
    c.inc(2);
    c.inc(1);
    expect(c.getValue()).toBe(6);
  });

  it("formats in Prometheus text format", () => {
    const c = new Counter("http_requests_total", "Total HTTP requests");
    c.inc(42);
    const output = c.format();
    expect(output).toContain("# HELP http_requests_total Total HTTP requests");
    expect(output).toContain("# TYPE http_requests_total counter");
    expect(output).toContain("http_requests_total 42");
  });
});

describe("Gauge", () => {
  it("starts at zero", () => {
    const g = new Gauge("test_gauge", "Test help");
    expect(g.getValue()).toBe(0);
  });

  it("sets value", () => {
    const g = new Gauge("test_gauge", "Test help");
    g.set(10);
    expect(g.getValue()).toBe(10);
  });

  it("increments", () => {
    const g = new Gauge("test_gauge", "Test help");
    g.set(5);
    g.inc();
    expect(g.getValue()).toBe(6);
  });

  it("decrements", () => {
    const g = new Gauge("test_gauge", "Test help");
    g.set(5);
    g.dec(2);
    expect(g.getValue()).toBe(3);
  });

  it("formats in Prometheus text format", () => {
    const g = new Gauge("active_connections", "Active connections");
    g.set(15);
    const output = g.format();
    expect(output).toContain("# HELP active_connections Active connections");
    expect(output).toContain("# TYPE active_connections gauge");
    expect(output).toContain("active_connections 15");
  });
});

describe("Histogram", () => {
  it("starts with zero count and sum", () => {
    const h = new Histogram("test_histogram", "Test help");
    const { sum, count } = h.getValue();
    expect(sum).toBe(0);
    expect(count).toBe(0);
  });

  it("observes values and updates count/sum", () => {
    const h = new Histogram("test_histogram", "Test help");
    h.observe(1.5);
    h.observe(2.5);
    const { sum, count } = h.getValue();
    expect(sum).toBe(4);
    expect(count).toBe(2);
  });

  it("distributes values into default buckets", () => {
    const h = new Histogram("test_histogram", "Test help");
    h.observe(0.05); // <= 0.1
    h.observe(0.3);  // <= 0.5
    h.observe(0.8);  // <= 1
    h.observe(1.5);  // <= 2
    h.observe(3);    // <= 5
    h.observe(7);    // <= 10
    h.observe(20);   // <= 30
    h.observe(45);   // <= 60
    h.observe(100);  // > 60

    const output = h.format();
    expect(output).toContain('test_histogram_bucket{le="0.1"} 1');
    expect(output).toContain('test_histogram_bucket{le="0.5"} 2');
    expect(output).toContain('test_histogram_bucket{le="1"} 3');
    expect(output).toContain('test_histogram_bucket{le="2"} 4');
    expect(output).toContain('test_histogram_bucket{le="5"} 5');
    expect(output).toContain('test_histogram_bucket{le="10"} 6');
    expect(output).toContain('test_histogram_bucket{le="30"} 7');
    expect(output).toContain('test_histogram_bucket{le="60"} 8');
    expect(output).toContain('test_histogram_bucket{le="+Inf"} 9');
    // Sum = 0.05 + 0.3 + 0.8 + 1.5 + 3 + 7 + 20 + 45 + 100 = 177.65
    expect(output).toContain("test_histogram_sum 177.65");
    expect(output).toContain("test_histogram_count 9");
  });

  it("accepts custom bucket boundaries", () => {
    const h = new Histogram("custom_histogram", "Custom", [10, 50, 100]);
    h.observe(5);
    h.observe(25);
    h.observe(75);
    h.observe(150);

    const output = h.format();
    expect(output).toContain('custom_histogram_bucket{le="10"} 1');
    expect(output).toContain('custom_histogram_bucket{le="50"} 2');
    expect(output).toContain('custom_histogram_bucket{le="100"} 3');
    expect(output).toContain('custom_histogram_bucket{le="+Inf"} 4');
  });

  it("formats in Prometheus text format", () => {
    const h = new Histogram("test_histogram", "Test help");
    h.observe(1);
    const output = h.format();
    expect(output).toContain("# HELP test_histogram Test help");
    expect(output).toContain("# TYPE test_histogram histogram");
  });
});

describe("LabeledCounter", () => {
  it("starts at zero for all labels", () => {
    const c = new LabeledCounter("test_labeled", "Test help", ["link"]);
    expect(c.getValue({ link: "execute" })).toBe(0);
  });

  it("increments per label combination", () => {
    const c = new LabeledCounter("test_labeled", "Test help", ["link"]);
    c.inc({ link: "execute" });
    c.inc({ link: "execute" });
    c.inc({ link: "verify" });
    expect(c.getValue({ link: "execute" })).toBe(2);
    expect(c.getValue({ link: "verify" })).toBe(1);
  });

  it("supports multiple labels", () => {
    const c = new LabeledCounter("test_labeled", "Test help", ["link", "outcome"]);
    c.inc({ link: "execute", outcome: "success" });
    c.inc({ link: "execute", outcome: "failure" });
    expect(c.getValue({ link: "execute", outcome: "success" })).toBe(1);
    expect(c.getValue({ link: "execute", outcome: "failure" })).toBe(1);
  });

  it("increments by custom delta", () => {
    const c = new LabeledCounter("test_labeled", "Test help", ["link"]);
    c.inc({ link: "execute" }, 5);
    expect(c.getValue({ link: "execute" })).toBe(5);
  });

  it("formats in Prometheus text format with labels", () => {
    const c = new LabeledCounter("co_tasks_completed_total", "Total tasks completed", ["link", "outcome"]);
    c.inc({ link: "execute", outcome: "success" }, 3);
    c.inc({ link: "verify", outcome: "success" }, 2);
    const output = c.format();
    expect(output).toContain("# HELP co_tasks_completed_total Total tasks completed");
    expect(output).toContain("# TYPE co_tasks_completed_total counter");
    expect(output).toContain('co_tasks_completed_total{link="execute", outcome="success"} 3');
    expect(output).toContain('co_tasks_completed_total{link="verify", outcome="success"} 2');
  });

  it("getAll returns all label combinations", () => {
    const c = new LabeledCounter("test_labeled", "Test help", ["link"]);
    c.inc({ link: "execute" }, 3);
    c.inc({ link: "verify" }, 2);
    const all = c.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContainEqual({ labels: { link: "execute" }, value: 3 });
    expect(all).toContainEqual({ labels: { link: "verify" }, value: 2 });
  });
});

describe("MetricsCollector", () => {
  let collector: PrometheusMetricsCollector;

  beforeEach(() => {
    collector = new PrometheusMetricsCollector();
  });

  it("initializes all metrics at zero", () => {
    const snap = collector.snapshot();
    expect(snap.tasks.created).toBe(0);
    expect(snap.tasks.completed).toEqual([]);
    expect(snap.tasks.dispatched).toEqual([]);
    expect(snap.tasks.failed).toBe(0);
    expect(snap.chains.activated).toBe(0);
    expect(snap.workers.active).toBe(0);
    expect(snap.errors).toBe(0);
  });

  it("tracks architect-specified labeled task metrics", () => {
    collector.tasksDispatched.inc({ link: "execute" });
    collector.tasksDispatched.inc({ link: "execute" });
    collector.tasksDispatched.inc({ link: "verify" });
    collector.tasksCompleted.inc({ link: "execute", outcome: "success" });
    collector.tasksCompleted.inc({ link: "execute", outcome: "failure" });
    collector.taskDuration.observe(2.5);

    const snap = collector.snapshot();
    expect(snap.tasks.dispatched).toContainEqual({ labels: { link: "execute" }, value: 2 });
    expect(snap.tasks.dispatched).toContainEqual({ labels: { link: "verify" }, value: 1 });
    expect(snap.tasks.completed).toContainEqual({ labels: { link: "execute", outcome: "success" }, value: 1 });
    expect(snap.tasks.completed).toContainEqual({ labels: { link: "execute", outcome: "failure" }, value: 1 });
    expect(snap.tasks.duration.count).toBe(1);
    expect(snap.tasks.duration.sum).toBe(2.5);
  });

  it("tracks worker heartbeat seconds since", () => {
    collector.workerHeartbeatSecondsSince.set(45);
    const snap = collector.snapshot();
    expect(snap.workers.heartbeat_seconds_since).toBe(45);
  });

  it("formats architect-specified metrics in Prometheus format", () => {
    collector.tasksDispatched.inc({ link: "plan" });
    collector.tasksCompleted.inc({ link: "plan", outcome: "success" });

    const output = collector.format();
    expect(output).toContain('co_tasks_dispatched_total{link="plan"} 1');
    expect(output).toContain('co_tasks_completed_total{link="plan", outcome="success"} 1');
    expect(output).toContain("co_task_duration_seconds");
    expect(output).toContain("co_worker_heartbeat_seconds_since");
  });

  it("tracks task metrics", () => {
    collector.tasksCreated.inc(3);
    collector.tasksCompleted.inc({ link: "execute", outcome: "success" }, 2);
    collector.tasksFailed.inc(1);
    collector.taskDuration.observe(1.5);
    collector.taskDuration.observe(2.5);

    const snap = collector.snapshot();
    expect(snap.tasks.created).toBe(3);
    expect(snap.tasks.completed).toContainEqual({ labels: { link: "execute", outcome: "success" }, value: 2 });
    expect(snap.tasks.failed).toBe(1);
    expect(snap.tasks.duration.count).toBe(2);
    expect(snap.tasks.duration.sum).toBe(4);
  });

  it("tracks chain metrics", () => {
    collector.chainsActivated.inc(5);
    collector.chainsClosed.inc(3);
    collector.chainsFailed.inc(1);
    collector.activeChains.set(2);

    const snap = collector.snapshot();
    expect(snap.chains.activated).toBe(5);
    expect(snap.chains.closed).toBe(3);
    expect(snap.chains.failed).toBe(1);
    expect(snap.chains.active).toBe(2);
  });

  it("tracks worker metrics", () => {
    collector.workersJoined.inc(4);
    collector.workersLeft.inc(1);
    collector.activeWorkers.set(3);
    collector.workerHeartbeats.inc(100);

    const snap = collector.snapshot();
    expect(snap.workers.joined).toBe(4);
    expect(snap.workers.left).toBe(1);
    expect(snap.workers.active).toBe(3);
    expect(snap.workers.heartbeats).toBe(100);
  });

  it("tracks message metrics", () => {
    collector.messagesSent.inc(10);
    collector.messagesProcessed.inc(8);

    const snap = collector.snapshot();
    expect(snap.messages.sent).toBe(10);
    expect(snap.messages.processed).toBe(8);
  });

  it("tracks merge metrics", () => {
    collector.mergesSucceeded.inc(5);
    collector.mergesFailed.inc(2);
    collector.mergeDuration.observe(3.5);

    const snap = collector.snapshot();
    expect(snap.merges.succeeded).toBe(5);
    expect(snap.merges.failed).toBe(2);
    expect(snap.merges.duration.count).toBe(1);
    expect(snap.merges.duration.sum).toBe(3.5);
  });

  it("tracks error and recovery metrics", () => {
    collector.errorsTotal.inc(3);
    collector.recoveriesTotal.inc(2);

    const snap = collector.snapshot();
    expect(snap.errors).toBe(3);
    expect(snap.recoveries).toBe(2);
  });

  it("formats all metrics in Prometheus text format", () => {
    collector.tasksCreated.inc(5);
    collector.activeWorkers.set(3);

    const output = collector.format();
    expect(output).toContain("co_tasks_created_total 5");
    expect(output).toContain("co_active_workers 3");
    expect(output).toContain("co_process_uptime_seconds");
    expect(output).toContain("# HELP");
    expect(output).toContain("# TYPE");
  });

  it("reports uptime", () => {
    const snap = collector.snapshot();
    expect(snap.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(snap.uptime_seconds).toBeLessThan(5);
  });
});

describe("MetricsCollector — alerts", () => {
  it("fires alert when rule condition is met", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const collector = new PrometheusMetricsCollector({ logger });

    collector.addAlertRule({
      name: "high_error_rate",
      description: "Too many errors",
      check: () => collector.errorsTotal.getValue() > 10,
      severity: "critical",
    });

    // No alert yet
    collector.checkAlerts();
    expect(logger.error).not.toHaveBeenCalled();

    // Trigger alert
    collector.errorsTotal.inc(15);
    collector.checkAlerts();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("ALERT"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("high_error_rate"),
    );
  });

  it("fires warning alerts at warn level", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const collector = new PrometheusMetricsCollector({ logger });

    collector.addAlertRule({
      name: "high_pending",
      description: "Too many pending tasks",
      check: () => collector.pendingTasks.getValue() > 50,
      severity: "warning",
    });

    collector.pendingTasks.set(60);
    collector.checkAlerts();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ALERT"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("high_pending"),
    );
  });

  it("does not fire alert when condition is not met", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const collector = new PrometheusMetricsCollector({ logger });

    collector.addAlertRule({
      name: "test_alert",
      description: "Test",
      check: () => false,
      severity: "warning",
    });

    collector.checkAlerts();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("fires multiple alerts independently", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const collector = new PrometheusMetricsCollector({ logger });

    collector.addAlertRule({
      name: "alert_a",
      description: "A",
      check: () => true,
      severity: "warning",
    });
    collector.addAlertRule({
      name: "alert_b",
      description: "B",
      check: () => true,
      severity: "critical",
    });

    collector.checkAlerts();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
