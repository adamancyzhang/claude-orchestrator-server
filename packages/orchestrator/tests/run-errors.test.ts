import { describe, expect, it } from "vitest";
import { formatError, type OrchestratorError } from "../src/run.js";

describe("formatError", () => {
  it("formats E001 workspace error", () => {
    const err: OrchestratorError = {
      code: "E001",
      message: "Workspace has uncommitted changes",
      fix: "Run `git add -A && git commit` or `git stash` before starting.",
    };
    const result = formatError(err);
    expect(result).toBe(
      "[E001] Workspace has uncommitted changes\n" +
        "  Fix: Run `git add -A && git commit` or `git stash` before starting.",
    );
  });

  it("formats E002 ZooKeeper error with detail", () => {
    const err: OrchestratorError = {
      code: "E002",
      message: "ZooKeeper connection failed: connect ECONNREFUSED 127.0.0.1:2181",
      fix: "Check that ZooKeeper is running and reachable. Verify --zk-hosts or CO_ZK_HOSTS environment variable.",
    };
    const result = formatError(err);
    expect(result).toContain("[E002]");
    expect(result).toContain("ZooKeeper connection failed");
    expect(result).toContain("Fix:");
  });

  it("formats E003 config error", () => {
    const err: OrchestratorError = {
      code: "E003",
      message: "Configuration file missing or invalid: ENOENT",
      fix: "Run `claude-orchestrator init` to generate the default configuration.",
    };
    const result = formatError(err);
    expect(result).toContain("[E003]");
    expect(result).toContain("Fix:");
  });

  it("formats E004 commands.jsonl error", () => {
    const err: OrchestratorError = {
      code: "E004",
      message: "commands.jsonl not found",
      fix: "Ensure the state directory contains a commands.jsonl file.",
    };
    const result = formatError(err);
    expect(result).toContain("[E004]");
    expect(result).toContain("Fix:");
  });

  it("all error codes produce valid formatted output", () => {
    const codes: Array<{ code: OrchestratorError["code"]; msg: string }> = [
      { code: "E001", msg: "Workspace has uncommitted changes" },
      { code: "E002", msg: "ZooKeeper connection failed" },
      { code: "E003", msg: "Configuration file missing or invalid" },
      { code: "E004", msg: "commands.jsonl not found" },
    ];
    for (const { code, msg } of codes) {
      const err: OrchestratorError = { code, message: msg, fix: "fix it" };
      const result = formatError(err);
      expect(result).toContain(`[${code}]`);
      expect(result).toContain(msg);
      expect(result).toContain("Fix: fix it");
    }
  });
});
