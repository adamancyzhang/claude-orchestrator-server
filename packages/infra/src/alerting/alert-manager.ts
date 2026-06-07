import type { ILogger } from "@co/contracts";
import type {
  AlertRuleConfig,
  AlertRuntimeState,
  AlertRuleSnapshot,
  AlertState,
} from "./alert-rule.js";
import { createRuntimeState, evaluateCondition, toSnapshot } from "./alert-rule.js";
import type { Notifier, AlertEvent } from "./notifier.js";
import { AlertHistory } from "./alert-history.js";

export interface AlertManagerOptions {
  logger?: ILogger;
  /** Notifiers to receive alert events. */
  notifiers?: Notifier[];
  /** Maximum history entries to retain (default: 100). */
  historySize?: number;
}

/**
 * Manages alert rules and their lifecycle.
 *
 * Call `evaluate()` periodically (e.g. on a timer) to check all rules
 * and trigger notifications on state transitions.
 *
 * State machine per rule:
 *   ok → pending → firing → resolved → ok
 *        ↑                     |
 *        +---------------------+
 *
 * - ok → pending: condition becomes true
 * - pending → firing: condition held for durationMs
 * - firing → resolved: condition becomes false
 * - resolved → ok: condition held false for durationMs (immediate in v1)
 */
export class AlertManager {
  private readonly states = new Map<string, AlertRuntimeState>();
  private readonly notifiers: Notifier[];
  private readonly logger?: ILogger;
  private readonly history: AlertHistory;

  constructor(opts: AlertManagerOptions = {}) {
    this.logger = opts.logger;
    this.notifiers = opts.notifiers ?? [];
    this.history = new AlertHistory(opts.historySize ?? 100);
  }

  /**
   * Register an alert rule.
   */
  addRule(rule: AlertRuleConfig): void {
    if (this.states.has(rule.id)) {
      throw new Error(`alert rule "${rule.id}" already registered`);
    }
    this.states.set(rule.id, createRuntimeState(rule));
  }

  /**
   * Remove an alert rule by ID.
   */
  removeRule(ruleId: string): boolean {
    return this.states.delete(ruleId);
  }

  /**
   * Get a snapshot of a specific rule's state.
   */
  getRule(ruleId: string): AlertRuleSnapshot | undefined {
    const state = this.states.get(ruleId);
    return state ? toSnapshot(state) : undefined;
  }

  /**
   * Get snapshots of all registered rules.
   */
  getAllRules(): AlertRuleSnapshot[] {
    return Array.from(this.states.values()).map(toSnapshot);
  }

  /**
   * Get rules filtered by state.
   */
  getRulesByState(state: AlertState): AlertRuleSnapshot[] {
    return this.getAllRules().filter((r) => r.state === state);
  }

  /**
   * Get the alert history, optionally filtered by rule ID.
   */
  getHistory(ruleId?: string) {
    return this.history.getEntries(ruleId);
  }

  /**
   * Evaluate all rules and fire notifications on state transitions.
   * Should be called periodically.
   */
  async evaluate(): Promise<void> {
    const now = Date.now();

    for (const [, state] of this.states) {
      state.currentValue = state.rule.metricValue();
      const conditionMet = evaluateCondition(
        state.currentValue,
        state.rule.operator,
        state.rule.threshold,
      );

      switch (state.state) {
        case "ok":
          if (conditionMet) {
            state.state = "pending";
            state.conditionChangedAt = now;
          }
          break;

        case "pending":
          if (!conditionMet) {
            // Condition cleared before duration elapsed — back to ok.
            state.state = "ok";
            state.conditionChangedAt = null;
          } else if (
            state.conditionChangedAt !== null &&
            now - state.conditionChangedAt >= state.rule.durationMs
          ) {
            // Condition held long enough — fire.
            state.state = "firing";
            state.firedAt = now;
            state.triggeredAt = state.conditionChangedAt;
            await this.emit(state, "firing", now);
          }
          break;

        case "firing":
          if (!conditionMet) {
            state.state = "resolved";
            state.conditionChangedAt = now;
            await this.emit(state, "resolved", now);
          }
          break;

        case "resolved":
          // Immediately return to ok.
          state.state = "ok";
          state.conditionChangedAt = null;
          state.resolvedAt = now;
          break;
      }
    }
  }

  /**
   * Force-evaluate a specific rule (useful for testing).
   */
  async evaluateRule(ruleId: string): Promise<void> {
    const state = this.states.get(ruleId);
    if (!state) throw new Error(`rule "${ruleId}" not found`);

    // Re-run evaluate — we need to check all rules since evaluate iterates.
    // For a single rule, we inline the logic.
    const now = Date.now();
    state.currentValue = state.rule.metricValue();
    const conditionMet = evaluateCondition(
      state.currentValue,
      state.rule.operator,
      state.rule.threshold,
    );

    switch (state.state) {
      case "ok":
        if (conditionMet) {
          state.state = "pending";
          state.conditionChangedAt = now;
        }
        break;
      case "pending":
        if (!conditionMet) {
          state.state = "ok";
          state.conditionChangedAt = null;
        } else if (
          state.conditionChangedAt !== null &&
          now - state.conditionChangedAt >= state.rule.durationMs
        ) {
          state.state = "firing";
          state.firedAt = now;
          state.triggeredAt = state.conditionChangedAt;
          await this.emit(state, "firing", now);
        }
        break;
      case "firing":
        if (!conditionMet) {
          state.state = "resolved";
          state.conditionChangedAt = now;
          await this.emit(state, "resolved", now);
        }
        break;
      case "resolved":
        state.state = "ok";
        state.conditionChangedAt = null;
        state.resolvedAt = now;
        break;
    }
  }

  private async emit(
    state: AlertRuntimeState,
    transition: "firing" | "resolved",
    timestamp: number,
  ): Promise<void> {
    const snapshot = toSnapshot(state);
    const event: AlertEvent = { rule: snapshot, transition, timestamp };

    this.history.record(event);

    const msg = `alert ${transition}: [${snapshot.severity}] ${snapshot.name}`;
    if (transition === "firing" && snapshot.severity === "critical") {
      this.logger?.error(msg);
    } else if (transition === "firing") {
      this.logger?.warn(msg);
    } else {
      this.logger?.info(msg);
    }

    for (const notifier of this.notifiers) {
      try {
        await notifier.notify(event);
      } catch (err) {
        this.logger?.error(`notifier "${notifier.name}" failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
