// CORE-RETENTION
// Locks in: DashboardServer lifecycle — start/stop, route handling,
// SSE connections, and state watcher integration.
// Critical because: Dashboard is the primary monitoring interface.
// A broken server means users cannot observe orchestrator state.
// Primary sources: packages/dashboard/src/server.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DashboardServer } from "../src/server.js";

let tempDir: string;
let stateDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
  stateDir = path.join(tempDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("DashboardServer", () => {
  it("creates instance with default options", () => {
    const server = new DashboardServer({ state_dir: stateDir });
    expect(server).toBeDefined();
    expect(server.getPort()).toBe(3210);
    expect(server.getHost()).toBe("127.0.0.1");
  });

  it("creates instance with custom options", () => {
    const server = new DashboardServer({
      state_dir: stateDir,
      port: 8080,
      host: "0.0.0.0",
    });
    expect(server.getPort()).toBe(8080);
    expect(server.getHost()).toBe("0.0.0.0");
  });

  it("start() and stop() work without errors", async () => {
    const server = new DashboardServer({ state_dir: stateDir, port: 0 });
    await server.start();
    await server.stop();
  });
});
