import type { ILogger } from "@co/contracts";

/** Comparison operators for threshold rules. */
export type ComparisonOperator = "gt" | "gte" | "lt" | "lte" | "eq";

/** Severity level for alerts. */
export type AlertSeverity = "warning" | "critical";

/** States in the alert lifecycle. */
export type AlertState = "ok" | "pending" | "firing" | "resolved";

/**
 * A configurable alert rule.
 *
 * Rules evaluate a metric value against a threshold. If the condition
 * holds for `durationMs` consecutive evaluation cycles, the alert fires.
 * When the condition clears, the alert transitions to "resolved" after
 * the same duration.
 */
export interface AlertRuleConfig {
  /** Unique rule identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Description of what this alert monitors. */
  description: string;
  /** Severity level. */
  severity: AlertSeverity;
  /** Function that returns the current metric value. */
  metricValue: () => number;
  /** Threshold value to compare against. */
  threshold: number;
  /** How the metric value is compared to the threshold. */
  operator: ComparisonOperator;
  /** How long the condition must hold before firing (ms). */
  durationMs: number;
}

/** A snapshot of an alert rule's current state. */
export interface AlertRuleSnapshot {
  id: string;
  name: string;
  description: string;
  severity: AlertSeverity;
  state: AlertState;
  /** The current metric value at last evaluation. */
  currentValue: number;
  threshold: number;
  operator: ComparisonOperator;
  /** Timestamp when the condition first became true. */
  triggeredAt: number | null;
  /** Timestamp when the alert last fired. */
  firedAt: number | null;
  /** Timestamp when the alert last resolved. */
  resolvedAt: number | null;
}

/**
 * Evaluate a metric value against a threshold using the given operator.
 */
export function evaluateCondition(
  value: number,
  operator: ComparisonOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
  }
}

/**
 * Mutable alert state tracked by the AlertManager for each rule.
 */
export interface AlertRuntimeState {
  rule: AlertRuleConfig;
  state: AlertState;
  currentValue: number;
  triggeredAt: number | null;
  firedAt: number | null;
  resolvedAt: number | null;
  /** Timestamp when the condition last changed. */
  conditionChangedAt: number | null;
}

/**
 * Create a new runtime state entry for a rule.
 */
export function createRuntimeState(rule: AlertRuleConfig): AlertRuntimeState {
  return {
    rule,
    state: "ok",
    currentValue: rule.metricValue(),
    triggeredAt: null,
    firedAt: null,
    resolvedAt: null,
    conditionChangedAt: null,
  };
}

/**
 * Serialize a runtime state to a snapshot.
 */
export function toSnapshot(state: AlertRuntimeState): AlertRuleSnapshot {
  return {
    id: state.rule.id,
    name: state.rule.name,
    description: state.rule.description,
    severity: state.rule.severity,
    state: state.state,
    currentValue: state.currentValue,
    threshold: state.rule.threshold,
    operator: state.rule.operator,
    triggeredAt: state.triggeredAt,
    firedAt: state.firedAt,
    resolvedAt: state.resolvedAt,
  };
}
