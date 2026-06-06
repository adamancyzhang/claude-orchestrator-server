// CORE-RETENTION
// Locks in: SSEBroadcaster — client management, event broadcasting,
// and connection lifecycle.
// Critical because: SSE is the primary real-time update mechanism.
// A broken broadcaster means dashboard clients don't receive updates.
// Primary sources: packages/dashboard/src/sse/broadcaster.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SSEBroadcaster } from "../src/sse/broadcaster.js";
import type { ServerResponse } from "node:http";

function createMockResponse(): ServerResponse {
  const res = {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  } as unknown as ServerResponse;
  return res;
}

describe("SSEBroadcaster", () => {
  let broadcaster: SSEBroadcaster;

  beforeEach(() => {
    broadcaster = new SSEBroadcaster();
  });

  it("creates instance", () => {
    expect(broadcaster).toBeDefined();
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it("addClient() returns a client ID", () => {
    const res = createMockResponse();
    const id = broadcaster.addClient(res);
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
  });

  it("addClient() sets SSE headers", () => {
    const res = createMockResponse();
    broadcaster.addClient(res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    }));
  });

  it("addClient() sends connected event", () => {
    const res = createMockResponse();
    broadcaster.addClient(res);
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining("event: connected"));
  });

  it("getClientCount() tracks connected clients", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    broadcaster.addClient(res1);
    broadcaster.addClient(res2);
    expect(broadcaster.getClientCount()).toBe(2);
  });

  it("removeClient() removes a client", () => {
    const res = createMockResponse();
    const id = broadcaster.addClient(res);
    broadcaster.removeClient(id);
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it("broadcast() sends event to all clients", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    broadcaster.addClient(res1);
    broadcaster.addClient(res2);

    broadcaster.broadcast("test", { value: 123 });

    expect(res1.write).toHaveBeenCalledWith(expect.stringContaining("event: test"));
    expect(res2.write).toHaveBeenCalledWith(expect.stringContaining("event: test"));
  });

  it("broadcast() sends JSON data", () => {
    const res = createMockResponse();
    broadcaster.addClient(res);

    broadcaster.broadcast("update", { key: "value" });

    // Check the broadcast call (index 1, since index 0 is the connected event)
    const call = res.write.mock.calls[1][0];
    expect(call).toContain('"key":"value"');
  });

  it("closeAll() removes all clients", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    broadcaster.addClient(res1);
    broadcaster.addClient(res2);

    broadcaster.closeAll();
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it("removeClient() is idempotent", () => {
    const res = createMockResponse();
    const id = broadcaster.addClient(res);
    broadcaster.removeClient(id);
    broadcaster.removeClient(id); // Should not throw
    expect(broadcaster.getClientCount()).toBe(0);
  });
});
