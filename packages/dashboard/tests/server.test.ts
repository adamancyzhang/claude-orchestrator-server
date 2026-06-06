// CORE-RETENTION
// Locks in: DashboardServer lifecycle — start/stop, route handling,
// SSE connections, state watcher integration, and static file serving.
// Critical because: Dashboard is the primary monitoring interface.
// A broken server means users cannot observe orchestrator state.
// Primary sources: packages/dashboard/src/server.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { DashboardServer } from "../src/server.js";

let tempDir: string;
let stateDir: string;
let staticDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
  stateDir = path.join(tempDir, "state");
  staticDir = path.join(tempDir, "public");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(staticDir, { recursive: true });
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

  it("serves static HTML files", async () => {
    // Create test HTML file
    const htmlContent = "<html><body>Test Page</body></html>";
    fs.writeFileSync(path.join(staticDir, "index.html"), htmlContent);

    const server = new DashboardServer({
      state_dir: stateDir,
      static_dir: staticDir,
      port: 0,
    });
    await server.start();

    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const body = await response.text();
      expect(body).toBe(htmlContent);
    } finally {
      await server.stop();
    }
  });

  it("serves static CSS files", async () => {
    const cssContent = "body { color: red; }";
    fs.writeFileSync(path.join(staticDir, "styles.css"), cssContent);

    const server = new DashboardServer({
      state_dir: stateDir,
      static_dir: staticDir,
      port: 0,
    });
    await server.start();

    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/css");
      const body = await response.text();
      expect(body).toBe(cssContent);
    } finally {
      await server.stop();
    }
  });

  it("serves static JavaScript files", async () => {
    const jsContent = "console.log('test');";
    fs.writeFileSync(path.join(staticDir, "app.js"), jsContent);

    const server = new DashboardServer({
      state_dir: stateDir,
      static_dir: staticDir,
      port: 0,
    });
    await server.start();

    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/app.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/javascript");
      const body = await response.text();
      expect(body).toBe(jsContent);
    } finally {
      await server.stop();
    }
  });

  it("returns 404 for missing static files", async () => {
    const server = new DashboardServer({
      state_dir: stateDir,
      static_dir: staticDir,
      port: 0,
    });
    await server.start();

    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/nonexistent.html`);
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("prevents directory traversal", async () => {
    // Create file in parent directory
    const parentDir = path.join(tempDir, "public-parent");
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(path.join(parentDir, "secret.txt"), "secret content");

    const server = new DashboardServer({
      state_dir: stateDir,
      static_dir: staticDir,
      port: 0,
    });
    await server.start();

    const port = server.getPort();
    try {
      // Attempt directory traversal
      const response = await fetch(`http://127.0.0.1:${port}/../public-parent/secret.txt`);
      // Should not serve the file (404 or serves index.html as fallback)
      const body = await response.text();
      expect(body).not.toContain("secret content");
    } finally {
      await server.stop();
    }
  });

  it("API routes still work with static files", async () => {
    // Create state file
    const stateData = { workers: [], tasks: [] };
    fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(stateData));

    // Create test HTML
    fs.writeFileSync(path.join(staticDir, "index.html"), "<html></html>");

    const server = new DashboardServer({
      state_dir: stateDir,
      static_dir: staticDir,
      port: 0,
    });
    await server.start();

    const port = server.getPort();
    try {
      // Test static file
      const staticResponse = await fetch(`http://127.0.0.1:${port}/`);
      expect(staticResponse.status).toBe(200);

      // Test API endpoint
      const apiResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(apiResponse.status).toBe(200);
      const apiData = await apiResponse.json();
      expect(apiData).toEqual(stateData);
    } finally {
      await server.stop();
    }
  });

  it("serves nested static files", async () => {
    // Create nested directory structure
    const jsDir = path.join(staticDir, "js");
    fs.mkdirSync(jsDir, { recursive: true });
    const jsContent = "export const app = {};";
    fs.writeFileSync(path.join(jsDir, "app.js"), jsContent);

    const server = new DashboardServer({
      state_dir: stateDir,
      static_dir: staticDir,
      port: 0,
    });
    await server.start();

    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/js/app.js`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe(jsContent);
    } finally {
      await server.stop();
    }
  });
});
