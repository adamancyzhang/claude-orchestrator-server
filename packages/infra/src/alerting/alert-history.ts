import type { AlertEvent } from "./notifier.js";

/**
 * A single entry in the alert history.
 */
export interface AlertHistoryEntry {
  ruleId: string;
  ruleName: string;
  severity: string;
  transition: "firing" | "resolved";
  currentValue: number;
  threshold: number;
  operator: string;
  timestamp: number;
}

/**
 * In-memory alert history tracker. Stores recent alert events
 * with a configurable maximum size.
 */
export class AlertHistory {
  private readonly entries: AlertHistoryEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  /**
   * Record an alert event.
   */
  record(event: AlertEvent): void {
    this.entries.push({
      ruleId: event.rule.id,
      ruleName: event.rule.name,
      severity: event.rule.severity,
      transition: event.transition,
      currentValue: event.rule.currentValue,
      threshold: event.rule.threshold,
      operator: event.rule.operator,
      timestamp: event.timestamp,
    });

    // Evict oldest entries if over capacity.
    if (this.entries.length > this.maxSize) {
      this.entries.splice(0, this.entries.length - this.maxSize);
    }
  }

  /**
   * Get all history entries, optionally filtered by rule ID.
   */
  getEntries(ruleId?: string): AlertHistoryEntry[] {
    if (ruleId) {
      return this.entries.filter((e) => e.ruleId === ruleId);
    }
    return [...this.entries];
  }

  /**
   * Get the count of entries.
   */
  count(): number {
    return this.entries.length;
  }

  /**
   * Clear all history entries.
   */
  clear(): void {
    this.entries.length = 0;
  }
}
