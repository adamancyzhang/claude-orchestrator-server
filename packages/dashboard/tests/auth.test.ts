// CORE-RETENTION
// Locks in: Authentication middleware — token validation, error handling.
// Critical because: Auth protects the send endpoint from unauthorized commands.
// A broken auth either blocks all access or allows unauthorized commands.
// Primary sources: packages/dashboard/src/auth.ts

import { describe, expect, it, vi } from "vitest";
import { createAuthMiddleware, sendUnauthorized } from "../src/auth.js";
import type { IncomingMessage, ServerResponse } from "node:http";

function createMockRequest(headers: Record<string, string> = {}): IncomingMessage {
  return {
    headers,
  } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

describe("createAuthMiddleware", () => {
  it("returns authenticated when auth is disabled", () => {
    const middleware = createAuthMiddleware({ enabled: false, tokens: [] });
    const req = createMockRequest();
    const result = middleware(req);
    expect(result.authenticated).toBe(true);
  });

  it("returns unauthenticated when no Authorization header", () => {
    const middleware = createAuthMiddleware({ enabled: true, tokens: ["token123"] });
    const req = createMockRequest({});
    const result = middleware(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("Missing Authorization header");
  });

  it("returns unauthenticated for invalid format", () => {
    const middleware = createAuthMiddleware({ enabled: true, tokens: ["token123"] });
    const req = createMockRequest({ authorization: "Basic token123" });
    const result = middleware(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("Invalid Authorization format");
  });

  it("returns unauthenticated for empty token", () => {
    const middleware = createAuthMiddleware({ enabled: true, tokens: ["token123"] });
    const req = createMockRequest({ authorization: "Bearer " });
    const result = middleware(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("Empty token");
  });

  it("returns unauthenticated for invalid token", () => {
    const middleware = createAuthMiddleware({ enabled: true, tokens: ["token123"] });
    const req = createMockRequest({ authorization: "Bearer wrongtoken" });
    const result = middleware(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("Invalid token");
  });

  it("returns authenticated for valid token", () => {
    const middleware = createAuthMiddleware({ enabled: true, tokens: ["token123"] });
    const req = createMockRequest({ authorization: "Bearer token123" });
    const result = middleware(req);
    expect(result.authenticated).toBe(true);
  });

  it("returns authenticated for one of multiple valid tokens", () => {
    const middleware = createAuthMiddleware({ enabled: true, tokens: ["token1", "token2", "token3"] });
    const req = createMockRequest({ authorization: "Bearer token2" });
    const result = middleware(req);
    expect(result.authenticated).toBe(true);
  });

  it("returns unauthenticated when no tokens configured", () => {
    const middleware = createAuthMiddleware({ enabled: true, tokens: [] });
    const req = createMockRequest({ authorization: "Bearer token123" });
    const result = middleware(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("No tokens configured");
  });
});

describe("sendUnauthorized", () => {
  it("sends 401 response with default message", () => {
    const res = createMockResponse();
    sendUnauthorized(res);
    expect(res.writeHead).toHaveBeenCalledWith(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="dashboard"',
    });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Unauthorized" }));
  });

  it("sends 401 response with custom message", () => {
    const res = createMockResponse();
    sendUnauthorized(res, "Invalid token");
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Invalid token" }));
  });
});
