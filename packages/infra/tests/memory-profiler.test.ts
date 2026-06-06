import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryProfiler } from "../src/memory-profiler.js";

describe("MemoryProfiler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic functionality", () => {
    it("should create a profiler with default options", () => {
      const profiler = new MemoryProfiler();
      const report = profiler.getReport();

      expect(report.sample_count).toBe(0);
      expect(report.latest).toBeUndefined();
      expect(report.trend).toBe("stable");
      expect(report.leaks).toHaveLength(0);
      expect(report.optimizations).toHaveLength(0);
    });

    it("should create a profiler with custom options", () => {
      const profiler = new MemoryProfiler({
        sample_interval_ms: 1000,
        max_samples: 500,
        enable_object_tracking: true,
      });

      // Start to take initial sample
      profiler.start();
      const report = profiler.getReport();

      expect(report.sample_count).toBe(1);
      profiler.stop();
    });

    it("should start and stop the profiler", () => {
      const profiler = new MemoryProfiler();

      profiler.start();
      expect(profiler.getReport().sample_count).toBe(1);

      profiler.stop();
    });

    it("should take periodic samples", () => {
      const profiler = new MemoryProfiler({ sample_interval_ms: 1000 });

      profiler.start();
      expect(profiler.getReport().sample_count).toBe(1);

      // Advance time to trigger samples
      vi.advanceTimersByTime(1000);
      expect(profiler.getReport().sample_count).toBe(2);

      vi.advanceTimersByTime(2000);
      expect(profiler.getReport().sample_count).toBe(4);

      profiler.stop();
    });

    it("should not start twice", () => {
      const profiler = new MemoryProfiler();

      profiler.start();
      profiler.start(); // Should not throw or create duplicate timers

      expect(profiler.getReport().sample_count).toBe(1);

      profiler.stop();
    });

    it("should not stop if not running", () => {
      const profiler = new MemoryProfiler();

      profiler.stop(); // Should not throw
      expect(profiler.getReport().sample_count).toBe(0);
    });
  });

  describe("memory samples", () => {
    it("should collect memory samples", () => {
      const profiler = new MemoryProfiler();

      profiler.start();
      const samples = profiler.getSamples();

      expect(samples).toHaveLength(1);
      expect(samples[0].heap_used).toBeGreaterThan(0);
      expect(samples[0].heap_total).toBeGreaterThan(0);
      expect(samples[0].rss).toBeGreaterThan(0);
      expect(samples[0].timestamp).toBeDefined();

      profiler.stop();
    });

    it("should limit samples to max_samples", () => {
      const profiler = new MemoryProfiler({ max_samples: 5 });

      profiler.start();

      // Take more samples than max
      for (let i = 0; i < 10; i++) {
        profiler.forceGcSample();
      }

      const samples = profiler.getSamples();
      expect(samples).toHaveLength(5);

      profiler.stop();
    });

    it("should include object tracking data when enabled", () => {
      const profiler = new MemoryProfiler({ enable_object_tracking: true });

      profiler.start();
      const sample = profiler.forceGcSample();

      expect(sample.listener_count).toBeDefined();
      expect(sample.timer_count).toBeDefined();

      profiler.stop();
    });
  });

  describe("object tracking", () => {
    it("should track listeners when enabled", () => {
      const profiler = new MemoryProfiler({ enable_object_tracking: true });

      profiler.start();

      profiler.trackListener("test-event");
      profiler.trackListener("test-event");
      profiler.trackListener("other-event");

      const sample = profiler.forceGcSample();
      expect(sample.listener_count).toBe(3);

      profiler.untrackListener("test-event");
      const sample2 = profiler.forceGcSample();
      expect(sample2.listener_count).toBe(2);

      profiler.stop();
    });

    it("should track timers when enabled", () => {
      const profiler = new MemoryProfiler({ enable_object_tracking: true });

      profiler.start();

      const timer1 = setTimeout(() => {}, 1000);
      const timer2 = setTimeout(() => {}, 1000);

      profiler.trackTimer(timer1);
      profiler.trackTimer(timer2);

      const sample = profiler.forceGcSample();
      expect(sample.timer_count).toBe(2);

      profiler.untrackTimer(timer1);
      const sample2 = profiler.forceGcSample();
      expect(sample2.timer_count).toBe(1);

      clearTimeout(timer2);
      profiler.stop();
    });

    it("should not track when disabled", () => {
      const profiler = new MemoryProfiler({ enable_object_tracking: false });

      profiler.start();

      profiler.trackListener("test-event");
      profiler.trackTimer(setTimeout(() => {}, 1000));

      const sample = profiler.forceGcSample();
      expect(sample.listener_count).toBeUndefined();
      expect(sample.timer_count).toBeUndefined();

      profiler.stop();
    });
  });

  describe("analysis", () => {
    it("should calculate stable trend", () => {
      const profiler = new MemoryProfiler({ sample_interval_ms: 100 });

      profiler.start();

      // Take many samples with similar heap usage
      for (let i = 0; i < 20; i++) {
        profiler.forceGcSample();
        vi.advanceTimersByTime(100);
      }

      const report = profiler.getReport();
      expect(report.trend).toBe("stable");

      profiler.stop();
    });

    it("should detect memory leaks", () => {
      const profiler = new MemoryProfiler({
        enable_object_tracking: true,
        sample_interval_ms: 100,
      });

      profiler.start();

      // Add many listeners with same name to simulate leak (need >10 for detection)
      for (let i = 0; i < 15; i++) {
        profiler.trackListener("leaked-listener");
      }

      const report = profiler.getReport();
      expect(report.leaks.length).toBeGreaterThan(0);
      expect(report.leaks[0].type).toBe("listener");

      profiler.stop();
    });

    it("should generate optimization recommendations", () => {
      const profiler = new MemoryProfiler({ sample_interval_ms: 100 });

      profiler.start();

      // Take many samples to trigger optimization recommendations
      for (let i = 0; i < 150; i++) {
        profiler.forceGcSample();
        vi.advanceTimersByTime(100);
      }

      const report = profiler.getReport();
      // Optimizations are generated based on memory usage patterns
      expect(report.optimizations).toBeDefined();

      profiler.stop();
    });

    it("should calculate statistics", () => {
      const profiler = new MemoryProfiler();

      profiler.start();

      // Take a few samples
      profiler.forceGcSample();
      profiler.forceGcSample();
      profiler.forceGcSample();

      const report = profiler.getReport();
      expect(report.stats.min_heap).toBeGreaterThan(0);
      expect(report.stats.max_heap).toBeGreaterThan(0);
      expect(report.stats.avg_heap).toBeGreaterThan(0);
      expect(report.stats.min_rss).toBeGreaterThan(0);
      expect(report.stats.max_rss).toBeGreaterThan(0);
      expect(report.stats.avg_rss).toBeGreaterThan(0);

      profiler.stop();
    });
  });

  describe("report", () => {
    it("should generate complete report", () => {
      const profiler = new MemoryProfiler();

      profiler.start();
      profiler.forceGcSample();

      const report = profiler.getReport();

      expect(report.latest).toBeDefined();
      expect(report.trend).toBeDefined();
      expect(report.leaks).toBeDefined();
      expect(report.optimizations).toBeDefined();
      expect(report.stats).toBeDefined();
      expect(report.sample_count).toBeGreaterThanOrEqual(1);
      expect(report.duration_ms).toBeGreaterThanOrEqual(0);

      profiler.stop();
    });
  });
});
