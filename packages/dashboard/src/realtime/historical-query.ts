import type { MetricPoint } from "./chart-data.js";

export type TimeRange = "hour" | "day" | "week";

/**
 * Queries historical metric data.
 */
export class HistoricalQuery {
  private storage: Map<string, MetricPoint[]> = new Map();

  /**
   * Store metric data.
   */
  store(metric: string, points: MetricPoint[]): void {
    const existing = this.storage.get(metric) || [];
    this.storage.set(metric, [...existing, ...points]);
  }

  /**
   * Query data by time range.
   */
  query(metric: string, range: TimeRange): MetricPoint[] {
    const now = Date.now();
    const ranges: Record<TimeRange, number> = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
    };

    const cutoff = now - ranges[range];
    const points = this.storage.get(metric) || [];

    return points.filter((p) => p.timestamp >= cutoff);
  }

  /**
   * Clear old data beyond retention period.
   */
  cleanup(retentionDays: number = 30): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    for (const [metric, points] of this.storage) {
      const filtered = points.filter((p) => p.timestamp >= cutoff);
      this.storage.set(metric, filtered);
    }
  }
}
