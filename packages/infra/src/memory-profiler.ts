import type { ILogger } from "@co/contracts";

/**
 * Options for the memory profiler.
 */
export interface MemoryProfilerOptions {
  /** Logger instance */
  logger?: ILogger;
  /** Sampling interval in ms (default: 5000) */
  sample_interval_ms?: number;
  /** Maximum number of samples to keep (default: 1000) */
  max_samples?: number;
  /** Enable detailed object tracking (default: false) */
  enable_object_tracking?: boolean;
}

/**
 * A memory sample at a point in time.
 */
export interface MemorySample {
  /** Timestamp of the sample */
  timestamp: string;
  /** Heap used in bytes */
  heap_used: number;
  /** Heap total in bytes */
  heap_total: number;
  /** External memory in bytes */
  external: number;
  /** Array buffers in bytes */
  array_buffers: number;
  /** RSS (Resident Set Size) in bytes */
  rss: number;
  /** Number of event listeners (if tracking enabled) */
  listener_count?: number;
  /** Number of active timers (if tracking enabled) */
  timer_count?: number;
}

/**
 * Memory leak detection result.
 */
export interface MemoryLeak {
  /** Type of leak detected */
  type: "listener" | "timer" | "closure" | "growth";
  /** Description of the leak */
  description: string;
  /** Estimated memory impact in bytes */
  estimated_bytes: number;
  /** Stack trace or location */
  location?: string;
  /** When the leak was first detected */
  detected_at: string;
}

/**
 * Memory optimization recommendation.
 */
export interface MemoryOptimization {
  /** Category of optimization */
  category: "object_pool" | "cache" | "cleanup" | "lazy" | "batch";
  /** Description of the optimization */
  description: string;
  /** Estimated memory savings in bytes */
  estimated_savings_bytes: number;
  /** Priority (1-10, 10 being highest) */
  priority: number;
}

/**
 * MemoryProfiler tracks memory usage patterns and identifies optimization
 * opportunities to support 100+ concurrent agents.
 *
 * @example
 * ```typescript
 * const profiler = new MemoryProfiler({
 *   logger: logger.child("memory"),
 *   sample_interval_ms: 5000,
 *   enable_object_tracking: true,
 * });
 *
 * profiler.start();
 *
 * // ... after some time ...
 *
 * const report = profiler.getReport();
 * console.log(`Memory trend: ${report.trend}`);
 * console.log(`Potential leaks: ${report.leaks.length}`);
 * console.log(`Optimizations: ${report.optimizations.length}`);
 *
 * profiler.stop();
 * ```
 */
export class MemoryProfiler {
  private readonly logger?: ILogger;
  private readonly sampleIntervalMs: number;
  private readonly maxSamples: number;
  private readonly enableObjectTracking: boolean;
  private samples: MemorySample[] = [];
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private listenerTracker: Map<string, number> = new Map();
  private timerTracker: Set<ReturnType<typeof setTimeout>> = new Set();
  private baselineHeap: number = 0;
  private startTime: number = 0;

  constructor(options: MemoryProfilerOptions = {}) {
    this.logger = options.logger;
    this.sampleIntervalMs = options.sample_interval_ms ?? 5000;
    this.maxSamples = options.max_samples ?? 1000;
    this.enableObjectTracking = options.enable_object_tracking ?? false;
  }

  /**
   * Start memory profiling.
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.startTime = Date.now();

    // Take initial baseline
    const initial = this.collectSample();
    this.baselineHeap = initial.heap_used;

    // Start periodic sampling
    this.intervalTimer = setInterval(() => {
      if (this.running) {
        this.collectSample();
      }
    }, this.sampleIntervalMs);

    this.logger?.info("memory profiler started", {
      sample_interval_ms: this.sampleIntervalMs,
      enable_object_tracking: this.enableObjectTracking,
    });
  }

  /**
   * Stop memory profiling.
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    this.logger?.info("memory profiler stopped", {
      total_samples: this.samples.length,
      duration_ms: Date.now() - this.startTime,
    });
  }

  /**
   * Track an event listener being added.
   */
  trackListener(name: string): void {
    if (!this.enableObjectTracking) return;
    const count = this.listenerTracker.get(name) ?? 0;
    this.listenerTracker.set(name, count + 1);
  }

  /**
   * Track an event listener being removed.
   */
  untrackListener(name: string): void {
    if (!this.enableObjectTracking) return;
    const count = this.listenerTracker.get(name) ?? 0;
    if (count <= 1) {
      this.listenerTracker.delete(name);
    } else {
      this.listenerTracker.set(name, count - 1);
    }
  }

  /**
   * Track a timer being created.
   */
  trackTimer(timer: ReturnType<typeof setTimeout>): void {
    if (!this.enableObjectTracking) return;
    this.timerTracker.add(timer);
  }

  /**
   * Track a timer being cleared.
   */
  untrackTimer(timer: ReturnType<typeof setTimeout>): void {
    if (!this.enableObjectTracking) return;
    this.timerTracker.delete(timer);
  }

  /**
   * Get a memory report with analysis and recommendations.
   */
  getReport(): MemoryReport {
    const latest = this.samples[this.samples.length - 1];
    const trend = this.calculateTrend();
    const leaks = this.detectLeaks();
    const optimizations = this.generateOptimizations();
    const stats = this.calculateStats();

    return {
      latest,
      trend,
      leaks,
      optimizations,
      stats,
      sample_count: this.samples.length,
      duration_ms: Date.now() - this.startTime,
    };
  }

  /**
   * Get all memory samples.
   */
  getSamples(): MemorySample[] {
    return [...this.samples];
  }

  /**
   * Force a garbage collection and take a sample.
   * Useful for testing memory leak detection.
   */
  forceGcSample(): MemorySample {
    if (global.gc) {
      global.gc();
    }
    return this.collectSample();
  }

  private collectSample(): MemorySample {
    const memUsage = process.memoryUsage();

    const sample: MemorySample = {
      timestamp: new Date().toISOString(),
      heap_used: memUsage.heapUsed,
      heap_total: memUsage.heapTotal,
      external: memUsage.external,
      array_buffers: memUsage.arrayBuffers,
      rss: memUsage.rss,
    };

    if (this.enableObjectTracking) {
      sample.listener_count = this.getTotalListenerCount();
      sample.timer_count = this.timerTracker.size;
    }

    this.samples.push(sample);

    // Trim old samples if we exceed max
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(-this.maxSamples);
    }

    return sample;
  }

  private calculateTrend(): "growing" | "stable" | "shrinking" {
    if (this.samples.length < 10) return "stable";

    // Compare average of first 10% vs last 10%
    const sampleCount = this.samples.length;
    const windowSize = Math.max(10, Math.floor(sampleCount * 0.1));

    const firstWindow = this.samples.slice(0, windowSize);
    const lastWindow = this.samples.slice(-windowSize);

    const avgFirst = firstWindow.reduce((sum, s) => sum + s.heap_used, 0) / windowSize;
    const avgLast = lastWindow.reduce((sum, s) => sum + s.heap_used, 0) / windowSize;

    const growthRate = (avgLast - avgFirst) / avgFirst;

    if (growthRate > 0.1) return "growing";
    if (growthRate < -0.1) return "shrinking";
    return "stable";
  }

  private detectLeaks(): MemoryLeak[] {
    const leaks: MemoryLeak[] = [];

    // Check for listener leaks
    if (this.enableObjectTracking) {
      for (const [name, count] of this.listenerTracker) {
        if (count > 10) {
          leaks.push({
            type: "listener",
            description: `Potential listener leak: ${count} listeners for "${name}"`,
            estimated_bytes: count * 1024, // Rough estimate
            detected_at: new Date().toISOString(),
          });
        }
      }

      // Check for timer leaks
      if (this.timerTracker.size > 50) {
        leaks.push({
          type: "timer",
          description: `Potential timer leak: ${this.timerTracker.size} active timers`,
          estimated_bytes: this.timerTracker.size * 512,
          detected_at: new Date().toISOString(),
        });
      }
    }

    // Check for memory growth pattern
    if (this.samples.length >= 20) {
      const recentSamples = this.samples.slice(-20);
      const heapValues = recentSamples.map((s) => s.heap_used);
      const avgHeap = heapValues.reduce((a, b) => a + b, 0) / heapValues.length;
      const variance = heapValues.reduce((sum, v) => sum + Math.pow(v - avgHeap, 2), 0) / heapValues.length;
      const stdDev = Math.sqrt(variance);

      // High variance suggests memory instability
      if (stdDev > avgHeap * 0.1) {
        leaks.push({
          type: "growth",
          description: `Memory instability detected: high variance in heap usage`,
          estimated_bytes: stdDev,
          detected_at: new Date().toISOString(),
        });
      }
    }

    return leaks;
  }

  private generateOptimizations(): MemoryOptimization[] {
    const optimizations: MemoryOptimization[] = [];
    const currentHeap = this.samples[this.samples.length - 1]?.heap_used ?? 0;

    // Object pooling recommendation
    if (currentHeap > 100 * 1024 * 1024) { // > 100MB
      optimizations.push({
        category: "object_pool",
        description: "Consider implementing object pooling for frequently created/destroyed objects",
        estimated_savings_bytes: currentHeap * 0.1,
        priority: 8,
      });
    }

    // Cache optimization
    if (this.samples.length > 100) {
      const firstHeap = this.samples[0].heap_used;
      const lastHeap = this.samples[this.samples.length - 1].heap_used;
      const growth = lastHeap - firstHeap;

      if (growth > 50 * 1024 * 1024) { // > 50MB growth
        optimizations.push({
          category: "cache",
          description: "Memory has grown significantly - consider implementing cache eviction",
          estimated_savings_bytes: growth * 0.3,
          priority: 9,
        });
      }
    }

    // Cleanup recommendation
    if (this.enableObjectTracking && this.listenerTracker.size > 20) {
      optimizations.push({
        category: "cleanup",
        description: "Many event listeners registered - ensure proper cleanup on component disposal",
        estimated_savings_bytes: this.listenerTracker.size * 1024,
        priority: 7,
      });
    }

    // Lazy loading
    if (currentHeap > 200 * 1024 * 1024) { // > 200MB
      optimizations.push({
        category: "lazy",
        description: "High memory usage - consider lazy loading of non-critical components",
        estimated_savings_bytes: currentHeap * 0.2,
        priority: 10,
      });
    }

    return optimizations.sort((a, b) => b.priority - a.priority);
  }

  private calculateStats(): MemoryStats {
    if (this.samples.length === 0) {
      return {
        min_heap: 0,
        max_heap: 0,
        avg_heap: 0,
        min_rss: 0,
        max_rss: 0,
        avg_rss: 0,
      };
    }

    const heapValues = this.samples.map((s) => s.heap_used);
    const rssValues = this.samples.map((s) => s.rss);

    return {
      min_heap: Math.min(...heapValues),
      max_heap: Math.max(...heapValues),
      avg_heap: heapValues.reduce((a, b) => a + b, 0) / heapValues.length,
      min_rss: Math.min(...rssValues),
      max_rss: Math.max(...rssValues),
      avg_rss: rssValues.reduce((a, b) => a + b, 0) / rssValues.length,
    };
  }

  private getTotalListenerCount(): number {
    let total = 0;
    for (const count of this.listenerTracker.values()) {
      total += count;
    }
    return total;
  }
}

/**
 * Memory report with analysis and recommendations.
 */
export interface MemoryReport {
  latest: MemorySample | null;
  trend: "growing" | "stable" | "shrinking";
  leaks: MemoryLeak[];
  optimizations: MemoryOptimization[];
  stats: MemoryStats;
  sample_count: number;
  duration_ms: number;
}

/**
 * Memory statistics.
 */
export interface MemoryStats {
  min_heap: number;
  max_heap: number;
  avg_heap: number;
  min_rss: number;
  max_rss: number;
  avg_rss: number;
}
