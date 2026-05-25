// CORE-RETENTION
// Locks in: CoError subclasses carry stable string `code` properties, preserve
// `cause`, and reflect the class name through `name`. Subclass-specific fields
// (conflict_files, stderr, retry counts) round-trip through the constructor.
// Critical because: chain-router / orchestrator / merge-validator all branch
// on `instanceof <subclass>` AND on `code === "..."`; if either contract drifts
// the error-routing taxonomy silently collapses into the catch-all path and
// merge-locked / network errors get retried like ordinary conflicts.
// Primary sources: packages/contracts/src/errors.ts

import { describe, expect, it } from "vitest";
import {
  ChainConflictError,
  ClaudeRunnerError,
  CoError,
  CommitFailedError,
  GitNetworkError,
  GitPermissionError,
  HookError,
  MagicDepthExhaustedError,
  MergeConflictError,
  OrphanRetryExhaustedError,
  ProtocolVersionMismatchError,
  RebaseConflictError,
  TemplateNotFoundError,
  ValidationError,
  WorktreeError,
  WorktreeLockedError,
  ZkError,
  ZkNodeExistsError,
  ZkNodeNotFoundError,
  ZkSessionExpiredError,
} from "../src/errors.js";

describe("CoError base", () => {
  it("stores code, message, cause, and inherits Error", () => {
    const cause = new Error("inner");
    const e = new CoError("X_CODE", "bad", cause);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(CoError);
    expect(e.code).toBe("X_CODE");
    expect(e.message).toBe("bad");
    expect(e.cause).toBe(cause);
    expect(e.name).toBe("CoError");
  });

  it("reflects subclass constructor name through `name`", () => {
    expect(new ValidationError("v").name).toBe("ValidationError");
    expect(new ZkNodeNotFoundError().name).toBe("ZkNodeNotFoundError");
  });
});

describe("ZK error taxonomy", () => {
  it("ZkSessionExpiredError carries code ZK_SESSION_EXPIRED", () => {
    const e = new ZkSessionExpiredError();
    expect(e).toBeInstanceOf(ZkError);
    expect(e.code).toBe("ZK_SESSION_EXPIRED");
  });

  it("ZkNodeExistsError carries code ZK_NODE_EXISTS", () => {
    const e = new ZkNodeExistsError();
    expect(e).toBeInstanceOf(ZkError);
    expect(e.code).toBe("ZK_NODE_EXISTS");
  });

  it("ZkNodeNotFoundError carries code ZK_NODE_NOT_FOUND", () => {
    const e = new ZkNodeNotFoundError();
    expect(e).toBeInstanceOf(ZkError);
    expect(e.code).toBe("ZK_NODE_NOT_FOUND");
  });
});

describe("protocol / validation errors", () => {
  it("ValidationError code is VALIDATION_FAILED and preserves cause", () => {
    const cause = { issues: ["x"] };
    const e = new ValidationError("bad payload", cause);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.cause).toBe(cause);
  });

  it("ProtocolVersionMismatchError embeds expected/actual in message", () => {
    const e = new ProtocolVersionMismatchError("0.7.0", "0.6.0");
    expect(e.code).toBe("PROTOCOL_VERSION_MISMATCH");
    expect(e.message).toContain("0.7.0");
    expect(e.message).toContain("0.6.0");
  });
});

describe("runtime errors", () => {
  it("ClaudeRunnerError preserves the spawn cause", () => {
    const cause = new Error("ENOENT claude");
    const e = new ClaudeRunnerError("CLI failed", cause);
    expect(e.code).toBe("CLAUDE_RUNNER_FAILED");
    expect(e.cause).toBe(cause);
  });

  it("TemplateNotFoundError mentions the template name", () => {
    const e = new TemplateNotFoundError("workflow/decompose.md");
    expect(e.code).toBe("TEMPLATE_NOT_FOUND");
    expect(e.message).toContain("workflow/decompose.md");
  });

  it("HookError code is HOOK_FAILED", () => {
    expect(new HookError("h").code).toBe("HOOK_FAILED");
  });
});

describe("business errors carry their structured fields", () => {
  it("MergeConflictError keeps conflict_files", () => {
    const e = new MergeConflictError("conflicts", ["a.ts", "b.ts"]);
    expect(e.code).toBe("MERGE_CONFLICT");
    expect(e.conflict_files).toEqual(["a.ts", "b.ts"]);
  });

  it("MergeConflictError defaults conflict_files to []", () => {
    const e = new MergeConflictError("c");
    expect(e.conflict_files).toEqual([]);
  });

  it("WorktreeError code is WORKTREE_FAILED", () => {
    expect(new WorktreeError("w").code).toBe("WORKTREE_FAILED");
  });

  it("WorktreeLockedError exposes stderr (defaults to '')", () => {
    const a = new WorktreeLockedError("locked");
    expect(a.code).toBe("WORKTREE_LOCKED");
    expect(a.stderr).toBe("");
    const b = new WorktreeLockedError("locked", "index.lock");
    expect(b.stderr).toBe("index.lock");
  });

  it("GitPermissionError + GitNetworkError carry stderr and stable codes", () => {
    const p = new GitPermissionError("denied", "fatal: permission");
    expect(p.code).toBe("GIT_PERMISSION_DENIED");
    expect(p.stderr).toBe("fatal: permission");

    const n = new GitNetworkError("net", "could not resolve host");
    expect(n.code).toBe("GIT_NETWORK_FAILED");
    expect(n.stderr).toBe("could not resolve host");
  });

  it("RebaseConflictError keeps conflict_files", () => {
    const e = new RebaseConflictError("rebase failed", ["x.ts"]);
    expect(e.code).toBe("REBASE_CONFLICT");
    expect(e.conflict_files).toEqual(["x.ts"]);
  });

  it("CommitFailedError keeps stderr verbatim", () => {
    const e = new CommitFailedError("commit failed", "hook rejected");
    expect(e.code).toBe("WORKER_COMMIT_FAILED");
    expect(e.stderr).toBe("hook rejected");
  });

  it("OrphanRetryExhaustedError encodes taskId + retry count in message", () => {
    const e = new OrphanRetryExhaustedError("t-1", 3);
    expect(e.code).toBe("ORPHAN_RETRY_EXHAUSTED");
    expect(e.message).toContain("t-1");
    expect(e.message).toContain("3");
  });

  it("ChainConflictError stores existing_status / existing_completed_at", () => {
    const a = new ChainConflictError("c-1", "completed", "2025-01-01T00:00:00Z");
    expect(a.code).toBe("CHAIN_ID_CONFLICT");
    expect(a.existing_status).toBe("completed");
    expect(a.existing_completed_at).toBe("2025-01-01T00:00:00Z");
    expect(a.message).toContain("c-1");
    expect(a.message).toContain("completed");
    expect(a.message).toContain("2025-01-01T00:00:00Z");

    const b = new ChainConflictError("c-2", "running", null);
    expect(b.message).toContain("c-2");
    expect(b.message).not.toContain("closed at");
  });

  it("MagicDepthExhaustedError encodes both depth and cap", () => {
    const e = new MagicDepthExhaustedError(5, 3);
    expect(e.code).toBe("MAGIC_DEPTH_EXHAUSTED");
    expect(e.chain_depth).toBe(5);
    expect(e.max_chains).toBe(3);
    expect(e.message).toContain("5");
    expect(e.message).toContain("3");
  });
});
