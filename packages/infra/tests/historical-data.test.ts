import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { HistoricalData, type MetricDataPoint } from "../src/historical-data.js";

describe("HistoricalData", () => {
  let historical_data: HistoricalData;
  let storage_dir: string;

  beforeEach(() => {
    storage_dir = path.join(__dirname, "test-storage", `historical-${Date.now()}`);
    fs.mkdirSync(storage_dir, { recursive: true });
    historical_data = new HistoricalData({ storage_dir });
  });

  afterEach(() => {
    historical_data.stop();
    fs.rmSync(path.join(__dirname, "test-storage"), { recursive: true, force: true });
  });

  describe("record", () => {
    it("should record a data point", async () => {
      const point: MetricDataPoint = {
        timestamp: new Date().toISOString(),
        metric_name: "cpu_usage",
        value: 45.2,
        granularity: "1m",
      };

      await historical_data.record(point);

      const stats = historical_data.getStats();
      expect(stats.total_points).toBe(1);
    });

    it("should persist data to disk", async () => {
      const point: MetricDataPoint = {
        timestamp: new Date().toISOString(),
        metric_name: "memory_usage",
        value: 62.5,
        granularity: "5m",
      };

      await historical_data.record(point);

      const files = fs.readdirSync(storage_dir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    });
  });

  describe("query", () => {
    it("should query data by time range", async () => {
      const now = new Date();
      const hour_ago = new Date(now.getTime() - 60 * 60 * 1000);

      await historical_data.record({
        timestamp: hour_ago.toISOString(),
        metric_name: "cpu_usage",
        value: 30,
        granularity: "1h",
      });

      await historical_data.record({
        timestamp: now.toISOString(),
        metric_name: "cpu_usage",
        value: 45,
        granularity: "1h",
      });

      const results = await historical_data.query({
        from: hour_ago.toISOString(),
        to: now.toISOString(),
      });

      expect(results.length).toBe(2);
    });

    it("should filter by metric name", async () => {
      const now = new Date();

      await historical_data.record({
        timestamp: now.toISOString(),
        metric_name: "cpu_usage",
        value: 45,
        granularity: "1h",
      });

      await historical_data.record({
        timestamp: now.toISOString(),
        metric_name: "memory_usage",
        value: 62,
        granularity: "1h",
      });

      const results = await historical_data.query({
        from: new Date(now.getTime() - 1000).toISOString(),
        to: new Date(now.getTime() + 1000).toISOString(),
        metric_name: "cpu_usage",
      });

      expect(results.length).toBe(1);
      expect(results[0].metric_name).toBe("cpu_usage");
    });

    it("should filter by granularity", async () => {
      const now = new Date();

      await historical_data.record({
        timestamp: now.toISOString(),
        metric_name: "cpu_usage",
        value: 45,
        granularity: "1h",
      });

      await historical_data.record({
        timestamp: now.toISOString(),
        metric_name: "cpu_usage",
        value: 42,
        granularity: "1m",
      });

      const results = await historical_data.query({
        from: new Date(now.getTime() - 1000).toISOString(),
        to: new Date(now.getTime() + 1000).toISOString(),
        granularity: "1h",
      });

      expect(results.length).toBe(1);
      expect(results[0].granularity).toBe("1h");
    });
  });

  describe("getLatest", () => {
    it("should get the latest data point for a metric", async () => {
      const now = new Date();
      const minute_ago = new Date(now.getTime() - 60 * 1000);

      await historical_data.record({
        timestamp: minute_ago.toISOString(),
        metric_name: "cpu_usage",
        value: 30,
        granularity: "1m",
      });

      await historical_data.record({
        timestamp: now.toISOString(),
        metric_name: "cpu_usage",
        value: 45,
        granularity: "1m",
      });

      const latest = await historical_data.getLatest("cpu_usage");
      expect(latest).not.toBeNull();
      expect(latest!.value).toBe(45);
    });

    it("should return null for non-existent metric", async () => {
      const latest = await historical_data.getLatest("non_existent");
      expect(latest).toBeNull();
    });
  });

  describe("compression", () => {
    it("should compress hourly data to daily", async () => {
      // Create data from 8 days ago, all within a single day
      const eight_days_ago = new Date();
      eight_days_ago.setDate(eight_days_ago.getDate() - 8);
      eight_days_ago.setHours(0, 0, 0, 0);

      // Add 12 hourly data points within the same day
      for (let hour = 0; hour < 12; hour++) {
        const timestamp = new Date(eight_days_ago);
        timestamp.setHours(hour);

        await historical_data.record({
          timestamp: timestamp.toISOString(),
          metric_name: "cpu_usage",
          value: 40 + hour,
          granularity: "1h",
        });
      }

      // Run compression
      await historical_data.compressOldData();

      // Check that compression reduced the number of points
      const stats = historical_data.getStats();
      // 12 hourly points compressed to 1 daily point
      expect(stats.total_points).toBe(1);
    });

    it("should not compress recent data", async () => {
      // Create data from today (within compression threshold)
      const now = new Date();

      // Add 5 hourly data points
      for (let hour = 0; hour < 5; hour++) {
        const timestamp = new Date(now);
        timestamp.setHours(now.getHours() - 5 + hour);

        await historical_data.record({
          timestamp: timestamp.toISOString(),
          metric_name: "cpu_usage",
          value: 30 + hour,
          granularity: "1h",
        });
      }

      // Run compression
      await historical_data.compressOldData();

      // Check that recent data was NOT compressed
      const stats = historical_data.getStats();
      expect(stats.total_points).toBe(5);
    });
  });

  describe("retention", () => {
    it("should delete old files based on retention policy", async () => {
      // Create historical data manager with 7-day retention
      const retention_manager = new HistoricalData({
        storage_dir: path.join(storage_dir, "retention-test"),
        retention_days: 7,
      });

      // Create data from 10 days ago
      const ten_days_ago = new Date();
      ten_days_ago.setDate(ten_days_ago.getDate() - 10);

      await retention_manager.record({
        timestamp: ten_days_ago.toISOString(),
        metric_name: "cpu_usage",
        value: 45,
        granularity: "1d",
      });

      // Create data from today
      await retention_manager.record({
        timestamp: new Date().toISOString(),
        metric_name: "cpu_usage",
        value: 50,
        granularity: "1d",
      });

      // Enforce retention
      await retention_manager.enforceRetention();

      // Check that old file was deleted
      const files = fs.readdirSync(path.join(storage_dir, "retention-test"));
      expect(files.length).toBe(1);

      retention_manager.stop();
    });
  });

  describe("stats", () => {
    it("should return correct statistics", async () => {
      await historical_data.record({
        timestamp: new Date().toISOString(),
        metric_name: "cpu_usage",
        value: 45,
        granularity: "1h",
      });

      await historical_data.record({
        timestamp: new Date().toISOString(),
        metric_name: "memory_usage",
        value: 62,
        granularity: "1h",
      });

      const stats = historical_data.getStats();
      expect(stats.total_dates).toBe(1);
      expect(stats.total_points).toBe(2);
      expect(stats.oldest_date).toBeTruthy();
      expect(stats.newest_date).toBeTruthy();
    });
  });
});
