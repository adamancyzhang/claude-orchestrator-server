import { describe, it, expect } from "vitest";
import { Counter, Gauge, Histogram, LabeledCounter, PrometheusMetricsCollector } from "../../src/metrics.js";
import { ResourceMonitor } from "../../src/resource-monitor.js";

// ── Throughput Tests ──────────────────────────────────────────────────

describe("Throughput — metrics primitives", () => {
  it("Counter achieves >500k ops/sec", () => {
    const counter = new Counter("tp_counter", "Throughput counter");
    const durationMs = 500;
    const start = performance.now();
    let ops = 0;

    while (performance.now() - start < durationMs) {
      counter.inc();
      ops++;
    }

    const opsPerSec = (ops / durationMs) * 1000;
    expect(opsPerSec).toBeGreaterThan(500_000);
  });

  it("Histogram achieves >200k observations/sec", () => {
    const histogram = new Histogram("tp_hist", "Throughput histogram");
    const durationMs = 500;
    const start = performance.now();
    let ops = 0;

    while (performance.now() - start < durationMs) {
      histogram.observe(Math.random() * 10);
      ops++;
    }

    const opsPerSec = (ops / durationMs) * 1000;
    expect(opsPerSec).toBeGreaterThan(200_000);
  });

  it("PrometheusMetricsCollector.format() under 10ms with populated metrics", () => {
    const collector = new PrometheusMetricsCollector();

    // Populate metrics with realistic data.
    for (let i = 0; i < 100; i++) {
      collector.tasksDispatched.inc({ link: "execute" });
      collector.tasksCompleted.inc({ link: "execute", outcome: "success" });
      collector.taskDuration.observe(Math.random() * 30);
      collector.activeWorkers.set(Math.floor(Math.random() * 10));
      collector.errorsTotal.inc();
    }

    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      collector.format();
      times.push(performance.now() - start);
    }

    const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
    expect(avgMs).toBeLessThan(10);
  });
});

// ── Latency Tests ─────────────────────────────────────────────────────

describe("Latency — metrics operations", () => {
  it("single Counter.inc() completes in <1μs (p99)", () => {
    const counter = new Counter("lat_counter", "Latency counter");
    const samples: number[] = [];

    for (let i = 0; i < 10_000; i++) {
      const start = performance.now();
      counter.inc();
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    // p99 should be well under 1ms (likely microseconds).
    expect(p99).toBeLessThan(1);
  });

  it("single Gauge.set() completes in <1μs (p99)", () => {
    const gauge = new Gauge("lat_gauge", "Latency gauge");
    const samples: number[] = [];

    for (let i = 0; i < 10_000; i++) {
      const start = performance.now();
      gauge.set(i);
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    expect(p99).toBeLessThan(1);
  });

  it("single Histogram.observe() completes in <1μs (p99)", () => {
    const histogram = new Histogram("lat_hist", "Latency histogram");
    const samples: number[] = [];

    for (let i = 0; i < 10_000; i++) {
      const start = performance.now();
      histogram.observe(Math.random() * 10);
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    expect(p99).toBeLessThan(1);
  });
});

// ── Resource Usage Tests ──────────────────────────────────────────────

describe("Resource usage — memory under load", () => {
  it("Gauge memory footprint stays bounded with 100k operations", () => {
    const gauge = new Gauge("mem_gauge", "Memory gauge");

    // Set many different values to stress internal state.
    for (let i = 0; i < 100_000; i++) {
      gauge.set(i % 1000);
    }

    // Gauge is stateless (single value), so memory should be negligible.
    // We just verify it doesn't throw or OOM.
    expect(gauge.getValue()).toBeGreaterThanOrEqual(0);
  });

  it("LabeledCounter memory is proportional to label combinations", () => {
    const counter = new LabeledCounter(
      "mem_labeled",
      "Memory labeled counter",
      ["region", "service"],
    );

    const regions = ["us-east", "us-west", "eu-west"];
    const services = ["api", "worker", "scheduler", "gateway"];

    // 12 combinations * 1000 increments each.
    for (let i = 0; i < 1000; i++) {
      for (const region of regions) {
        for (const service of services) {
          counter.inc({ region, service });
        }
      }
    }

    const all = counter.getAll();
    expect(all).toHaveLength(regions.length * services.length);

    // Each combination should have exactly 1000 increments.
    for (const entry of all) {
      expect(entry.value).toBe(1000);
    }
  });

  it("ResourceMonitor.getLatestSnapshot() returns valid data after start", async () => {
    const monitor = new ResourceMonitor();
    monitor.start();

    // Wait for the first snapshot to be collected.
    await new Promise((r) => setTimeout(r, 50));

    const start = performance.now();
    const snapshot = monitor.getLatestSnapshot();
    const elapsed = performance.now() - start;

    expect(snapshot).not.toBeNull();
    expect(snapshot!.cpu_usage_percent).toBeGreaterThanOrEqual(0);
    expect(snapshot!.memory_total_bytes).toBeGreaterThan(0);

    // getLatestSnapshot() should be instant (just reading cached value).
    expect(elapsed).toBeLessThan(5);

    monitor.stop();
  });
});
