// CORE-RETENTION
// Locks in: pure name + role assignment helpers — assignRoles fills 5 roles
//   before defaulting to extra builders; generateWorkerNames consumes the
//   builtin 20-name pool first then falls back to alphabet-suffix
//   placeholders; both skip names already in use.
// Core path because: name and role assignment is durable across restarts;
//   regressions here silently re-issue names that collide with existing
//   worktrees on disk.
// Owner subsystem: orchestrator.
// Primary source files exercised:
//   - packages/orchestrator/src/worktree-initializer.ts

import { describe, expect, it } from "vitest";
import {
  BUILTIN_NAMES,
  ROLE_PRIORITY,
  assignRoles,
  generateFallbackNames,
  generateWorkerNames,
} from "../../../src/index.js";

describe("assignRoles", () => {
  it("returns ROLE_PRIORITY[:count] for small counts", () => {
    expect(assignRoles(1)).toEqual(["planner"]);
    expect(assignRoles(3)).toEqual(["planner", "builder", "verifier"]);
    expect(assignRoles(5)).toEqual(ROLE_PRIORITY);
  });

  it("fills overflow with additional builders", () => {
    expect(assignRoles(7)).toEqual([
      ...ROLE_PRIORITY,
      "builder",
      "builder",
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
