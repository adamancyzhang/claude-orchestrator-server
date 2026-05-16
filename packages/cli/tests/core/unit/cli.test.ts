// CORE-RETENTION
// Locks in: CLI bin exists, exposes the version banner with the wire-format
//   protocol identifier (PROTOCOL_VERSION = 0.6.0). The CLI is the only
//   user-visible entry point; the protocol tag in the banner is the contract
//   for users running `claude-orchestrator --version` to discover the wire
//   version their cluster speaks.
// Core path because: every other package boots via the CLI; if the bin is
//   broken or the protocol banner drifts, users cannot detect version
//   mismatches.
// Owner subsystem: cli.
// Primary source files exercised:
//   - packages/cli/src/index.ts

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const BIN = path.join(REPO_ROOT, "bin", "claude-orchestrator");

describe("claude-orchestrator CLI", () => {
  it("--version reports 0.6.0 with protocol tag", () => {
    const out = execFileSync("node", [BIN, "--version"], { encoding: "utf-8" });
    expect(out.trim()).toBe("0.6.0 (protocol 0.6.0)");
  });

  it("config outputs JSON with protocol_version", () => {
    const out = execFileSync("node", [BIN, "config"], { encoding: "utf-8" });
    const parsed = JSON.parse(out);
    expect(parsed.protocol_version).toBe("0.6.0");
    expect(parsed.zookeeper.hosts).toBeTruthy();
    expect(parsed.commands.claude_cli).toContain("claude");
  });
});
