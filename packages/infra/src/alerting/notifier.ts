import type { ILogger } from "@co/contracts";
import type { AlertRuleSnapshot } from "./alert-rule.js";

/**
 * An alert event sent to a notification channel.
 */
export interface AlertEvent {
  rule: AlertRuleSnapshot;
  /** The state transition that triggered this notification. */
  transition: "firing" | "resolved";
  timestamp: number;
}

/**
 * A notification channel delivers alert events to external systems.
 */
export interface Notifier {
  /** Send an alert event. */
  notify(event: AlertEvent): Promise<void>;
  /** Optional name for logging. */
  readonly name: string;
}

/**
 * Log-based notification channel. Writes alert events via the logger.
 */
export class LogNotifier implements Notifier {
  readonly name = "log";

  constructor(private readonly logger: ILogger) {}

  async notify(event: AlertEvent): Promise<void> {
    const msg = `ALERT ${event.transition.toUpperCase()}: [${event.rule.severity}] ${event.rule.name} — ${event.rule.description} (value: ${event.rule.currentValue}, threshold: ${event.rule.operator} ${event.rule.threshold})`;

    if (event.transition === "firing" && event.rule.severity === "critical") {
      this.logger.error(msg);
    } else if (event.transition === "firing") {
      this.logger.warn(msg);
    } else {
      this.logger.info(msg);
    }
  }
}

/**
 * Webhook-based notification channel. Sends alert events via HTTP POST.
 */
export class WebhookNotifier implements Notifier {
  readonly name = "webhook";

  constructor(
    private readonly url: string,
    private readonly options?: { timeoutMs?: number },
  ) {}

  async notify(event: AlertEvent): Promise<void> {
    const body = JSON.stringify({
      rule_id: event.rule.id,
      rule_name: event.rule.name,
      severity: event.rule.severity,
      transition: event.transition,
      description: event.rule.description,
      current_value: event.rule.currentValue,
      threshold: event.rule.threshold,
      operator: event.rule.operator,
      timestamp: event.timestamp,
    });

    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(this.options?.timeoutMs ?? 5000),
    });

    if (!res.ok) {
      throw new Error(`webhook notification failed: HTTP ${res.status} ${res.statusText}`);
    }
  }
}
