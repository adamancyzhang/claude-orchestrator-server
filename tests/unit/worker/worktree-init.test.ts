import { describe, it, expect } from "vitest";
import {
  assignRoles,
  generateFallbackNames,
  generateWorkerNames,
  BUILTIN_NAMES,
  ROLE_PRIORITY,
} from "../../../src/worker/worktree-initializer.js";

describe("assignRoles", () => {
  it("returns the first N priority roles when N <= priority length", () => {
    expect(assignRoles(0)).toEqual([]);
    expect(assignRoles(1)).toEqual(["planner"]);
    expect(assignRoles(ROLE_PRIORITY.length)).toEqual(ROLE_PRIORITY);
  });

  it("fills remaining slots with builder when N exceeds priority length", () => {
    const roles = assignRoles(7);
    expect(roles.slice(0, ROLE_PRIORITY.length)).toEqual(ROLE_PRIORITY);
    expect(roles.slice(ROLE_PRIORITY.length)).toEqual(["builder", "builder"]);
  });
});

describe("generateFallbackNames", () => {
  it("skips already-used names", () => {
    const names = generateFallbackNames(5, ["A", "Aay"]);
    expect(names).not.toContain("A");
    expect(names).not.toContain("Aay");
    expect(names).toHaveLength(5);
  });

  it("produces exactly count names", () => {
    expect(generateFallbackNames(10, [])).toHaveLength(10);
  });
});

describe("generateWorkerNames", () => {
  it("uses built-in names when none are taken", () => {
    const assignments = generateWorkerNames(3, new Set());
    expect(assignments).toHaveLength(3);
    expect(BUILTIN_NAMES).toContain(assignments[0].name);
  });

  it("falls back to alphabet names when built-ins are exhausted", () => {
    const used = new Set(BUILTIN_NAMES);
    const assignments = generateWorkerNames(3, used);
    expect(assignments).toHaveLength(3);
    // Fallback names follow the A/Aay/Aee/Aie pattern
    for (const a of assignments) {
      expect(BUILTIN_NAMES).not.toContain(a.name);
    }
  });

  it("assigns roles in priority order", () => {
    const assignments = generateWorkerNames(5, new Set());
    expect(assignments.map((a) => a.role)).toEqual(ROLE_PRIORITY);
  });
});
