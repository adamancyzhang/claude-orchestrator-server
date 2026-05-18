// CORE-RETENTION
// Locks in: every CoError subclass exposes a stable `code` string the
//   log-aggregation / monitoring layer references. Renaming a code is a
//   user-visible break.
// Core path because: stable error codes are the only mechanism for cross-
//   subsystem error classification — alerts and recovery state machines key
//   off `code`, never `message`.
// Owner subsystem: contracts.
// Primary source files exercised:
//   - packages/contracts/src/errors.ts

import { describe, expect, it } from "vitest";
import {
  ClaudeRunnerError,
  HookError,
  MagicDepthExhaustedError,
  MergeConflictError,
  OrphanRetryExhaustedError,
  ProtocolVersionMismatchError,
  TemplateNotFoundError,
  ValidationError,
  WorktreeError,
  ZkNodeExistsError,
  ZkNodeNotFoundError,
  ZkSessionExpiredError,
} from "../../../src/index.js";

const EXPECTED_CODES: ReadonlyArray<[new (...a: never[]) => Error, string]> = [
  [ZkSessionExpiredError, "ZK_SESSION_EXPIRED"],
  [ZkNodeExistsError, "ZK_NODE_EXISTS"],
  [ZkNodeNotFoundError, "ZK_NODE_NOT_FOUND"],
  [ValidationError, "VALIDATION_FAILED"],
  [ProtocolVersionMismatchError, "PROTOCOL_VERSION_MISMATCH"],
  [ClaudeRunnerError, "CLAUDE_RUNNER_FAILED"],
  [TemplateNotFoundError, "TEMPLATE_NOT_FOUND"],
  [HookError, "HOOK_FAILED"],
  [MergeConflictError, "MERGE_CONFLICT"],
  [WorktreeError, "WORKTREE_FAILED"],
  [OrphanRetryExhaustedError, "ORPHAN_RETRY_EXHAUSTED"],
  // v0.7 NEW — FR-34 lock for --magic-max-chains demotion path.
  [MagicDepthExhaustedError, "MAGIC_DEPTH_EXHAUSTED"],
];

describe("CoError subclasses expose stable codes", () => {
  it.each(EXPECTED_CODES)("%s -> %s", (Ctor, expected) => {
    const instance =
      Ctor === ProtocolVersionMismatchError
        ? new ProtocolVersionMismatchError("0.5.0", "0.4.1")
        : Ctor === TemplateNotFoundError
        ? new TemplateNotFoundError("foo.md")
        : Ctor === MergeConflictError
        ? new MergeConflictError("conflict", [])
        : Ctor === OrphanRetryExhaustedError
        ? new OrphanRetryExhaustedError("task-1", 3)
        : Ctor === MagicDepthExhaustedError
        ? new MagicDepthExhaustedError(3, 3)
        : new (Ctor as new (msg?: string) => Error)("test");
    expect((instance as unknown as { code: string }).code).toBe(expected);
  });
});
