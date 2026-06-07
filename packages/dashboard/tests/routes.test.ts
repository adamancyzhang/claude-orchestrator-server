// API endpoint unit tests for all dashboard routes
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import http from "node:http";
import { DashboardServer } from "../src/server.js";

let tempDir: string;
let stateDir: string;
let staticDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-test-"));
  stateDir = path.join(tempDir, "state");
  staticDir = path.join(tempDir, "public");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(staticDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeState(state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));
}

describe("GET /api/state", () => {
  it("returns 404 when state file missing", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/state`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("State file not found");
    } finally {
      await server.stop();
    }
  });

  it("returns state data", async () => {
    const state = { workers: [{ id: "w1" }], tasks: [] };
    writeState(state);
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/state`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(state);
    } finally {
      await server.stop();
    }
  });
});

describe("GET /api/workers", () => {
  it("returns workers list", async () => {
    const state = { workers: [{ id: "w1", status: "active" }, { id: "w2", status: "idle" }] };
    writeState(state);
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/workers`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workers).toHaveLength(2);
      expect(body.workers[0].id).toBe("w1");
    } finally {
      await server.stop();
    }
  });

  it("returns empty workers when none exist", async () => {
    writeState({ tasks: [] });
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/workers`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workers).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

describe("GET /api/tasks", () => {
  it("returns pending and in-progress tasks", async () => {
    const state = {
      pending_tasks: [{ id: "t1" }],
      in_progress_tasks: [{ id: "t2" }],
    };
    writeState(state);
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/tasks`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pending).toHaveLength(1);
      expect(body.in_progress).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});

describe("GET /api/events", () => {
  it("returns events list", async () => {
    const state = { events: [{ type: "task_created", timestamp: "2026-01-01" }] };
    writeState(state);
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/events`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.events).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("returns empty events when none exist", async () => {
    writeState({});
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/events`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.events).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

describe("GET /api/chains", () => {
  it("returns chains extracted from state", async () => {
    const state = {
      events: [
        { type: "chain_activated", chain_id: "c1", timestamp: "2026-01-01T00:00:00Z" },
      ],
      pending_tasks: [{ id: "t1", chain_id: "c1" }],
      in_progress_tasks: [],
    };
    writeState(state);
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/chains`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.chains).toHaveLength(1);
      expect(body.chains[0].chain_id).toBe("c1");
      expect(body.chains[0].status).toBe("active");
      expect(body.chains[0].task_count).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it("marks closed chains", async () => {
    const state = {
      events: [
        { type: "chain_activated", chain_id: "c1", timestamp: "2026-01-01T00:00:00Z" },
        { type: "chain_closed", chain_id: "c1", timestamp: "2026-01-01T01:00:00Z" },
      ],
      pending_tasks: [],
      in_progress_tasks: [],
    };
    writeState(state);
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/chains`);
      const body = await res.json();
      expect(body.chains[0].status).toBe("closed");
    } finally {
      await server.stop();
    }
  });

  it("marks merge_failed chains", async () => {
    const state = {
      events: [
        { type: "chain_activated", chain_id: "c1", timestamp: "2026-01-01T00:00:00Z" },
        { type: "chain_merge_failed", chain_id: "c1", timestamp: "2026-01-01T01:00:00Z" },
      ],
      pending_tasks: [],
      in_progress_tasks: [],
    };
    writeState(state);
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/chains`);
      const body = await res.json();
      expect(body.chains[0].status).toBe("merge_failed");
    } finally {
      await server.stop();
    }
  });
});

describe("GET /api/health", () => {
  it("returns health status", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    } finally {
      await server.stop();
    }
  });
});

describe("GET /api/docs", () => {
  it("returns JSON docs by default", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/docs`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("returns HTML docs when Accept: text/html", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/docs`, {
        headers: { Accept: "text/html" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    } finally {
      await server.stop();
    }
  });
});

describe("POST /api/send", () => {
  it("accepts valid JSON command", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "execute", task_id: "t1" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("rejects invalid JSON", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop();
    }
  });
});

describe("404 for unknown routes", () => {
  it("returns 404 for unmatched API routes", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/nonexistent`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Not found");
    } finally {
      await server.stop();
    }
  });
});

describe("CORS headers", () => {
  it("includes CORS headers in API responses", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/health`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await server.stop();
    }
  });

  it("handles OPTIONS preflight", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/health`, {
        method: "OPTIONS",
      });
      expect(res.status).toBe(204);
    } finally {
      await server.stop();
    }
  });
});
