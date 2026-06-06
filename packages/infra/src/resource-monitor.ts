import * as os from "node:os";
import type { ILogger } from "@co/contracts";

export interface ResourceSnapshot {
  /** CPU usage percentage (0-100) */
  cpu_usage_percent: number;
  /** Memory usage in bytes */
  memory_used_bytes: number;
  /** Total memory in bytes */
  memory_total_bytes: number;
  /** Memory usage percentage (0-100) */
  memory_usage_percent: number;
  /** Free memory in bytes */
  memory_free_bytes: number;
  /** Network bytes received */
  network_rx_bytes: number;
  /** Network bytes transmitted */
  network_tx_bytes: number;
  /** Timestamp of the snapshot */
  timestamp: string;
  /** Process ID */
  pid: number;
}

export interface ResourceAlert {
  type: "cpu" | "memory" | "network";
  severity: "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
  timestamp: string;
}

export interface ResourceMonitorOptions {
  /** Logger instance */
  logger?: ILogger;
  /** CPU warning threshold (default: 80%) */
  cpu_warning_threshold?: number;
  /** CPU critical threshold (default: 95%) */
  cpu_critical_threshold?: number;
  /** Memory warning threshold (default: 80%) */
  memory_warning_threshold?: number;
  /** Memory critical threshold (default: 95%) */
  memory_critical_threshold?: number;
  /** Monitoring interval in ms (default: 5000) */
  interval_ms?: number;
}

/**
 * Monitors system resources (CPU, memory, network) for the orchestrator.
 * Provides snapshots and alerts for load balancing decisions.
 *
 * Usage:
 *   const monitor = new ResourceMonitor({ logger });
 *   monitor.start();
 *   const snapshot = monitor.getLatestSnapshot();
 *   monitor.stop();
 */
export class ResourceMonitor {
  private logger?: ILogger;
  private cpu_warning_threshold: number;
  private cpu_critical_threshold: number;
  private memory_warning_threshold: number;
  private memory_critical_threshold: number;
  private interval_ms: number;
  private interval_timer: ReturnType<typeof setInterval> | null = null;
  private latest_snapshot: ResourceSnapshot | null = null;
  private alerts: ResourceAlert[] = [];
  private on_alert?: (alert: ResourceAlert) => void;
  private prev_cpu_times: { idle: number; total: number } | null = null;
  private prev_network_rx = 0;
  private prev_network_tx = 0;

  constructor(opts: ResourceMonitorOptions = {}) {
    this.logger = opts.logger;
    this.cpu_warning_threshold = opts.cpu_warning_threshold ?? 80;
    this.cpu_critical_threshold = opts.cpu_critical_threshold ?? 95;
    this.memory_warning_threshold = opts.memory_warning_threshold ?? 80;
    this.memory_critical_threshold = opts.memory_critical_threshold ?? 95;
    this.interval_ms = opts.interval_ms ?? 5000;
  }

  /**
   * Set callback for resource alerts.
   */
  onAlert(callback: (alert: ResourceAlert) => void): void {
    this.on_alert = callback;
  }

  /**
   * Start periodic resource monitoring.
   */
  start(): void {
    // Initialize network baseline
    this.updateNetworkBaseline();

    // Take initial snapshot
    this.latest_snapshot = this.collectSnapshot();

    this.interval_timer = setInterval(() => {
      this.latest_snapshot = this.collectSnapshot();
      this.checkThresholds(this.latest_snapshot);
    }, this.interval_ms);

    this.logger?.info("resource monitor started", {
      interval_ms: this.interval_ms,
      cpu_warning_threshold: this.cpu_warning_threshold,
      memory_warning_threshold: this.memory_warning_threshold,
    });
  }

  /**
   * Stop resource monitoring.
   */
  stop(): void {
    if (this.interval_timer) {
      clearInterval(this.interval_timer);
      this.interval_timer = null;
    }
    this.logger?.info("resource monitor stopped");
  }

  /**
   * Get the latest resource snapshot.
   */
  getLatestSnapshot(): ResourceSnapshot | null {
    return this.latest_snapshot;
  }

  /**
   * Get all alerts that have been generated.
   */
  getAlerts(): ResourceAlert[] {
    return [...this.alerts];
  }

  /**
   * Clear all alerts.
   */
  clearAlerts(): void {
    this.alerts = [];
  }

  /**
   * Collect a resource snapshot.
   */
  private collectSnapshot(): ResourceSnapshot {
    const cpu_usage = this.calculateCpuUsage();
    const memory = this.getMemoryUsage();
    const network = this.getNetworkUsage();

    return {
      cpu_usage_percent: cpu_usage,
      memory_used_bytes: memory.used,
      memory_total_bytes: memory.total,
      memory_usage_percent: memory.percent,
      memory_free_bytes: memory.free,
      network_rx_bytes: network.rx,
      network_tx_bytes: network.tx,
      timestamp: new Date().toISOString(),
      pid: process.pid,
    };
  }

  /**
   * Calculate CPU usage percentage.
   * Uses the same approach as the `top` command.
   */
  private calculateCpuUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    }

    const currentIdle = totalIdle / cpus.length;
    const currentTotal = totalTick / cpus.length;

    if (this.prev_cpu_times) {
      const idleDiff = currentIdle - this.prev_cpu_times.idle;
      const totalDiff = currentTotal - this.prev_cpu_times.total;
      this.prev_cpu_times = { idle: currentIdle, total: currentTotal };

      if (totalDiff === 0) return 0;
      return Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100));
    }

    this.prev_cpu_times = { idle: currentIdle, total: currentTotal };
    return 0;
  }

  /**
   * Get memory usage information.
   */
  private getMemoryUsage(): { used: number; total: number; free: number; percent: number } {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const percent = total > 0 ? (used / total) * 100 : 0;

    return { used, total, free, percent };
  }

  /**
   * Get network usage from /proc/net/dev on Linux or via os.networkInterfaces().
   * Note: This is a simplified implementation. For accurate network metrics,
   * consider using a dedicated library or reading from /proc/net/dev.
   */
  private getNetworkUsage(): { rx: number; tx: number } {
    // On Linux, we could read from /proc/net/dev for accurate values
    // For now, return the cumulative values from our tracking
    return {
      rx: this.prev_network_rx,
      tx: this.prev_network_tx,
    };
  }

  /**
   * Update network baseline (call periodically to track changes).
   */
  private updateNetworkBaseline(): void {
    try {
      // Try to read from /proc/net/dev on Linux
      const fs = require("node:fs");
      if (fs.existsSync("/proc/net/dev")) {
        const content = fs.readFileSync("/proc/net/dev", "utf-8");
        const lines = content.split("\n");
        let totalRx = 0;
        let totalTx = 0;

        for (const line of lines) {
          // Skip header lines
          if (line.includes("Inter") || line.includes("face")) continue;

          const parts = line.trim().split(/\s+/);
          if (parts.length >= 10 && parts[0].includes(":")) {
            totalRx += parseInt(parts[1], 10) || 0;
            totalTx += parseInt(parts[9], 10) || 0;
          }
        }

        this.prev_network_rx = totalRx;
        this.prev_network_tx = totalTx;
      }
    } catch {
      // If we can't read network stats, just use zeros
      this.prev_network_rx = 0;
      this.prev_network_tx = 0;
    }
  }

  /**
   * Check resource thresholds and generate alerts.
   */
  private checkThresholds(snapshot: ResourceSnapshot): void {
    // Check CPU thresholds
    if (snapshot.cpu_usage_percent >= this.cpu_critical_threshold) {
      this.createAlert({
        type: "cpu",
        severity: "critical",
        message: `CPU usage critical: ${snapshot.cpu_usage_percent.toFixed(1)}%`,
        value: snapshot.cpu_usage_percent,
        threshold: this.cpu_critical_threshold,
        timestamp: snapshot.timestamp,
      });
    } else if (snapshot.cpu_usage_percent >= this.cpu_warning_threshold) {
      this.createAlert({
        type: "cpu",
        severity: "warning",
        message: `CPU usage high: ${snapshot.cpu_usage_percent.toFixed(1)}%`,
        value: snapshot.cpu_usage_percent,
        threshold: this.cpu_warning_threshold,
        timestamp: snapshot.timestamp,
      });
    }

    // Check memory thresholds
    if (snapshot.memory_usage_percent >= this.memory_critical_threshold) {
      this.createAlert({
        type: "memory",
        severity: "critical",
        message: `Memory usage critical: ${snapshot.memory_usage_percent.toFixed(1)}%`,
        value: snapshot.memory_usage_percent,
        threshold: this.memory_critical_threshold,
        timestamp: snapshot.timestamp,
      });
    } else if (snapshot.memory_usage_percent >= this.memory_warning_threshold) {
      this.createAlert({
        type: "memory",
        severity: "warning",
        message: `Memory usage high: ${snapshot.memory_usage_percent.toFixed(1)}%`,
        value: snapshot.memory_usage_percent,
        threshold: this.memory_warning_threshold,
        timestamp: snapshot.timestamp,
      });
    }
  }

  /**
   * Create and store an alert.
   */
  private createAlert(alert: ResourceAlert): void {
    this.alerts.push(alert);

    // Log the alert
    if (alert.severity === "critical") {
      this.logger?.error(`RESOURCE ALERT [${alert.type}]: ${alert.message}`, {
        value: alert.value,
        threshold: alert.threshold,
      });
    } else {
      this.logger?.warn(`RESOURCE ALERT [${alert.type}]: ${alert.message}`, {
        value: alert.value,
        threshold: alert.threshold,
      });
    }

    // Call the alert callback if set
    this.on_alert?.(alert);
  }

  /**
   * Get a formatted resource report.
   */
  getReport(): string {
    const snapshot = this.latest_snapshot;
    if (!snapshot) {
      return "No resource data available";
    }

    const lines = [
      "=== Resource Report ===",
      `Timestamp: ${snapshot.timestamp}`,
      `PID: ${snapshot.pid}`,
      "",
      "CPU:",
      `  Usage: ${snapshot.cpu_usage_percent.toFixed(1)}%`,
      "",
      "Memory:",
      `  Used: ${this.formatBytes(snapshot.memory_used_bytes)}`,
      `  Total: ${this.formatBytes(snapshot.memory_total_bytes)}`,
      `  Free: ${this.formatBytes(snapshot.memory_free_bytes)}`,
      `  Usage: ${snapshot.memory_usage_percent.toFixed(1)}%`,
      "",
      "Network:",
      `  RX: ${this.formatBytes(snapshot.network_rx_bytes)}`,
      `  TX: ${this.formatBytes(snapshot.network_tx_bytes)}`,
      "",
      `Alerts: ${this.alerts.length}`,
    ];

    return lines.join("\n");
  }

  /**
   * Format bytes to human readable string.
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }
}
