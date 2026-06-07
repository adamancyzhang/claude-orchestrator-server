import { describe, it, expect } from "vitest";
import { Counter, Gauge, Histogram, LabeledCounter } from "../../src/metrics.js";
import { MessageBatcher } from "../../src/message-batcher.js";

// ── Helpers ───────────────────────────────────────────────────────────

function timeIt(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

async function timeItAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

// ── Metrics Benchmarks ────────────────────────────────────────────────

describe("Benchmark — Metrics primitives", () => {
  it("Counter: 10k increments under 50ms", () => {
    const counter = new Counter("bench_counter", "Benchmark counter");
    const elapsed = timeIt(() => {
      for (let i = 0; i < 10_000; i++) counter.inc();
    });
    expect(counter.getValue()).toBe(10_000);
    expect(elapsed).toBeLessThan(50);
  });

  it("Gauge: 10k set/inc/dec under 50ms", () => {
    const gauge = new Gauge("bench_gauge", "Benchmark gauge");
    const elapsed = timeIt(() => {
      for (let i = 0; i < 10_000; i++) {
        gauge.set(i);
        gauge.inc();
        gauge.dec();
      }
    });
    // set() overwrites; inc/dec cancel. Final value = last set = 9999.
    expect(gauge.getValue()).toBe(9_999);
    expect(elapsed).toBeLessThan(50);
  });

  it("Histogram: 10k observations under 50ms", () => {
    const histogram = new Histogram("bench_histogram", "Benchmark histogram");
    const elapsed = timeIt(() => {
      for (let i = 0; i < 10_000; i++) {
        histogram.observe(Math.random() * 30);
      }
    });
    expect(histogram.getValue().count).toBe(10_000);
    expect(elapsed).toBeLessThan(50);
  });

  it("LabeledCounter: 10k labeled increments under 100ms", () => {
    const counter = new LabeledCounter(
      "bench_labeled",
      "Benchmark labeled counter",
      ["link", "outcome"],
    );
    const labels = ["execute", "plan", "review"];
    const outcomes = ["success", "failure"];

    const elapsed = timeIt(() => {
      for (let i = 0; i < 10_000; i++) {
        counter.inc({
          link: labels[i % labels.length],
          outcome: outcomes[i % outcomes.length],
        });
      }
    });

    expect(elapsed).toBeLessThan(100);
    const all = counter.getAll();
    expect(all.length).toBeGreaterThan(0);
  });

  it("Counter.format() produces valid Prometheus output under 10ms for 100 calls", () => {
    const counter = new Counter("bench_fmt", "Format benchmark");
    counter.inc(42);

    const elapsed = timeIt(() => {
      for (let i = 0; i < 100; i++) counter.format();
    });

    expect(elapsed).toBeLessThan(10);
    expect(counter.format()).toContain("bench_fmt 42");
  });
});

// ── MessageBatcher Benchmarks ─────────────────────────────────────────

describe("Benchmark — MessageBatcher throughput", () => {
  it("processes 10k messages through batcher under 2s", async () => {
    const MESSAGE_COUNT = 10_000;
    let processed = 0;

    const batcher = new MessageBatcher<{ seq: number }>({
      batch_size: 100,
      batch_timeout_ms: 50,
    });

    batcher.start(async (batch) => {
      processed += batch.messages.length;
      return true;
    });

    const elapsed = await timeItAsync(async () => {
      for (let i = 0; i < MESSAGE_COUNT; i++) {
        batcher.add({ id: `b-${i}`, payload: { seq: i } });
      }
      // Wait for all flushes.
      await new Promise((r) => setTimeout(r, 500));
    });

    await batcher.stop();
    expect(processed).toBe(MESSAGE_COUNT);
    expect(elapsed).toBeLessThan(2000);
  });

  it("small batch size achieves low latency per message", async () => {
    const batcher = new MessageBatcher<{ t: number }>({
      batch_size: 1,
      batch_timeout_ms: 10,
    });

    const latencies: number[] = [];

    batcher.start(async () => {
      return true;
    });

    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      batcher.add({ id: `lat-${i}`, payload: { t: start } });
      // With batch_size=1, flush should happen immediately.
      await new Promise((r) => setTimeout(r, 2));
      latencies.push(performance.now() - start);
    }

    await batcher.stop();

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    // Average latency should be well under 50ms with batch_size=1.
    expect(avgLatency).toBeLessThan(50);
  });
});
