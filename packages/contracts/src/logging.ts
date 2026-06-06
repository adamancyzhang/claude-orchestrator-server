export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ILogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(namespace: string): ILogger;
}

/** No-op logger for tests and silent operation. */
export const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

// --- Metrics interfaces ---

export interface IMetricsCollector {
  /** Export all metrics in Prometheus text exposition format. */
  format(): string;
  /** Create a snapshot of all metrics as a plain object. */
  snapshot(): Record<string, unknown>;
}
