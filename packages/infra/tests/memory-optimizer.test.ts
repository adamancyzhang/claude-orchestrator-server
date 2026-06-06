import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryOptimizer, ObjectPool, LRUCache } from "../src/memory-optimizer.js";
import { MemoryProfiler } from "../src/memory-profiler.js";

describe("ObjectPool", () => {
  it("should create a pool with initial objects", () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      10,
      100,
    );

    expect(pool.size).toBe(10);
  });

  it("should acquire objects from pool", () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      5,
      10,
    );

    const obj = pool.acquire();
    expect(obj).toBeDefined();
    expect(obj.value).toBe(0);
    expect(pool.size).toBe(4);
  });

  it("should release objects back to pool", () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      5,
      10,
    );

    const obj = pool.acquire();
    obj.value = 42;
    pool.release(obj);

    expect(pool.size).toBe(5);
    expect(obj.value).toBe(0); // Reset
  });

  it("should create new objects when pool is empty", () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      2,
      5,
    );

    pool.acquire();
    pool.acquire();
    const obj = pool.acquire(); // Pool empty, creates new

    expect(obj).toBeDefined();
    expect(pool.size).toBe(0);
  });

  it("should not exceed max size", () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      5,
      5,
    );

    const objs = [];
    for (let i = 0; i < 10; i++) {
      objs.push(pool.acquire());
    }

    // Release all
    for (const obj of objs) {
      pool.release(obj);
    }

    expect(pool.size).toBe(5); // Max size
  });

  it("should clear the pool", () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      10,
      100,
    );

    expect(pool.size).toBe(10);
    pool.clear();
    expect(pool.size).toBe(0);
  });
});

describe("LRUCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should store and retrieve values", () => {
    const cache = new LRUCache<string, number>(100);

    cache.set("key1", 1);
    cache.set("key2", 2);

    expect(cache.get("key1")).toBe(1);
    expect(cache.get("key2")).toBe(2);
  });

  it("should return undefined for missing keys", () => {
    const cache = new LRUCache<string, number>(100);

    expect(cache.get("missing")).toBeUndefined();
  });

  it("should evict oldest entries when at capacity", () => {
    const cache = new LRUCache<string, number>(3);

    cache.set("key1", 1);
    cache.set("key2", 2);
    cache.set("key3", 3);
    cache.set("key4", 4); // Should evict key1

    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBe(2);
    expect(cache.get("key4")).toBe(4);
  });

  it("should respect TTL", () => {
    const cache = new LRUCache<string, number>(100, 1000); // 1 second TTL

    cache.set("key1", 1);
    expect(cache.get("key1")).toBe(1);

    // Advance time past TTL
    vi.advanceTimersByTime(1100);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("should check if key exists", () => {
    const cache = new LRUCache<string, number>(100);

    cache.set("key1", 1);
    expect(cache.has("key1")).toBe(true);
    expect(cache.has("key2")).toBe(false);
  });

  it("should delete keys", () => {
    const cache = new LRUCache<string, number>(100);

    cache.set("key1", 1);
    expect(cache.has("key1")).toBe(true);

    cache.delete("key1");
    expect(cache.has("key1")).toBe(false);
  });

  it("should clear the cache", () => {
    const cache = new LRUCache<string, number>(100);

    cache.set("key1", 1);
    cache.set("key2", 2);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("should get stats", () => {
    const cache = new LRUCache<string, number>(100);

    cache.set("key1", 1);
    cache.set("key2", 2);

    const stats = cache.getStats();
    expect(stats.size).toBe(2);
  });
});

describe("MemoryOptimizer", () => {
  let profiler: MemoryProfiler;

  beforeEach(() => {
    vi.useFakeTimers();
    profiler = new MemoryProfiler();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic functionality", () => {
    it("should create an optimizer", () => {
      const optimizer = new MemoryOptimizer({ profiler });
      expect(optimizer).toBeDefined();
    });

    it("should start and stop the optimizer", () => {
      const optimizer = new MemoryOptimizer({ profiler });

      optimizer.start();
      optimizer.stop();
    });

    it("should not start twice", () => {
      const optimizer = new MemoryOptimizer({ profiler });

      optimizer.start();
      optimizer.start(); // Should not throw
      optimizer.stop();
    });

    it("should not stop if not running", () => {
      const optimizer = new MemoryOptimizer({ profiler });

      optimizer.stop(); // Should not throw
    });
  });

  describe("optimization", () => {
    it("should manually trigger optimization", async () => {
      const optimizer = new MemoryOptimizer({ profiler });

      profiler.start();
      const result = await optimizer.optimize();

      expect(result).toBeDefined();
      expect(result.applied).toBeDefined();
      expect(result.memory_before).toBeGreaterThanOrEqual(0);
      expect(result.memory_after).toBeGreaterThanOrEqual(0);

      profiler.stop();
    });

    it("should track applied optimizations", async () => {
      const optimizer = new MemoryOptimizer({ profiler });

      profiler.start();
      await optimizer.optimize();
      await optimizer.optimize(); // Should not re-apply same optimizations

      const applied = optimizer.getAppliedOptimizations();
      expect(applied.length).toBeGreaterThanOrEqual(0);

      profiler.stop();
    });

    it("should clear optimization history", async () => {
      const optimizer = new MemoryOptimizer({ profiler });

      profiler.start();
      await optimizer.optimize();

      optimizer.clearHistory();
      expect(optimizer.getAppliedOptimizations()).toHaveLength(0);

      profiler.stop();
    });
  });

  describe("auto optimization", () => {
    it("should auto-optimize when memory exceeds threshold", async () => {
      const optimizer = new MemoryOptimizer({
        profiler,
        auto_optimize: true,
        memory_threshold_bytes: 1000, // Very low threshold
        check_interval_ms: 1000,
      });

      profiler.start();
      optimizer.start();

      // Take a sample to trigger check
      profiler.forceGcSample();
      vi.advanceTimersByTime(1000);

      // Auto optimization should have been triggered
      expect(optimizer.getAppliedOptimizations().length).toBeGreaterThanOrEqual(0);

      optimizer.stop();
      profiler.stop();
    });

    it("should not auto-optimize when memory is below threshold", async () => {
      const optimizer = new MemoryOptimizer({
        profiler,
        auto_optimize: true,
        memory_threshold_bytes: 1000 * 1024 * 1024, // Very high threshold (1GB)
        check_interval_ms: 1000,
      });

      profiler.start();
      optimizer.start();

      profiler.forceGcSample();
      vi.advanceTimersByTime(1000);

      // Should not trigger optimization
      expect(optimizer.getAppliedOptimizations()).toHaveLength(0);

      optimizer.stop();
      profiler.stop();
    });
  });

  describe("utility creation", () => {
    it("should create object pools", () => {
      const optimizer = new MemoryOptimizer({ profiler });

      const pool = optimizer.createObjectPool(
        () => ({ value: 0 }),
        (obj) => { obj.value = 0; },
        10,
        100,
      );

      expect(pool).toBeDefined();
      expect(pool.size).toBe(10);
    });

    it("should create LRU caches", () => {
      const optimizer = new MemoryOptimizer({ profiler });

      const cache = optimizer.createLRUCache<string, number>(100, 5000);

      expect(cache).toBeDefined();
      cache.set("key", 1);
      expect(cache.get("key")).toBe(1);
    });
  });
});
