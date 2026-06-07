import { describe, expect, it, vi } from "vitest";
import { createAuditLogger } from "../../src/security/audit-log.js";
import type { IncomingMessage } from "node:http";

function createMockRequest(
  overrides: Partial<{
    url: string;
    method: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
  }> = {},
): IncomingMessage {
  return {
    url: overrides.url ?? "/api/test",
    method: overrides.method ?? "GET",
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.socket?.remoteAddress ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("createAuditLogger", () => {
  it("records auth success events", () => {
    const logger = createAuditLogger();
    const req = createMockRequest();
    logger.authSuccess(req, "key-0");

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("auth_success");
    expect(entries[0].keyId).toBe("key-0");
    expect(entries[0].ip).toBe("127.0.0.1");
    expect(entries[0].path).toBe("/api/test");
  });

  it("records auth failure events with reason", () => {
    const logger = createAuditLogger();
    const req = createMockRequest();
    logger.authFailure(req, "Invalid token");

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("auth_failure");
    expect(entries[0].detail).toBe("Invalid token");
  });

  it("records access events", () => {
    const logger = createAuditLogger();
    const req = createMockRequest({ url: "/api/state" });
    logger.access(req);

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("api_access");
    expect(entries[0].path).toBe("/api/state");
  });

  it("records rate limit events", () => {
    const logger = createAuditLogger();
    const req = createMockRequest();
    logger.rateLimitExceeded(req);

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("rate_limit_exceeded");
  });

  it("records invalid input events", () => {
    const logger = createAuditLogger();
    const req = createMockRequest();
    logger.invalidInput(req, "Body too large");

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("invalid_input");
    expect(entries[0].detail).toBe("Body too large");
  });

  it("records command sent events", () => {
    const logger = createAuditLogger();
    const req = createMockRequest();
    logger.commandSent(req, "key-1");

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("command_sent");
    expect(entries[0].keyId).toBe("key-1");
  });

  it("filters entries by event type", () => {
    const logger = createAuditLogger();
    const req = createMockRequest();
    logger.authSuccess(req);
    logger.authFailure(req);
    logger.authSuccess(req);

    expect(logger.getEntriesByType("auth_success")).toHaveLength(2);
    expect(logger.getEntriesByType("auth_failure")).toHaveLength(1);
    expect(logger.getEntriesByType("api_access")).toHaveLength(0);
  });

  it("calls custom log function", () => {
    const logFn = vi.fn();
    const logger = createAuditLogger({ logFn });
    const req = createMockRequest();
    logger.authSuccess(req);

    expect(logFn).toHaveBeenCalledTimes(1);
    expect(logFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "auth_success" }),
    );
  });

  it("includes user agent when present", () => {
    const logger = createAuditLogger();
    const req = createMockRequest({
      headers: { "user-agent": "test-agent/1.0" },
    });
    logger.access(req);

    const entries = logger.getEntries();
    expect(entries[0].userAgent).toBe("test-agent/1.0");
  });

  it("includes timestamp", () => {
    const logger = createAuditLogger();
    const req = createMockRequest();
    logger.access(req);

    const entries = logger.getEntries();
    expect(entries[0].timestamp).toBeDefined();
    // Verify it's a valid ISO date string
    expect(new Date(entries[0].timestamp).toISOString()).toBe(entries[0].timestamp);
  });

  it("clears entries", () => {
    const logger = createAuditLogger();
    const req = createMockRequest();
    logger.access(req);
    logger.authSuccess(req);
    expect(logger.getEntries()).toHaveLength(2);

    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });
});
