// Audit logging for dashboard API access
// Records authentication attempts, access events, and security-relevant actions

import type { IncomingMessage } from "node:http";

export type AuditEventType =
  | "auth_success"
  | "auth_failure"
  | "api_access"
  | "rate_limit_exceeded"
  | "invalid_input"
  | "command_sent";

export interface AuditEntry {
  timestamp: string;
  event: AuditEventType;
  ip: string;
  path: string;
  method: string;
  userAgent?: string;
  keyId?: string;
  detail?: string;
}

export type AuditLogFn = (entry: AuditEntry) => void;

export interface AuditLoggerConfig {
  /** Custom log function. If not provided, entries are stored in memory (for testing). */
  logFn?: AuditLogFn;
  /** Whether to log request body metadata (never log actual body content) */
  logBodyMetadata?: boolean;
}

/**
 * Create an audit logger that records security-relevant events.
 */
export function createAuditLogger(config: AuditLoggerConfig = {}) {
  const entries: AuditEntry[] = [];
  const logFn = config.logFn;

  function log(
    event: AuditEventType,
    req: IncomingMessage,
    detail?: string,
    keyId?: string,
  ): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      event,
      ip: req.socket.remoteAddress ?? "unknown",
      path: req.url ?? "/",
      method: req.method ?? "UNKNOWN",
      userAgent: req.headers["user-agent"],
      keyId,
      detail,
    };

    entries.push(entry);
    logFn?.(entry);
  }

  return {
    /**
     * Log a successful authentication event.
     */
    authSuccess(req: IncomingMessage, keyId?: string): void {
      log("auth_success", req, undefined, keyId);
    },

    /**
     * Log a failed authentication attempt.
     */
    authFailure(req: IncomingMessage, reason?: string): void {
      log("auth_failure", req, reason);
    },

    /**
     * Log an API access event.
     */
    access(req: IncomingMessage, detail?: string): void {
      log("api_access", req, detail);
    },

    /**
     * Log a rate limit exceeded event.
     */
    rateLimitExceeded(req: IncomingMessage): void {
      log("rate_limit_exceeded", req);
    },

    /**
     * Log an invalid input event.
     */
    invalidInput(req: IncomingMessage, reason?: string): void {
      log("invalid_input", req, reason);
    },

    /**
     * Log a command sent event.
     */
    commandSent(req: IncomingMessage, keyId?: string): void {
      log("command_sent", req, undefined, keyId);
    },

    /**
     * Get all logged entries (for testing or inspection).
     */
    getEntries(): readonly AuditEntry[] {
      return entries;
    },

    /**
     * Get entries filtered by event type.
     */
    getEntriesByType(event: AuditEventType): AuditEntry[] {
      return entries.filter((e) => e.event === event);
    },

    /**
     * Clear all logged entries.
     */
    clear(): void {
      entries.length = 0;
    },
  };
}

export type AuditLogger = ReturnType<typeof createAuditLogger>;
