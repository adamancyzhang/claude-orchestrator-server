import type { ILogger, LogLevel } from "@co/contracts";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type LogFormat = "text" | "json";

export interface LoggerOptions {
  namespace?: string;
  level?: LogLevel;
  format?: LogFormat;
}

export class Logger implements ILogger {
  private readonly namespace: string;
  private readonly level: LogLevel;
  private readonly format: LogFormat;

  constructor(opts: LoggerOptions = {}) {
    this.namespace = opts.namespace ?? "co";
    this.level = opts.level ?? "info";
    this.format = opts.format ?? "text";
  }

  private write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    if (this.format === "json") {
      const entry = {
        ts: new Date().toISOString(),
        level,
        ns: this.namespace,
        msg,
        ...ctx,
      };
      const line = JSON.stringify(entry);
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    } else {
      const tag = `[${this.namespace}]`;
      const suffix = ctx && Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
      const line = `${tag} ${msg}${suffix}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.write("debug", msg, ctx);
  }
  info(msg: string, ctx?: Record<string, unknown>): void {
    this.write("info", msg, ctx);
  }
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.write("warn", msg, ctx);
  }
  error(msg: string, ctx?: Record<string, unknown>): void {
    this.write("error", msg, ctx);
  }
  child(namespace: string): ILogger {
    return new Logger({
      namespace: `${this.namespace}/${namespace}`,
      level: this.level,
      format: this.format,
    });
  }
}
