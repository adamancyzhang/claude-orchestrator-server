// CORE-RETENTION
// Locks in: InteractiveInit — config file creation, defaults mode,
// existing config detection, and next steps display.
// Critical because: Init is the first interaction new users have with
// the orchestrator. A broken init means users cannot start using the tool.
// Primary sources: packages/cli/src/interactive-init.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runInteractiveInit, displayNextSteps } from "../src/interactive-init.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "init-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("runInteractiveInit", () => {
  it("creates config with defaults when --defaults flag is set", async () => {
    const result = await runInteractiveInit({
      defaults: true,
      cwd: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.config_path).toBe(path.join(tempDir, ".claude-orchestrator", "config.json"));

    // Verify config file was created
    const configPath = path.join(tempDir, ".claude-orchestrator", "config.json");
    expect(fs.existsSync(configPath)).toBe(true);

    // Verify config content
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.name).toBe("my-orchestrator");
    expect(config.zk_hosts).toBe("127.0.0.1:2181");
    expect(config.worker_count).toBe(6);
  });

  it("returns existing config message when config already exists", async () => {
    // Create config directory and file
    const configDir = path.join(tempDir, ".claude-orchestrator");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ name: "existing" }),
      "utf-8",
    );

    const result = await runInteractiveInit({
      defaults: true,
      cwd: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("already exists");
  });

  it("creates config directory if it doesn't exist", async () => {
    const result = await runInteractiveInit({
      defaults: true,
      cwd: tempDir,
    });

    expect(result.success).toBe(true);
    const configDir = path.join(tempDir, ".claude-orchestrator");
    expect(fs.existsSync(configDir)).toBe(true);
  });
});

describe("displayNextSteps", () => {
  it("displays next steps without throwing", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    displayNextSteps("/path/to/config.json");

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(output).toContain("Next Steps");
    expect(output).toContain("claude-orchestrator config");
    expect(output).toContain("claude-orchestrator run");

    consoleSpy.mockRestore();
  });

  it("displays shell completion instructions", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    displayNextSteps("/path/to/config.json");

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(output).toContain("completion");

    consoleSpy.mockRestore();
  });

  it("displays help command", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    displayNextSteps("/path/to/config.json");

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(output).toContain("--help");

    consoleSpy.mockRestore();
  });
});

describe("runInteractiveInit — edge cases", () => {
  it("handles nested directory creation", async () => {
    const nestedDir = path.join(tempDir, "a", "b", "c");
    const result = await runInteractiveInit({
      defaults: true,
      cwd: nestedDir,
    });

    expect(result.success).toBe(true);
    const configPath = path.join(nestedDir, ".claude-orchestrator", "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("config file contains valid JSON", async () => {
    const result = await runInteractiveInit({
      defaults: true,
      cwd: tempDir,
    });

    expect(result.success).toBe(true);
    const configPath = path.join(tempDir, ".claude-orchestrator", "config.json");
    const content = fs.readFileSync(configPath, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("config file has correct structure", async () => {
    const result = await runInteractiveInit({
      defaults: true,
      cwd: tempDir,
    });

    expect(result.success).toBe(true);
    const configPath = path.join(tempDir, ".claude-orchestrator", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    // Should have all expected keys
    expect(config).toHaveProperty("name");
    expect(config).toHaveProperty("zk_hosts");
    expect(config).toHaveProperty("worker_count");
  });

  it("existing config preserves original content", async () => {
    const configDir = path.join(tempDir, ".claude-orchestrator");
    fs.mkdirSync(configDir, { recursive: true });
    const originalConfig = { name: "original", custom_key: "custom_value" };
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(originalConfig),
      "utf-8",
    );

    const result = await runInteractiveInit({
      defaults: true,
      cwd: tempDir,
    });

    expect(result.success).toBe(true);
    // File should still contain original content (not overwritten)
    const config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf-8"));
    expect(config.name).toBe("original");
    expect(config.custom_key).toBe("custom_value");
  });

  it("returns config_path in result", async () => {
    const result = await runInteractiveInit({
      defaults: true,
      cwd: tempDir,
    });

    expect(result.config_path).toBeDefined();
    expect(result.config_path).toContain(".claude-orchestrator");
    expect(result.config_path).toContain("config.json");
  });

  it("returns appropriate message on success", async () => {
    const result = await runInteractiveInit({
      defaults: true,
      cwd: tempDir,
    });

    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });
});
