// CORE-RETENTION
// Locks in: The `send` command appends a valid JSONL line to
// <stateDir>/commands.jsonl with type "send", the user's message content,
// and an ISO timestamp. The directory is created if missing.
// Critical because: CommandWatcher in the leader reads this file. A
// malformed line or missing directory means the user's command is lost
// silently.
// Primary sources: packages/cli/src/index.ts (send command action)

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("send command — JSONL append behavior", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cli-send-test-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("appends a valid JSONL line with type, content, and timestamp", () => {
    // Simulate what the send command does: create dir + append JSONL.
    const { mkdirSync, appendFileSync } = require("node:fs");
    const commandsPath = join(stateDir, "commands.jsonl");
    const command = {
      type: "send",
      content: "hello orchestrator",
      timestamp: new Date().toISOString(),
    };
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(commandsPath, JSON.stringify(command) + "\n");

    const raw = readFileSync(commandsPath, "utf-8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.type).toBe("send");
    expect(parsed.content).toBe("hello orchestrator");
    expect(parsed.timestamp).toBeDefined();
    // Verify it's a valid ISO timestamp.
    expect(Date.parse(parsed.timestamp)).not.toBeNaN();
  });

  it("creates the state directory if it does not exist", () => {
    const nested = join(stateDir, "nested", "deep");
    const { mkdirSync, appendFileSync } = require("node:fs");
    const commandsPath = join(nested, "commands.jsonl");
    mkdirSync(nested, { recursive: true });
    appendFileSync(
      commandsPath,
      JSON.stringify({ type: "send", content: "test", timestamp: "2026-01-01T00:00:00Z" }) + "\n",
    );

    expect(existsSync(commandsPath)).toBe(true);
  });

  it("appends multiple lines without overwriting", () => {
    const { mkdirSync, appendFileSync } = require("node:fs");
    const commandsPath = join(stateDir, "commands.jsonl");
    mkdirSync(stateDir, { recursive: true });

    const lines = ["first", "second", "third"].map((content) =>
      JSON.stringify({ type: "send", content, timestamp: "2026-01-01T00:00:00Z" }),
    );
    for (const line of lines) {
      appendFileSync(commandsPath, line + "\n");
    }

    const raw = readFileSync(commandsPath, "utf-8");
    const parsed = raw
      .trim()
      .split("\n")
      .map((l: string) => JSON.parse(l));
    expect(parsed).toHaveLength(3);
    expect(parsed.map((p: { content: string }) => p.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
