// CORE-RETENTION
// Locks in: CLI bin exists, exposes the version banner with the wire-format
//   protocol identifier (PROTOCOL_VERSION = 0.7.0). The CLI is the only
//   user-visible entry point; the protocol tag in the banner is the contract
//   for users running `claude-orchestrator --version` to discover the wire
//   version their cluster speaks.
// v0.7 NEW: the `run` subcommand accepts `--magic` and `--magic-max-chains`
//   flags (FR-32 / FR-34). The flag-parsing block must reject non-numeric or
//   <1 values for `--magic-max-chains` — drift here would let an invalid cap
//   reach the leader where the demotion arithmetic assumes a positive int.
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
  it("--version reports 0.7.0 with protocol tag", () => {
    const out = execFileSync("node", [BIN, "--version"], { encoding: "utf-8" });
    expect(out.trim()).toBe("0.7.0 (protocol 0.7.0)");
  });

  it("config outputs JSON with protocol_version", () => {
    const out = execFileSync("node", [BIN, "config"], { encoding: "utf-8" });
    const parsed = JSON.parse(out);
    expect(parsed.protocol_version).toBe("0.7.0");
    expect(parsed.zookeeper.hosts).toBeTruthy();
    expect(parsed.commands.claude_cli).toContain("claude");
  });

  // v0.7 NEW — FR-32 / FR-34 flag surface. `run --help` is the cheapest
  // way to assert both flags are wired without booting the orchestrator
  // (which would require ZK).
  it("`run --help` advertises --magic and --magic-max-chains (FR-32 / FR-34)", () => {
    const out = execFileSync("node", [BIN, "run", "--help"], {
      encoding: "utf-8",
    });
    expect(out).toContain("--magic");
    expect(out).toContain("--magic-max-chains");
  });
});
