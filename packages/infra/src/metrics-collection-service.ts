// Metrics Collection Service
// Collects metrics from orchestrator components, aggregates by time intervals,
// and stores them in an in-memory time-series store with retention policies.

import type { ILogger } from "@co/contracts";

/**
 * Supported aggregation intervals.
 */
export type AggregationInterval = "1m" | "5m" | "1h";

/**
 * A raw metric sample collected from a component.
 */
export interface MetricSample {
  /** Metric name (e.g., "co_tasks_dispatched_total") */
  name: string;
  /** Numeric value */
  value: number;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Optional labels */
  labels?: Record<string, string>;
  /** Source component identifier */
  source: string;
}

/**
 * An aggregated metric data point.
 */
export interface AggregatedMetric {
  /** Metric name */
  name: string;
  /** Aggregated value (mean for gauges/histograms, sum for counters) */
  value: number;
  /** Start of the aggregation window (ms) */
  window_start: number;
  /** End of the aggregation window (ms) */
  window_end: number;
  /** Aggregation interval used */
  interval: AggregationInterval;
  /** Number of raw samples in this aggregation */
  sample_count: number;
  /** Optional labels */
  labels?: Record<string, string>;
}

/**
 * Prometheus-compatible metric export format.
 */
export interface PrometheusMetric {
  /** Metric name */
  name: string;
  /** Help text */
  help: string;
  /** Metric type: counter, gauge, histogram */
  type: "counter" | "gauge" | "histogram";
  /** Samples with optional labels */
  samples: Array<{
    labels?: Record<string, string>;
    value: number;
    timestamp?: number;
  }>;
}

/**
 * Options for configuring the MetricsCollectionService.
 */
export interface MetricsCollectionServiceOptions {
  /** Logger instance */
  logger?: ILogger;
  /** Retention period in days (default: 30) */
  retention_days?: number;
  /** Maximum number of raw samples to keep in memory (default: 100000) */
  max_samples?: number;
  /** Aggregation intervals to compute (default: all) */
  aggregation_intervals?: AggregationInterval[];
}

const INTERVAL_MS: Record<AggregationInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
};

const RETENTION_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * In-memory time-series store for metric data.
 * Stores raw samples and computes aggregated views on demand.
 */
export class MetricsCollectionService {
  private readonly logger?: ILogger;
  private readonly retention_ms: number;
  private readonly max_samples: number;
  private readonly intervals: AggregationInterval[];

  /** Raw metric samples indexed by metric name. */
  private readonly samples: Map<string, MetricSample[]> = new Map();
  /** Cached aggregated metrics keyed by "name:interval". */
  private readonly aggregated: Map<string, AggregatedMetric[]> = new Map();
  /** Metric metadata for Prometheus export. */
  private readonly metric_meta: Map<string, { help: string; type: "counter" | "gauge" | "histogram" }> = new Map();

  private cleanup_timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: MetricsCollectionServiceOptions = {}) {
    this.logger = opts.logger;
    this.retention_ms = (opts.retention_days ?? 30) * 24 * 60 * 60 * 1000;
    this.max_samples = opts.max_samples ?? 100_000;
    this.intervals = opts.aggregation_intervals ?? ["1m", "5m", "1h"];
  }

  /**
   * Record a raw metric sample.
   */
  record(sample: MetricSample): void {
    let list = this.samples.get(sample.name);
    if (!list) {
      list = [];
      this.samples.set(sample.name, list);
    }
    list.push(sample);

    // Evict oldest if over limit
    if (list.length > this.max_samples) {
      const excess = list.length - this.max_samples;
      list.splice(0, excess);
    }

    // Invalidate cached aggregations for this metric
    for (const interval of this.intervals) {
      this.aggregated.delete(`${sample.name}:${interval}`);
    }
  }

  /**
   * Register metric metadata for Prometheus export.
   */
  registerMetric(name: string, help: string, type: "counter" | "gauge" | "histogram"): void {
    this.metric_meta.set(name, { help, type });
  }

  /**
   * Get aggregated metrics for a given metric name and interval.
   * Computes aggregations lazily and caches the results.
   */
  getAggregated(name: string, interval: AggregationInterval): AggregatedMetric[] {
    const cache_key = `${name}:${interval}`;
    const cached = this.aggregated.get(cache_key);
    if (cached) {
      return cached;
    }

    const raw = this.samples.get(name) ?? [];
    if (raw.length === 0) {
      return [];
    }

    const window_ms = INTERVAL_MS[interval];
    const now = Date.now();
    const result = this.computeAggregation(raw, window_ms, now, interval);

    this.aggregated.set(cache_key, result);
    return result;
  }

  /**
   * Get the latest aggregated value for a metric.
   */
  getLatest(name: string, interval: AggregationInterval = "1m"): AggregatedMetric | null {
    const aggregated = this.getAggregated(name, interval);
    return aggregated.length > 0 ? aggregated[aggregated.length - 1] : null;
  }

  /**
   * Get all registered metric names.
   */
  getMetricNames(): string[] {
    return Array.from(this.samples.keys());
  }

  /**
   * Get raw samples for a metric within a time range.
   */
  getRawSamples(name: string, from_ms?: number, to_ms?: number): MetricSample[] {
    const raw = this.samples.get(name) ?? [];
    if (from_ms === undefined && to_ms === undefined) {
      return [...raw];
    }
    return raw.filter((s) => {
      if (from_ms !== undefined && s.timestamp < from_ms) return false;
      if (to_ms !== undefined && s.timestamp > to_ms) return false;
      return true;
    });
  }

  /**
   * Export all metrics in Prometheus text exposition format.
   */
  toPrometheus(): string {
    const sections: string[] = [];

    for (const [name, meta] of this.metric_meta) {
      const raw = this.samples.get(name) ?? [];
      if (raw.length === 0) continue;

      sections.push(`# HELP ${name} ${meta.help}`);
      sections.push(`# TYPE ${name} ${meta.type}`);

      // Group samples by label signature
      const byLabels = new Map<string, MetricSample[]>();
      for (const sample of raw) {
        const key = sample.labels ? JSON.stringify(sample.labels, Object.keys(sample.labels).sort()) : "";
        let group = byLabels.get(key);
        if (!group) {
          group = [];
          byLabels.set(key, group);
        }
        group.push(sample);
      }

      for (const [, group] of byLabels) {
        const latest = group[group.length - 1];
        const label_str = latest.labels
          ? `{${Object.entries(latest.labels).map(([k, v]) => `${k}="${v}"`).join(", ")}}`
          : "";
        sections.push(`${name}${label_str} ${latest.value}`);
      }
    }

    return sections.join("\n") + (sections.length > 0 ? "\n" : "");
  }

  /**
   * Start periodic cleanup of expired data.
   */
  start(): void {
    // Run cleanup every 5 minutes
    this.cleanup_timer = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);

    this.logger?.info("metrics collection service started", {
      retention_days: this.retention_ms / (24 * 60 * 60 * 1000),
      max_samples: this.max_samples,
      intervals: this.intervals,
    });
  }

  /**
   * Stop periodic cleanup.
   */
  stop(): void {
    if (this.cleanup_timer) {
      clearInterval(this.cleanup_timer);
      this.cleanup_timer = null;
    }
    this.logger?.info("metrics collection service stopped");
  }

  /**
   * Get storage statistics.
   */
  getStats(): {
    metric_count: number;
    total_samples: number;
    aggregated_cache_size: number;
  } {
    let total_samples = 0;
    for (const list of this.samples.values()) {
      total_samples += list.length;
    }
    return {
      metric_count: this.samples.size,
      total_samples,
      aggregated_cache_size: this.aggregated.size,
    };
  }

  /**
   * Remove expired samples based on retention policy.
   */
  cleanup(): void {
    const cutoff = Date.now() - this.retention_ms;
    let removed = 0;

    for (const [name, list] of this.samples) {
      const original_len = list.length;
      // Find first non-expired index
      let keep_from = 0;
      while (keep_from < list.length && list[keep_from].timestamp < cutoff) {
        keep_from++;
      }
      if (keep_from > 0) {
        list.splice(0, keep_from);
        removed += original_len - list.length;
      }

      // Remove empty entries
      if (list.length === 0) {
        this.samples.delete(name);
        for (const interval of this.intervals) {
          this.aggregated.delete(`${name}:${interval}`);
        }
      }
    }

    // Clear all aggregation caches (they may reference expired data)
    this.aggregated.clear();

    if (removed > 0) {
      this.logger?.debug("cleaned up expired metric samples", { removed });
    }
  }

  /**
   * Compute aggregated metrics from raw samples using fixed-size windows.
   */
  private computeAggregation(
    raw: MetricSample[],
    window_ms: number,
    now: number,
    interval: AggregationInterval,
  ): AggregatedMetric[] {
    // Only aggregate recent data (within retention)
    const retention_cutoff = now - this.retention_ms;
    const recent = raw.filter((s) => s.timestamp >= retention_cutoff);
    if (recent.length === 0) return [];

    // Determine the time range
    const oldest = recent[0].timestamp;
    const window_start = Math.max(oldest, retention_cutoff);

    // Build windows
    const windows: AggregatedMetric[] = [];
    let cursor = window_start;

    while (cursor < now) {
      const window_end = Math.min(cursor + window_ms, now);
      const window_samples = recent.filter(
        (s) => s.timestamp >= cursor && s.timestamp < window_end,
      );

      if (window_samples.length > 0) {
        const values = window_samples.map((s) => s.value);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;

        // Merge labels from all samples (last wins for conflicts)
        let merged_labels: Record<string, string> | undefined;
        for (const s of window_samples) {
          if (s.labels) {
            if (!merged_labels) merged_labels = {};
            Object.assign(merged_labels, s.labels);
          }
        }

        windows.push({
          name: window_samples[0].name,
          value: Math.round(avg * 1_000_000) / 1_000_000, // 6 decimal precision
          window_start: cursor,
          window_end,
          interval,
          sample_count: window_samples.length,
          labels: merged_labels,
        });
      }

      cursor = window_end;
    }

    return windows;
  }
}
