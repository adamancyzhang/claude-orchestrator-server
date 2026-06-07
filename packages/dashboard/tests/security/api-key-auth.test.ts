import { describe, expect, it, vi } from "vitest";
import { createApiKeyAuth, sendApiKeyUnauthorized } from "../../src/security/api-key-auth.js";
import type { IncomingMessage, ServerResponse } from "node:http";

function createMockRequest(
  headers: Record<string, string> = {},
  url?: string,
): IncomingMessage {
  return {
    headers,
    url: url ?? "/api/test",
  } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
  return res;
}

describe("createApiKeyAuth", () => {
  it("returns unauthenticated when no keys configured", () => {
    const auth = createApiKeyAuth({ keys: [] });
    const req = createMockRequest({ "x-api-key": "test-key" });
    const result = auth(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("No API keys configured");
  });

  it("returns unauthenticated when header is missing", () => {
    const auth = createApiKeyAuth({ keys: ["valid-key"] });
    const req = createMockRequest({});
    const result = auth(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("Missing API key");
  });

  it("returns authenticated for valid API key in header", () => {
    const auth = createApiKeyAuth({ keys: ["valid-key"] });
    const req = createMockRequest({ "x-api-key": "valid-key" });
    const result = auth(req);
    expect(result.authenticated).toBe(true);
    expect(result.keyId).toBe("key-0");
  });

  it("returns unauthenticated for invalid API key", () => {
    const auth = createApiKeyAuth({ keys: ["valid-key"] });
    const req = createMockRequest({ "x-api-key": "wrong-key" });
    const result = auth(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("Invalid API key");
  });

  it("uses custom header name", () => {
    const auth = createApiKeyAuth({
      keys: ["my-key"],
      headerName: "Authorization",
    });
    const req = createMockRequest({ authorization: "my-key" });
    const result = auth(req);
    expect(result.authenticated).toBe(true);
  });

  it("returns correct keyId for multiple keys", () => {
    const auth = createApiKeyAuth({ keys: ["key-a", "key-b", "key-c"] });
    const req = createMockRequest({ "x-api-key": "key-b" });
    const result = auth(req);
    expect(result.authenticated).toBe(true);
    expect(result.keyId).toBe("key-1");
  });

  it("rejects query param by default", () => {
    const auth = createApiKeyAuth({ keys: ["valid-key"] });
    const req = createMockRequest({}, "/api/test?api_key=valid-key");
    const result = auth(req);
    expect(result.authenticated).toBe(false);
  });

  it("accepts query param when allowQueryParam is true", () => {
    const auth = createApiKeyAuth({ keys: ["valid-key"], allowQueryParam: true });
    const req = createMockRequest({}, "/api/test?api_key=valid-key");
    const result = auth(req);
    expect(result.authenticated).toBe(true);
  });

  it("uses custom query param name", () => {
    const auth = createApiKeyAuth({
      keys: ["valid-key"],
      allowQueryParam: true,
      queryParam: "key",
    });
    const req = createMockRequest({}, "/api/test?key=valid-key");
    const result = auth(req);
    expect(result.authenticated).toBe(true);
  });
});

describe("sendApiKeyUnauthorized", () => {
  it("sends 401 with default message", () => {
    const res = createMockResponse();
    sendApiKeyUnauthorized(res);
    expect(res.writeHead).toHaveBeenCalledWith(401, {
      "Content-Type": "application/json",
    });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Unauthorized" }));
  });

  it("sends 401 with custom message", () => {
    const res = createMockResponse();
    sendApiKeyUnauthorized(res, "Invalid API key");
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Invalid API key" }));
  });
});
