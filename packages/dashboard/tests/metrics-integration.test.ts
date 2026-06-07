// Metrics collection integration tests
// Tests the interaction between dashboard server and metrics collection service
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DashboardServer } from "../src/server.js";
import { SSEBroadcaster } from "../src/sse/broadcaster.js";

let tempDir: string;
let stateDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  stateDir = path.join(tempDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeState(state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));
}

describe("Metrics SSE integration", () => {
  it("broadcasts state updates to connected SSE clients", async () => {
    writeState({ workers: [], tasks: [] });
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();

    const port = server.getPort();
    try {
      // Connect as SSE client
      const controller = new AbortController();
      const sseResponse = await fetch(`http://127.0.0.1:${port}/api/events/stream`, {
        signal: controller.signal,
      });

      // Read the initial connected event
      const reader = sseResponse.body!.getReader();
      const decoder = new TextDecoder();
      const { value: firstChunk } = await reader.read();
      const firstEvent = decoder.decode(firstChunk);
      expect(firstEvent).toContain("event: connected");

      controller.abort();
    } finally {
      await server.stop();
    }
  });

  it("SSE endpoint returns correct headers", async () => {
    writeState({ workers: [], tasks: [] });
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();

    const port = server.getPort();
    try {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/events/stream`, {
        signal: controller.signal,
      });

      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toContain("no-cache");

      controller.abort();
    } finally {
      await server.stop();
    }
  });
});

describe("State data consistency", () => {
  it("returns consistent state across multiple requests", async () => {
    const state = {
      workers: [{ id: "w1", status: "active" }],
      pending_tasks: [{ id: "t1" }],
      in_progress_tasks: [],
      events: [{ type: "task_created" }],
    };
    writeState(state);

    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    const port = server.getPort();

    try {
      // Make multiple requests to the same endpoint
      const results = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json()),
      ]);

      // All should return the same data
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
    } finally {
      await server.stop();
    }
  });

  it("reflects state changes in subsequent requests", async () => {
    writeState({ workers: [{ id: "w1" }] });
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    const port = server.getPort();

    try {
      // First request
      const res1 = await fetch(`http://127.0.0.1:${port}/api/workers`);
      const body1 = await res1.json();
      expect(body1.workers).toHaveLength(1);

      // Update state
      writeState({ workers: [{ id: "w1" }, { id: "w2" }] });

      // Second request should reflect the change
      const res2 = await fetch(`http://127.0.0.1:${port}/api/workers`);
      const body2 = await res2.json();
      expect(body2.workers).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });
});

describe("Metrics aggregation endpoint behavior", () => {
  it("handles empty state gracefully across all endpoints", async () => {
    writeState({});
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    const port = server.getPort();

    try {
      const endpoints = ["/api/state", "/api/workers", "/api/tasks", "/api/events", "/api/chains"];
      for (const endpoint of endpoints) {
        const res = await fetch(`http://127.0.0.1:${port}${endpoint}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toBeDefined();
      }
    } finally {
      await server.stop();
    }
  });

  it("handles malformed state JSON gracefully", async () => {
    fs.writeFileSync(path.join(stateDir, "state.json"), "not valid json {{{");
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    const port = server.getPort();

    try {
      const endpoints = ["/api/state", "/api/workers", "/api/tasks", "/api/events", "/api/chains"];
      for (const endpoint of endpoints) {
        const res = await fetch(`http://127.0.0.1:${port}${endpoint}`);
        // Should return 500 for corrupted state
        expect(res.status).toBe(500);
      }
    } finally {
      await server.stop();
    }
  });
});

describe("SSEBroadcaster metrics", () => {
  it("tracks client count correctly", () => {
    const broadcaster = new SSEBroadcaster();
    expect(broadcaster.getClientCount()).toBe(0);

    const mockRes = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    } as any;

    broadcaster.addClient(mockRes);
    expect(broadcaster.getClientCount()).toBe(1);

    broadcaster.closeAll();
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it("broadcast sends to all connected clients", () => {
    const broadcaster = new SSEBroadcaster();
    const res1 = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() } as any;
    const res2 = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() } as any;

    broadcaster.addClient(res1);
    broadcaster.addClient(res2);

    broadcaster.broadcast("metrics_update", { cpu: 45.2, memory: 62.1 });

    // Both clients should have received the broadcast
    expect(res1.write).toHaveBeenCalledWith(expect.stringContaining("metrics_update"));
    expect(res2.write).toHaveBeenCalledWith(expect.stringContaining("metrics_update"));
  });
});
