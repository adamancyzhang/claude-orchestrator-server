// CORE-RETENTION
// Locks in: ResourceMonitor — CPU/memory/network monitoring, threshold
// alerts, snapshot collection, and report generation.
// Critical because: Resource monitoring enables load balancing decisions.
// A broken monitor means the orchestrator cannot detect overloaded workers
// or make informed scheduling decisions.
// Primary sources: packages/infra/src/resource-monitor.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ResourceMonitor, type ResourceSnapshot, type ResourceAlert } from "../src/resource-monitor.js";

describe("ResourceMonitor", () => {
  let monitor: ResourceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new ResourceMonitor({ interval_ms: 1000 });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("creates instance with default options", () => {
    const m = new ResourceMonitor();
    expect(m).toBeDefined();
    expect(m.getLatestSnapshot()).toBeNull();
  });

  it("start() begins monitoring", () => {
    monitor.start();
    vi.advanceTimersByTime(100);
    expect(monitor.getLatestSnapshot()).not.toBeNull();
  });

  it("stop() ends monitoring", () => {
    monitor.start();
    vi.advanceTimersByTime(100);
    monitor.stop();
    const snapshot1 = monitor.getLatestSnapshot();
    vi.advanceTimersByTime(2000);
    const snapshot2 = monitor.getLatestSnapshot();
    // Snapshot should not update after stop
    expect(snapshot1?.timestamp).toBe(snapshot2?.timestamp);
  });

  it("collects snapshot with correct structure", () => {
    monitor.start();
    vi.advanceTimersByTime(100);
    const snapshot = monitor.getLatestSnapshot();

    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveProperty("cpu_usage_percent");
    expect(snapshot).toHaveProperty("memory_used_bytes");
    expect(snapshot).toHaveProperty("memory_total_bytes");
    expect(snapshot).toHaveProperty("memory_usage_percent");
    expect(snapshot).toHaveProperty("memory_free_bytes");
    expect(snapshot).toHaveProperty("network_rx_bytes");
    expect(snapshot).toHaveProperty("network_tx_bytes");
    expect(snapshot).toHaveProperty("timestamp");
    expect(snapshot).toHaveProperty("pid");
  });

  it("CPU usage is between 0 and 100", () => {
    monitor.start();
    vi.advanceTimersByTime(100);
    const snapshot = monitor.getLatestSnapshot();

    expect(snapshot!.cpu_usage_percent).toBeGreaterThanOrEqual(0);
    expect(snapshot!.cpu_usage_percent).toBeLessThanOrEqual(100);
  });

  it("memory usage is valid", () => {
    monitor.start();
    vi.advanceTimersByTime(100);
    const snapshot = monitor.getLatestSnapshot();

    expect(snapshot!.memory_total_bytes).toBeGreaterThan(0);
    expect(snapshot!.memory_used_bytes).toBeGreaterThanOrEqual(0);
    expect(snapshot!.memory_used_bytes).toBeLessThanOrEqual(snapshot!.memory_total_bytes);
    expect(snapshot!.memory_usage_percent).toBeGreaterThanOrEqual(0);
    expect(snapshot!.memory_usage_percent).toBeLessThanOrEqual(100);
  });

  it("pid matches current process", () => {
    monitor.start();
    vi.advanceTimersByTime(100);
    const snapshot = monitor.getLatestSnapshot();

    expect(snapshot!.pid).toBe(process.pid);
  });

  it("timestamp is valid ISO string", () => {
    monitor.start();
    vi.advanceTimersByTime(100);
    const snapshot = monitor.getLatestSnapshot();

    expect(() => new Date(snapshot!.timestamp)).not.toThrow();
  });

  it("alerts are generated when thresholds exceeded", () => {
    const alertMonitor = new ResourceMonitor({
      cpu_warning_threshold: 0, // Always trigger
      memory_warning_threshold: 0, // Always trigger
      interval_ms: 100,
    });

    const alerts: ResourceAlert[] = [];
    alertMonitor.onAlert((alert) => alerts.push(alert));

    alertMonitor.start();
    // Advance past the interval to trigger checkThresholds
    vi.advanceTimersByTime(150);

    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toHaveProperty("type");
    expect(alerts[0]).toHaveProperty("severity");
    expect(alerts[0]).toHaveProperty("message");
  });

  it("getAlerts() returns all alerts", () => {
    const alertMonitor = new ResourceMonitor({
      cpu_warning_threshold: 0,
      interval_ms: 100,
    });

    alertMonitor.start();
    vi.advanceTimersByTime(150);

    const alerts = alertMonitor.getAlerts();
    expect(alerts.length).toBeGreaterThan(0);
  });

  it("clearAlerts() removes all alerts", () => {
    const alertMonitor = new ResourceMonitor({
      cpu_warning_threshold: 0,
      interval_ms: 100,
    });

    alertMonitor.start();
    vi.advanceTimersByTime(150);
    expect(alertMonitor.getAlerts().length).toBeGreaterThan(0);

    alertMonitor.clearAlerts();
    expect(alertMonitor.getAlerts().length).toBe(0);
  });

  it("getReport() returns formatted string", () => {
    monitor.start();
    vi.advanceTimersByTime(100);

    const report = monitor.getReport();
    expect(report).toContain("Resource Report");
    expect(report).toContain("CPU");
    expect(report).toContain("Memory");
    expect(report).toContain("Network");
  });

  it("getReport() returns message when no data", () => {
    const m = new ResourceMonitor();
    const report = m.getReport();
    expect(report).toContain("No resource data");
  });

  it("custom thresholds are respected", () => {
    const customMonitor = new ResourceMonitor({
      cpu_warning_threshold: 50,
      cpu_critical_threshold: 90,
      memory_warning_threshold: 60,
      memory_critical_threshold: 95,
      interval_ms: 1000,
    });

    customMonitor.start();
    vi.advanceTimersByTime(100);

    // Should not throw
    expect(customMonitor.getLatestSnapshot()).not.toBeNull();
  });

  it("onAlert callback is invoked", () => {
    const callback = vi.fn();
    const alertMonitor = new ResourceMonitor({
      cpu_warning_threshold: 0,
      interval_ms: 100,
    });

    alertMonitor.onAlert(callback);
    alertMonitor.start();
    vi.advanceTimersByTime(150);

    expect(callback).toHaveBeenCalled();
  });
});
