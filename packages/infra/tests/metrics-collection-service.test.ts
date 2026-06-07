import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MetricsCollectionService } from "../src/metrics-collection-service.js";
import type { MetricSample } from "../src/metrics-collection-service.js";

function makeSample(overrides: Partial<MetricSample> = {}): MetricSample {
  return {
    name: "co_tasks_dispatched_total",
    value: 1,
    timestamp: Date.now(),
    source: "leader",
    ...overrides,
  };
}

describe("MetricsCollectionService", () => {
  let service: MetricsCollectionService;

  beforeEach(() => {
    service = new MetricsCollectionService({ retention_days: 30 });
  });

  afterEach(() => {
    service.stop();
  });

  describe("record", () => {
    it("stores a metric sample", () => {
      const sample = makeSample();
      service.record(sample);
      const names = service.getMetricNames();
      expect(names).toContain("co_tasks_dispatched_total");
    });

    it("accumulates multiple samples for the same metric", () => {
      service.record(makeSample({ value: 1 }));
      service.record(makeSample({ value: 2 }));
      service.record(makeSample({ value: 3 }));
      const samples = service.getRawSamples("co_tasks_dispatched_total");
      expect(samples).toHaveLength(3);
    });

    it("tracks different metrics separately", () => {
      service.record(makeSample({ name: "metric_a", value: 1 }));
      service.record(makeSample({ name: "metric_b", value: 2 }));
      const names = service.getMetricNames();
      expect(names).toContain("metric_a");
      expect(names).toContain("metric_b");
      expect(names).toHaveLength(2);
    });

    it("evicts oldest samples when over max_samples", () => {
      const svc = new MetricsCollectionService({ max_samples: 5 });
      for (let i = 0; i < 10; i++) {
        svc.record(makeSample({ value: i, timestamp: Date.now() - (10 - i) * 1000 }));
      }
      const samples = svc.getRawSamples("co_tasks_dispatched_total");
      expect(samples).toHaveLength(5);
      // Should keep the 5 most recent
      expect(samples[0].value).toBe(5);
      expect(samples[4].value).toBe(9);
    });
  });

  describe("registerMetric", () => {
    it("stores metric metadata", () => {
      service.registerMetric("my_metric", "My help text", "gauge");
      // Metadata is used by toPrometheus, so we verify via that
      service.record(makeSample({ name: "my_metric", value: 42 }));
      const prom = service.toPrometheus();
      expect(prom).toContain("# HELP my_metric My help text");
      expect(prom).toContain("# TYPE my_metric gauge");
      expect(prom).toContain("my_metric 42");
    });
  });

  describe("getAggregated", () => {
    it("returns empty array when no samples exist", () => {
      const result = service.getAggregated("nonexistent", "1m");
      expect(result).toEqual([]);
    });

    it("aggregates samples into 1-minute windows", () => {
      const now = Date.now();
      service.record(makeSample({ value: 10, timestamp: now - 30_000 }));
      service.record(makeSample({ value: 20, timestamp: now - 20_000 }));
      service.record(makeSample({ value: 30, timestamp: now - 10_000 }));

      const result = service.getAggregated("co_tasks_dispatched_total", "1m");
      expect(result.length).toBeGreaterThanOrEqual(1);
      // All three samples fall in the same 1-minute window
      const window = result.find((w) => w.sample_count === 3);
      expect(window).toBeDefined();
      expect(window!.value).toBe(20); // average of 10, 20, 30
    });

    it("separates samples into different 5-minute windows", () => {
      const now = Date.now();
      // Window 1: 10 minutes ago
      service.record(makeSample({ value: 100, timestamp: now - 600_000 }));
      // Window 2: 5 minutes ago
      service.record(makeSample({ value: 200, timestamp: now - 300_000 }));

      const result = service.getAggregated("co_tasks_dispatched_total", "5m");
      expect(result).toHaveLength(2);
      // Windows should be in chronological order
      expect(result[0].value).toBe(100);
      expect(result[1].value).toBe(200);
    });

    it("computes 1-hour aggregations", () => {
      const now = Date.now();
      // Sample 1: ~2 hours ago (in a previous 1h window)
      service.record(makeSample({ value: 10, timestamp: now - 7_200_000 + 1000 }));
      // Sample 2: now (in the current 1h window)
      service.record(makeSample({ value: 20, timestamp: now - 1000 }));

      const result = service.getAggregated("co_tasks_dispatched_total", "1h");
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it("merges labels from samples in same window", () => {
      const now = Date.now();
      service.record(makeSample({ value: 1, timestamp: now - 5000, labels: { link: "execute" } }));
      service.record(makeSample({ value: 2, timestamp: now - 3000, labels: { link: "verify" } }));

      const result = service.getAggregated("co_tasks_dispatched_total", "1m");
      expect(result.length).toBeGreaterThanOrEqual(1);
      const window = result.find((w) => w.sample_count === 2);
      expect(window).toBeDefined();
      expect(window!.labels).toBeDefined();
    });

    it("caches aggregation results", () => {
      const now = Date.now();
      service.record(makeSample({ value: 42, timestamp: now - 1000 }));

      const result1 = service.getAggregated("co_tasks_dispatched_total", "1m");
      const result2 = service.getAggregated("co_tasks_dispatched_total", "1m");
      // Same reference means cached
      expect(result1).toBe(result2);
    });

    it("invalidates cache when new samples are recorded", () => {
      const now = Date.now();
      service.record(makeSample({ value: 10, timestamp: now - 1000 }));

      const result1 = service.getAggregated("co_tasks_dispatched_total", "1m");
      service.record(makeSample({ value: 20, timestamp: now - 500 }));
      const result2 = service.getAggregated("co_tasks_dispatched_total", "1m");

      // Different results because cache was invalidated
      expect(result1).not.toBe(result2);
      expect(result2.length).toBeGreaterThanOrEqual(result1.length);
    });
  });

  describe("getLatest", () => {
    it("returns null when no samples exist", () => {
      expect(service.getLatest("nonexistent")).toBeNull();
    });

    it("returns the latest aggregated metric", () => {
      const now = Date.now();
      service.record(makeSample({ value: 10, timestamp: now - 50_000 }));
      service.record(makeSample({ value: 20, timestamp: now - 10_000 }));

      const latest = service.getLatest("co_tasks_dispatched_total", "1m");
      expect(latest).not.toBeNull();
      expect(latest!.sample_count).toBeGreaterThanOrEqual(1);
    });
  });

  describe("getRawSamples", () => {
    it("returns all samples when no range specified", () => {
      service.record(makeSample({ value: 1 }));
      service.record(makeSample({ value: 2 }));
      const samples = service.getRawSamples("co_tasks_dispatched_total");
      expect(samples).toHaveLength(2);
    });

    it("filters by time range", () => {
      const now = Date.now();
      service.record(makeSample({ value: 1, timestamp: now - 100_000 }));
      service.record(makeSample({ value: 2, timestamp: now - 50_000 }));
      service.record(makeSample({ value: 3, timestamp: now - 10_000 }));

      // from=now-60s, to=now-40s => only sample at now-50s falls in range
      const samples = service.getRawSamples(
        "co_tasks_dispatched_total",
        now - 60_000,
        now - 40_000,
      );
      expect(samples).toHaveLength(1);
      expect(samples[0].value).toBe(2);
    });

    it("returns empty array for nonexistent metric", () => {
      expect(service.getRawSamples("nonexistent")).toEqual([]);
    });
  });

  describe("toPrometheus", () => {
    it("returns empty string when no metrics registered", () => {
      expect(service.toPrometheus()).toBe("");
    });

    it("exports registered metrics with latest values", () => {
      service.registerMetric("co_tasks_total", "Total tasks", "counter");
      service.record(makeSample({ name: "co_tasks_total", value: 42 }));
      service.record(makeSample({ name: "co_tasks_total", value: 43 }));

      const prom = service.toPrometheus();
      expect(prom).toContain("# HELP co_tasks_total Total tasks");
      expect(prom).toContain("# TYPE co_tasks_total counter");
      expect(prom).toContain("co_tasks_total 43"); // latest value
    });

    it("includes labels in Prometheus output", () => {
      service.registerMetric("co_tasks_by_link", "Tasks by link", "counter");
      service.record(
        makeSample({ name: "co_tasks_by_link", value: 5, labels: { link: "execute" } }),
      );

      const prom = service.toPrometheus();
      expect(prom).toContain('co_tasks_by_link{link="execute"} 5');
    });

    it("handles multiple metrics", () => {
      service.registerMetric("metric_a", "Help A", "gauge");
      service.registerMetric("metric_b", "Help B", "counter");
      service.record(makeSample({ name: "metric_a", value: 1 }));
      service.record(makeSample({ name: "metric_b", value: 2 }));

      const prom = service.toPrometheus();
      expect(prom).toContain("metric_a 1");
      expect(prom).toContain("metric_b 2");
    });

    it("skips metrics with no samples", () => {
      service.registerMetric("empty_metric", "Empty", "gauge");
      const prom = service.toPrometheus();
      expect(prom).not.toContain("empty_metric");
    });
  });

  describe("cleanup", () => {
    it("removes samples older than retention period", () => {
      const old_time = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
      const recent_time = Date.now() - 1000;

      service.record(makeSample({ value: 1, timestamp: old_time }));
      service.record(makeSample({ value: 2, timestamp: recent_time }));

      service.cleanup();

      const samples = service.getRawSamples("co_tasks_dispatched_total");
      expect(samples).toHaveLength(1);
      expect(samples[0].value).toBe(2);
    });

    it("removes empty metric entries after cleanup", () => {
      const old_time = Date.now() - 31 * 24 * 60 * 60 * 1000;
      service.record(makeSample({ value: 1, timestamp: old_time }));

      service.cleanup();

      expect(service.getMetricNames()).not.toContain("co_tasks_dispatched_total");
    });

    it("clears aggregation cache after cleanup", () => {
      const now = Date.now();
      service.record(makeSample({ value: 10, timestamp: now - 1000 }));
      service.getAggregated("co_tasks_dispatched_total", "1m"); // populate cache

      service.cleanup();

      const stats = service.getStats();
      expect(stats.aggregated_cache_size).toBe(0);
    });
  });

  describe("start/stop", () => {
    it("starts and stops without errors", () => {
      service.start();
      service.stop();
    });

    it("runs cleanup periodically", () => {
      vi.useFakeTimers();
      const svc = new MetricsCollectionService({ retention_days: 30 });
      const cleanup_spy = vi.spyOn(svc, "cleanup");

      svc.start();

      // Advance 5 minutes (cleanup interval)
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(cleanup_spy).toHaveBeenCalledTimes(1);

      // Advance another 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(cleanup_spy).toHaveBeenCalledTimes(2);

      svc.stop();
      vi.useRealTimers();
    });
  });

  describe("getStats", () => {
    it("returns correct statistics", () => {
      service.record(makeSample({ name: "metric_a", value: 1 }));
      service.record(makeSample({ name: "metric_a", value: 2 }));
      service.record(makeSample({ name: "metric_b", value: 3 }));

      const stats = service.getStats();
      expect(stats.metric_count).toBe(2);
      expect(stats.total_samples).toBe(3);
      expect(stats.aggregated_cache_size).toBe(0);
    });
  });

  describe("retention configuration", () => {
    it("respects custom retention period", () => {
      const svc = new MetricsCollectionService({ retention_days: 7 });
      const now = Date.now();
      const eight_days_ago = now - 8 * 24 * 60 * 60 * 1000;
      const six_days_ago = now - 6 * 24 * 60 * 60 * 1000;

      svc.record(makeSample({ value: 1, timestamp: eight_days_ago }));
      svc.record(makeSample({ value: 2, timestamp: six_days_ago }));

      svc.cleanup();

      const samples = svc.getRawSamples("co_tasks_dispatched_total");
      expect(samples).toHaveLength(1);
      expect(samples[0].value).toBe(2);
    });
  });
});
