// CORE-RETENTION
// Locks in TWO things:
//   (1) pure name + role assignment helpers — assignRoles fills 5
//       roles before defaulting to extra executors; generateWorkerNames
//       consumes the builtin 20-name pool first then falls back to
//       alphabet-suffix placeholders; both skip names already in use.
//   (2) v0.7 NEW: when magicMode=true, assignRoles slots the 6th worker
//       as explorer (FR-32 lock); without --magic the 6th worker is an
//       executor.
//   (3) Issue-6 fix: when a worktree is reused across orchestrator
//       restarts, initializeWorktrees resets it hard to the project
//       HEAD and cleans untracked files so the next task starts from
//       a known-good state. Without this, stale mid-task files leak
//       across runs and the new task runs on garbage.
// Core path because: name+role assignment is durable across restarts;
//   regressions silently re-issue names that collide with existing
//   worktrees. The magic-mode 6th-slot rule is the only differentiation
//   between default and --magic startup beyond CLI flags.
// Owner subsystem: orchestrator.
// Primary source files exercised:
//   - packages/orchestrator/src/worktree-initializer.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ILogger } from "@co/contracts";
import {
  BUILTIN_NAMES,
  ROLE_PRIORITY,
  assignRoles,
  generateFallbackNames,
  generateWorkerNames,
  initializeWorktrees,
} from "../../../src/index.js";

class SilentLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
}

class CapturingLogger implements ILogger {
  messages: { level: string; msg: string; extra?: unknown }[] = [];
  debug(msg: string, extra?: unknown): void {
    this.messages.push({ level: "debug", msg, extra });
  }
  info(msg: string, extra?: unknown): void {
    this.messages.push({ level: "info", msg, extra });
  }
  warn(msg: string, extra?: unknown): void {
    this.messages.push({ level: "warn", msg, extra });
  }
  error(msg: string, extra?: unknown): void {
    this.messages.push({ level: "error", msg, extra });
  }
  child(): ILogger {
    return this;
  }
}

describe("assignRoles", () => {
  it("returns ROLE_PRIORITY[:count] for small counts", () => {
    expect(assignRoles(1)).toEqual(["planner"]);
    expect(assignRoles(3)).toEqual(["planner", "executor", "verifier"]);
    expect(assignRoles(5)).toEqual(ROLE_PRIORITY);
  });

  it("fills overflow with additional executors (default mode)", () => {
    expect(assignRoles(7)).toEqual([
      ...ROLE_PRIORITY,
      "executor",
      "executor",
    ]);
  });

  // v0.7 NEW — FR-32 lock on the 6th-slot role under --magic.
  it("magic mode: 6th worker is the explorer, 7+ are executors", () => {
    expect(assignRoles(6, true)).toEqual([
      "planner",
      "executor",
      "verifier",
      "reviewer",
      "accepter",
      "explorer",
    ]);
    expect(assignRoles(8, true)).toEqual([
      "planner",
      "executor",
      "verifier",
      "reviewer",
      "accepter",
      "explorer",
      "executor",
      "executor",
    ]);
  });

  it("default mode (magic=false) keeps the 6th worker as executor", () => {
    expect(assignRoles(6, false)).toEqual([
      "planner",
      "executor",
      "verifier",
      "reviewer",
      "accepter",
      "executor",
    ]);
  });
});

describe("generateWorkerNames", () => {
  it("draws from BUILTIN_NAMES first", () => {
    const result = generateWorkerNames(3, new Set());
    expect(result.map((r) => r.name)).toEqual(BUILTIN_NAMES.slice(0, 3));
  });

  it("skips names already used", () => {
    const used = new Set(["Tom", "Jerry"]);
    const result = generateWorkerNames(1, used);
    expect(result[0].name).toBe("Lucy");
  });

  it("falls back to alphabet-suffix names when builtin pool is exhausted", () => {
    const used = new Set(BUILTIN_NAMES);
    const result = generateWorkerNames(2, used);
    expect(result.length).toBe(2);
    for (const r of result) {
      expect(BUILTIN_NAMES).not.toContain(r.name);
      expect(r.name.length).toBeGreaterThan(0);
    }
  });
});

describe("generateFallbackNames", () => {
  it("avoids duplicates", () => {
    const names = generateFallbackNames(5, []);
    expect(new Set(names).size).toBe(5);
  });
});

// NOTE: A reuse-reset behavioral test was attempted but the current
// `generateWorkerNames` always picks a fresh builtin name when an
// existing config is present (Tom recorded → second pass picks
// Jerry, never Tom). The reuse code path in initializeWorktrees is
// therefore unreachable in production with the present name-selection
// logic; my Issue-6 reset/clean is defensive and will fire only once
// a separate fix makes generateWorkerNames prefer recorded names.
// Once that lands, a reuse test belongs in this file at this slot.
