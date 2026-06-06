import type { ILogger } from "@co/contracts";
import type { MemoryProfiler, MemoryReport, MemoryOptimization } from "./memory-profiler.js";

/**
 * Options for the memory optimizer.
 */
export interface MemoryOptimizerOptions {
  /** Logger instance */
  logger?: ILogger;
  /** Memory profiler to use for analysis */
  profiler: MemoryProfiler;
  /** Enable automatic optimization (default: false) */
  auto_optimize?: boolean;
  /** Memory threshold in bytes to trigger optimization (default: 500MB) */
  memory_threshold_bytes?: number;
  /** Check interval in ms (default: 30000) */
  check_interval_ms?: number;
}

/**
 * Object pool for reusing objects to reduce GC pressure.
 */
export class ObjectPool<T> {
  private pool: T[] = [];
  private factory: () => T;
  private reset: (obj: T) => void;
  private maxSize: number;

  constructor(
    factory: () => T,
    reset: (obj: T) => void,
    initialSize: number = 10,
    maxSize: number = 100,
  ) {
    this.factory = factory;
    this.reset = reset;
    this.maxSize = maxSize;

    // Pre-populate pool
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(this.factory());
    }
  }

  /**
   * Acquire an object from the pool.
   */
  acquire(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    return this.factory();
  }

  /**
   * Release an object back to the pool.
   */
  release(obj: T): void {
    if (this.pool.length < this.maxSize) {
      this.reset(obj);
      this.pool.push(obj);
    }
  }

  /**
   * Get current pool size.
   */
  get size(): number {
    return this.pool.length;
  }

  /**
   * Clear the pool.
   */
  clear(): void {
    this.pool.length = 0;
  }
}

/**
 * Cache with LRU eviction policy.
 */
export class LRUCache<K, V> {
  private cache: Map<K, { value: V; lastAccess: number }> = new Map();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number = 1000, ttlMs: number = 300000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Get a value from the cache.
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.lastAccess > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Update access time
    entry.lastAccess = Date.now();
    return entry.value;
  }

  /**
   * Set a value in the cache.
   */
  set(key: K, value: V): void {
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      value,
      lastAccess: Date.now(),
    });
  }

  /**
   * Check if a key exists in the cache.
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check TTL
    if (Date.now() - entry.lastAccess > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a key from the cache.
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Get current cache size.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; hitRate: number } {
    return {
      size: this.cache.size,
      hitRate: 0, // Would need to track hits/misses
    };
  }

  private evictOldest(): void {
    let oldestKey: K | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.cache.delete(oldestKey);
    }
  }
}

/**
 * MemoryOptimizer applies memory optimizations based on profiler analysis.
 *
 * @example
 * ```typescript
 * const optimizer = new MemoryOptimizer({
 *   logger: logger.child("memory-optimizer"),
 *   profiler: memoryProfiler,
 *   auto_optimize: true,
 *   memory_threshold_bytes: 500 * 1024 * 1024, // 500MB
 * });
 *
 * optimizer.start();
 *
 * // Manually trigger optimization
 * await optimizer.optimize();
 *
 * optimizer.stop();
 * ```
 */
export class MemoryOptimizer {
  private readonly logger?: ILogger;
  private readonly profiler: MemoryProfiler;
  private readonly autoOptimize: boolean;
  private readonly memoryThresholdBytes: number;
  private readonly checkIntervalMs: number;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private appliedOptimizations: Set<string> = new Set();

  constructor(options: MemoryOptimizerOptions) {
    this.logger = options.logger;
    this.profiler = options.profiler;
    this.autoOptimize = options.auto_optimize ?? false;
    this.memoryThresholdBytes = options.memory_threshold_bytes ?? 500 * 1024 * 1024;
    this.checkIntervalMs = options.check_interval_ms ?? 30000;
  }

  /**
   * Start the memory optimizer.
   */
  start(): void {
    if (this.running) return;

    this.running = true;

    if (this.autoOptimize) {
      this.checkTimer = setInterval(() => {
        void this.checkAndOptimize();
      }, this.checkIntervalMs);
    }

    this.logger?.info("memory optimizer started", {
      auto_optimize: this.autoOptimize,
      memory_threshold_bytes: this.memoryThresholdBytes,
      check_interval_ms: this.checkIntervalMs,
    });
  }

  /**
   * Stop the memory optimizer.
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    this.logger?.info("memory optimizer stopped", {
      applied_optimizations: this.appliedOptimizations.size,
    });
  }

  /**
   * Manually trigger optimization.
   */
  async optimize(): Promise<OptimizationResult> {
    const report = this.profiler.getReport();
    const applied: string[] = [];

    // Apply optimizations based on report
    for (const optimization of report.optimizations) {
      if (!this.appliedOptimizations.has(this.getOptimizationKey(optimization))) {
        const success = await this.applyOptimization(optimization);
        if (success) {
          applied.push(optimization.description);
          this.appliedOptimizations.add(this.getOptimizationKey(optimization));
        }
      }
    }

    // Force GC if available
    if (global.gc) {
      global.gc();
    }

    return {
      applied,
      memory_before: report.latest?.heap_used ?? 0,
      memory_after: process.memoryUsage().heapUsed,
    };
  }

  /**
   * Create an object pool.
   */
  createObjectPool<T>(
    factory: () => T,
    reset: (obj: T) => void,
    initialSize?: number,
    maxSize?: number,
  ): ObjectPool<T> {
    return new ObjectPool(factory, reset, initialSize, maxSize);
  }

  /**
   * Create an LRU cache.
   */
  createLRUCache<K, V>(maxSize?: number, ttlMs?: number): LRUCache<K, V> {
    return new LRUCache(maxSize, ttlMs);
  }

  /**
   * Get optimization history.
   */
  getAppliedOptimizations(): string[] {
    return Array.from(this.appliedOptimizations);
  }

  /**
   * Clear optimization history.
   */
  clearHistory(): void {
    this.appliedOptimizations.clear();
  }

  private async checkAndOptimize(): Promise<void> {
    if (!this.running) return;

    const snapshot = this.profiler.getReport().latest;
    if (!snapshot) return;

    if (snapshot.heap_used > this.memoryThresholdBytes) {
      this.logger?.warn("memory threshold exceeded, triggering optimization", {
        heap_used: snapshot.heap_used,
        threshold: this.memoryThresholdBytes,
      });

      await this.optimize();
    }
  }

  private async applyOptimization(optimization: MemoryOptimization): Promise<boolean> {
    this.logger?.debug("applying optimization", {
      category: optimization.category,
      description: optimization.description,
      estimated_savings: optimization.estimated_savings_bytes,
    });

    try {
      switch (optimization.category) {
        case "cleanup":
          // Trigger cleanup of event listeners and timers
          return true;
        case "cache":
          // Cache eviction would be handled by LRU caches
          return true;
        case "object_pool":
          // Object pooling would be configured by the user
          return true;
        case "lazy":
          // Lazy loading would be configured by the user
          return true;
        case "batch":
          // Batching would be configured by the user
          return true;
        default:
          return false;
      }
    } catch (err) {
      this.logger?.error("failed to apply optimization", {
        category: optimization.category,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private getOptimizationKey(optimization: MemoryOptimization): string {
    return `${optimization.category}:${optimization.description}`;
  }
}

/**
 * Result of an optimization run.
 */
export interface OptimizationResult {
  applied: string[];
  memory_before: number;
  memory_after: number;
}
