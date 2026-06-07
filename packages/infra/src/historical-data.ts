import * as fs from "node:fs";
import * as path from "node:path";
import type { ILogger } from "@co/contracts";

/**
 * Granularity levels for historical data storage.
 */
export type Granularity = "1m" | "5m" | "1h" | "1d";

/**
 * A single metric data point.
 */
export interface MetricDataPoint {
  /** Timestamp in ISO 8601 format */
  timestamp: string;
  /** Metric name */
  metric_name: string;
  /** Aggregated value */
  value: number;
  /** Data granularity */
  granularity: Granularity;
  /** Optional labels */
  labels?: Record<string, string>;
}

/**
 * Query parameters for retrieving historical data.
 */
export interface HistoricalQuery {
  /** Start time (ISO 8601) */
  from: string;
  /** End time (ISO 8601) */
  to: string;
  /** Optional metric name filter */
  metric_name?: string;
  /** Optional granularity filter */
  granularity?: Granularity;
}

/**
 * Options for configuring the Historical Data Manager.
 */
export interface HistoricalDataOptions {
  /** Directory to store historical data files */
  storage_dir: string;
  /** Logger instance */
  logger?: ILogger;
  /** Retention period in days (default: 30) */
  retention_days?: number;
  /** Granularity compression thresholds */
  compression_thresholds?: {
    /** After this many days, compress 1h to 1d (default: 7) */
    compress_to_daily?: number;
  };
}

/**
 * Manages historical metric data with compression and retention.
 *
 * Features:
 * - Stores aggregated metrics with timestamps
 * - Data compression for older entries (1h → 1d granularity after 7 days)
 * - Query by time range and metric name
 * - Retention policy enforcement (30 days)
 *
 * Storage format:
 * - Files are stored by date: YYYY-MM-DD.jsonl
 * - Each line is a JSON MetricDataPoint
 * - Recent data (≤7 days) stored at 1h granularity
 * - Older data compressed to 1d granularity
 *
 * Usage:
 *   const historicalData = new HistoricalData({ storage_dir: './data/history' });
 *   await historicalData.record({ timestamp: ..., metric_name: 'cpu_usage', value: 45.2 });
 *   const data = await historicalData.query({ from: '...', to: '...', metric_name: 'cpu_usage' });
 */
export class HistoricalData {
  private readonly storage_dir: string;
  private readonly logger?: ILogger;
  private readonly retention_days: number;
  private readonly compress_after_days: number;
  private readonly data_points: Map<string, MetricDataPoint[]> = new Map();
  private compression_timer: ReturnType<typeof setInterval> | null = null;
  private retention_timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HistoricalDataOptions) {
    this.storage_dir = opts.storage_dir;
    this.logger = opts.logger;
    this.retention_days = opts.retention_days ?? 30;
    this.compress_after_days = opts.compression_thresholds?.compress_to_daily ?? 7;

    // Ensure storage directory exists
    fs.mkdirSync(this.storage_dir, { recursive: true });
  }

  /**
   * Record a metric data point.
   */
  async record(data_point: MetricDataPoint): Promise<void> {
    const date_key = this.extractDateKey(data_point.timestamp);

    // Get or create array for this date
    if (!this.data_points.has(date_key)) {
      this.data_points.set(date_key, []);
    }

    this.data_points.get(date_key)!.push(data_point);

    // Persist to disk
    await this.persistDataPoint(date_key, data_point);

    this.logger?.debug("recorded historical data point", {
      metric_name: data_point.metric_name,
      granularity: data_point.granularity,
      timestamp: data_point.timestamp,
    });
  }

  /**
   * Query historical data by time range and optional filters.
   */
  async query(query: HistoricalQuery): Promise<MetricDataPoint[]> {
    const results: MetricDataPoint[] = [];
    const from_date = new Date(query.from);
    const to_date = new Date(query.to);

    // Iterate through date range
    const current_date = new Date(from_date);
    while (current_date <= to_date) {
      const date_key = this.formatDateKey(current_date);

      // Load data for this date if not cached
      if (!this.data_points.has(date_key)) {
        await this.loadDataForDate(date_key);
      }

      const data_points = this.data_points.get(date_key) ?? [];

      // Filter by time range and query criteria
      for (const point of data_points) {
        const point_time = new Date(point.timestamp);

        // For daily granularity, check if the date falls within the range
        if (point.granularity === "1d") {
          const point_date_key = this.extractDateKey(point.timestamp);
          const from_date_key = this.formatDateKey(from_date);
          const to_date_key = this.formatDateKey(to_date);
          if (point_date_key < from_date_key || point_date_key > to_date_key) continue;
        } else {
          // For other granularities, check exact time range
          if (point_time < from_date || point_time > to_date) continue;
        }

        if (query.metric_name && point.metric_name !== query.metric_name) continue;
        if (query.granularity && point.granularity !== query.granularity) continue;

        results.push(point);
      }

      current_date.setDate(current_date.getDate() + 1);
    }

    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Get the latest data point for a specific metric.
   */
  async getLatest(metric_name: string): Promise<MetricDataPoint | null> {
    const today = new Date();
    const date_key = this.formatDateKey(today);

    // Check today's data
    if (!this.data_points.has(date_key)) {
      await this.loadDataForDate(date_key);
    }

    const today_points = this.data_points.get(date_key) ?? [];
    const today_latest = today_points
      .filter(p => p.metric_name === metric_name)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];

    if (today_latest) return today_latest;

    // Check yesterday if no data today
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterday_key = this.formatDateKey(yesterday);

    if (!this.data_points.has(yesterday_key)) {
      await this.loadDataForDate(yesterday_key);
    }

    const yesterday_points = this.data_points.get(yesterday_key) ?? [];
    return yesterday_points
      .filter(p => p.metric_name === metric_name)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
  }

  /**
   * Start periodic compression and retention enforcement.
   */
  start(): void {
    // Compress data every hour
    this.compression_timer = setInterval(() => {
      this.compressOldData().catch(err => {
        this.logger?.error("compression error", { error: err });
      });
    }, 60 * 60 * 1000); // 1 hour

    // Enforce retention daily
    this.retention_timer = setInterval(() => {
      this.enforceRetention().catch(err => {
        this.logger?.error("retention enforcement error", { error: err });
      });
    }, 24 * 60 * 60 * 1000); // 24 hours

    this.logger?.info("historical data manager started", {
      storage_dir: this.storage_dir,
      retention_days: this.retention_days,
      compress_after_days: this.compress_after_days,
    });
  }

  /**
   * Stop periodic tasks.
   */
  stop(): void {
    if (this.compression_timer) {
      clearInterval(this.compression_timer);
      this.compression_timer = null;
    }
    if (this.retention_timer) {
      clearInterval(this.retention_timer);
      this.retention_timer = null;
    }
    this.logger?.info("historical data manager stopped");
  }

  /**
   * Compress old data points (1h → 1d granularity).
   */
  async compressOldData(): Promise<void> {
    const now = new Date();
    const compress_before = new Date(now);
    compress_before.setDate(compress_before.getDate() - this.compress_after_days);

    // Get all stored dates
    const files = fs.readdirSync(this.storage_dir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const date_key = file.replace(".jsonl", "");
      const file_date = new Date(date_key);

      // Only compress dates older than the threshold
      if (file_date >= compress_before) continue;

      if (!this.data_points.has(date_key)) {
        await this.loadDataForDate(date_key);
      }

      const data_points = this.data_points.get(date_key);
      if (!data_points) continue;

      // Find hourly data points that can be compressed
      const hourly_points = data_points.filter(p => p.granularity === "1h");
      if (hourly_points.length > 0) {
        const compressed = this.compressHourlyToDaily(hourly_points);

        // Remove hourly points and add daily
        this.data_points.set(date_key, [
          ...data_points.filter(p => p.granularity !== "1h"),
          ...compressed,
        ]);

        // Persist compressed data
        await this.persistDateData(date_key);

        this.logger?.info("compressed hourly data to daily", {
          date: date_key,
          compressed_count: hourly_points.length,
          resulting_count: compressed.length,
        });
      }
    }
  }

  /**
   * Enforce retention policy by deleting old data.
   */
  async enforceRetention(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - this.retention_days);

    const files = fs.readdirSync(this.storage_dir);
    let deleted_count = 0;

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const date_str = file.replace(".jsonl", "");
      const file_date = new Date(date_str);

      if (file_date < cutoff) {
        const file_path = path.join(this.storage_dir, file);
        fs.unlinkSync(file_path);
        deleted_count++;

        // Also remove from cache
        this.data_points.delete(date_str);
      }
    }

    if (deleted_count > 0) {
      this.logger?.info("enforced data retention", {
        deleted_files: deleted_count,
        retention_days: this.retention_days,
      });
    }
  }

  /**
   * Get storage statistics.
   */
  getStats(): {
    total_dates: number;
    total_points: number;
    estimated_size_bytes: number;
    oldest_date: string | null;
    newest_date: string | null;
  } {
    let total_points = 0;
    let oldest_date: string | null = null;
    let newest_date: string | null = null;

    for (const [date_key, points] of this.data_points) {
      total_points += points.length;

      if (!oldest_date || date_key < oldest_date) oldest_date = date_key;
      if (!newest_date || date_key > newest_date) newest_date = date_key;
    }

    // Estimate storage size (rough: 200 bytes per data point)
    const estimated_size_bytes = total_points * 200;

    return {
      total_dates: this.data_points.size,
      total_points,
      estimated_size_bytes,
      oldest_date,
      newest_date,
    };
  }

  /**
   * Extract date key (YYYY-MM-DD) from ISO timestamp using local time.
   */
  private extractDateKey(timestamp: string): string {
    const date = new Date(timestamp);
    return this.formatDateKey(date);
  }

  /**
   * Format Date object to YYYY-MM-DD key using local time.
   */
  private formatDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * Persist a single data point to disk.
   */
  private async persistDataPoint(date_key: string, data_point: MetricDataPoint): Promise<void> {
    const file_path = this.getFilePath(date_key);
    const line = JSON.stringify(data_point) + "\n";
    fs.appendFileSync(file_path, line, "utf-8");
  }

  /**
   * Persist all data for a date to disk.
   */
  private async persistDateData(date_key: string): Promise<void> {
    const file_path = this.getFilePath(date_key);
    const data_points = this.data_points.get(date_key) ?? [];

    // Write all data points
    const lines = data_points.map(p => JSON.stringify(p)).join("\n") + "\n";
    fs.writeFileSync(file_path, lines, "utf-8");
  }

  /**
   * Get file path for a date.
   */
  private getFilePath(date_key: string): string {
    return path.join(this.storage_dir, `${date_key}.jsonl`);
  }

  /**
   * Load data for a date from disk.
   */
  private async loadDataForDate(date_key: string): Promise<void> {
    const file_path = this.getFilePath(date_key);

    if (!fs.existsSync(file_path)) {
      return;
    }

    const content = fs.readFileSync(file_path, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());

    const data_points: MetricDataPoint[] = [];
    for (const line of lines) {
      try {
        const point = JSON.parse(line) as MetricDataPoint;
        data_points.push(point);
      } catch {
        this.logger?.warn("failed to parse data point", { line });
      }
    }

    this.data_points.set(date_key, data_points);
  }

  /**
   * Compress hourly data points to daily aggregations.
   * Groups by metric name and computes daily summary.
   */
  private compressHourlyToDaily(hourly_points: MetricDataPoint[]): MetricDataPoint[] {
    const grouped = new Map<string, MetricDataPoint[]>();

    // Group by metric name
    for (const point of hourly_points) {
      const key = point.metric_name;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(point);
    }

    const daily_points: MetricDataPoint[] = [];

    for (const [metric_name, points] of grouped) {
      if (points.length === 0) continue;

      // Calculate daily summary (average for most metrics)
      const values = points.map(p => p.value);
      const avg_value = values.reduce((a, b) => a + b, 0) / values.length;

      // Use the start of the day as the timestamp (UTC)
      const first_point = points.sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
      const day_start = new Date(first_point.timestamp);
      day_start.setUTCHours(0, 0, 0, 0);

      daily_points.push({
        timestamp: day_start.toISOString(),
        metric_name,
        value: Math.round(avg_value * 100) / 100, // Round to 2 decimal places
        granularity: "1d",
        labels: first_point.labels,
      });
    }

    return daily_points;
  }
}
