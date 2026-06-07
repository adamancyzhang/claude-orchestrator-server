// Security module integration tests
// Tests API key auth, input validation, and audit logging working together with the dashboard
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import http from "node:http";
import { createApiKeyAuth, sendApiKeyUnauthorized } from "../src/security/api-key-auth.js";
import {
  escapeHtml,
  sanitizeString,
  isSafeIdentifier,
  isPayloadSizeValid,
  validateJsonStructure,
} from "../src/security/input-validation.js";
import { createAuditLogger } from "../src/security/audit-log.js";
import { DashboardServer } from "../src/server.js";

let tempDir: string;
let stateDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-integ-test-"));
  stateDir = path.join(tempDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeState(state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));
}

describe("API key authentication integration", () => {
  it("creates middleware that validates keys from request", () => {
    const auth = createApiKeyAuth({ keys: ["test-key-123"] });

    // Valid key
    const validReq = { headers: { "x-api-key": "test-key-123" }, url: "/api/test" } as any;
    expect(auth(validReq).authenticated).toBe(true);

    // Invalid key
    const invalidReq = { headers: { "x-api-key": "wrong" }, url: "/api/test" } as any;
    expect(auth(invalidReq).authenticated).toBe(false);

    // Missing key
    const missingReq = { headers: {}, url: "/api/test" } as any;
    expect(auth(missingReq).authenticated).toBe(false);
  });

  it("supports custom header names", () => {
    const auth = createApiKeyAuth({ keys: ["my-key"], headerName: "Authorization" });
    const req = { headers: { authorization: "my-key" }, url: "/api/test" } as any;
    expect(auth(req).authenticated).toBe(true);
  });

  it("supports query parameter authentication when enabled", () => {
    const auth = createApiKeyAuth({ keys: ["key1"], allowQueryParam: true });
    const req = { headers: { host: "localhost" }, url: "/api/test?api_key=key1" } as any;
    expect(auth(req).authenticated).toBe(true);
  });

  it("rejects query param when not enabled", () => {
    const auth = createApiKeyAuth({ keys: ["key1"], allowQueryParam: false });
    const req = { headers: { host: "localhost" }, url: "/api/test?api_key=key1" } as any;
    expect(auth(req).authenticated).toBe(false);
  });

  it("returns correct keyId for matched key", () => {
    const auth = createApiKeyAuth({ keys: ["key-a", "key-b", "key-c"] });
    const req = { headers: { "x-api-key": "key-b" }, url: "/api/test" } as any;
    const result = auth(req);
    expect(result.authenticated).toBe(true);
    expect(result.keyId).toBe("key-1");
  });
});

describe("Input validation integration", () => {
  it("escapes HTML in user-provided strings", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;&#x2F;script&gt;"
    );
  });

  it("validates safe identifiers", () => {
    expect(isSafeIdentifier("worker-1")).toBe(true);
    expect(isSafeIdentifier("my_task.v2")).toBe(true);
    expect(isSafeIdentifier("task<script>")).toBe(false);
  });

  it("checks payload size limits", () => {
    expect(isPayloadSizeValid("small", 1024)).toBe(true);
    expect(isPayloadSizeValid("x".repeat(2048), 1024)).toBe(false);
  });

  it("validates JSON structure depth", () => {
    const shallow = { a: { b: 1 } };
    expect(validateJsonStructure(shallow, { maxDepth: 3 }).valid).toBe(true);

    const deep: any = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(validateJsonStructure(deep, { maxDepth: 3 }).valid).toBe(false);
  });

  it("validates JSON key count", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 100; i++) obj[`key${i}`] = i;
    expect(validateJsonStructure(obj, { maxObjectKeys: 50 }).valid).toBe(false);
  });
});

describe("Audit logging integration", () => {
  it("logs authentication events with request context", () => {
    const logger = createAuditLogger();
    const req = {
      url: "/api/send",
      method: "POST",
      headers: { "user-agent": "test-agent" },
      socket: { remoteAddress: "192.168.1.100" },
    } as any;

    logger.authSuccess(req, "key-0");
    logger.authFailure(req, "Invalid token");

    const entries = logger.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].event).toBe("auth_success");
    expect(entries[0].ip).toBe("192.168.1.100");
    expect(entries[0].path).toBe("/api/send");
    expect(entries[0].keyId).toBe("key-0");
    expect(entries[1].event).toBe("auth_failure");
    expect(entries[1].detail).toBe("Invalid token");
  });

  it("logs access and rate limit events", () => {
    const logger = createAuditLogger();
    const req = { url: "/api/state", method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;

    logger.access(req);
    logger.rateLimitExceeded(req);
    logger.invalidInput(req, "Body too large");

    const entries = logger.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.event)).toEqual(["api_access", "rate_limit_exceeded", "invalid_input"]);
  });

  it("filters entries by type", () => {
    const logger = createAuditLogger();
    const req = { url: "/", method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;

    logger.authSuccess(req);
    logger.authSuccess(req);
    logger.authFailure(req);

    expect(logger.getEntriesByType("auth_success")).toHaveLength(2);
    expect(logger.getEntriesByType("auth_failure")).toHaveLength(1);
  });

  it("calls custom log function", () => {
    const logFn = vi.fn();
    const logger = createAuditLogger({ logFn });
    const req = { url: "/", method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;

    logger.access(req);

    expect(logFn).toHaveBeenCalledTimes(1);
    expect(logFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "api_access" }),
    );
  });

  it("clears entries", () => {
    const logger = createAuditLogger();
    const req = { url: "/", method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;

    logger.access(req);
    logger.authSuccess(req);
    expect(logger.getEntries()).toHaveLength(2);

    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });
});

describe("Security middleware with HTTP server", () => {
  it("rejects requests without API key when auth is required", async () => {
    writeState({ workers: [] });

    // Create a simple server with API key auth
    const auth = createApiKeyAuth({ keys: ["valid-key"] });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname.startsWith("/api/")) {
        const result = auth(req);
        if (!result.authenticated) {
          sendApiKeyUnauthorized(res, result.error);
          return;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;
    const port = addr.port;

    try {
      // Without API key
      const res1 = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(res1.status).toBe(401);

      // With invalid API key
      const res2 = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { "X-API-Key": "wrong-key" },
      });
      expect(res2.status).toBe(401);

      // With valid API key
      const res3 = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { "X-API-Key": "valid-key" },
      });
      expect(res3.status).toBe(200);
      const body = await res3.json();
      expect(body.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("allows unauthenticated access to non-API routes", async () => {
    const auth = createApiKeyAuth({ keys: ["valid-key"] });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      // Only protect API routes
      if (url.pathname.startsWith("/api/")) {
        const result = auth(req);
        if (!result.authenticated) {
          sendApiKeyUnauthorized(res, result.error);
          return;
        }
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("public page");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;
    const port = addr.port;

    try {
      // Non-API route should be accessible without key
      const res = await fetch(`http://127.0.0.1:${port}/page`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("public page");
    } finally {
      server.close();
    }
  });
});
