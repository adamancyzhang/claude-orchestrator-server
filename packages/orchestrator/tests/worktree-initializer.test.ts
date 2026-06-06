// CORE-RETENTION
// Locks in: WorktreeInitializer's behavior for worker name generation
// and role assignment:
//   - assignRoles returns correct roles for different worker counts
//   - generateWorkerNames respects used names and magic mode
//   - generateFallbackNames handles pool exhaustion
// Critical because: Worker names and roles are used throughout the system
// for identity, routing, and chain links. A regression here would cause
// name collisions or incorrect role assignments.
// Primary sources: packages/orchestrator/src/worktree-initializer.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assignRoles,
  generateWorkerNames,
  generateFallbackNames,
  BUILTIN_NAMES,
  ROLE_PRIORITY,
  MAGIC_ROLE_PRIORITY,
} from "../src/worktree-initializer.js";

describe("assignRoles", () => {
  it("should return correct roles for count <= priority length", () => {
    expect(assignRoles(3)).toEqual(["planner", "executor", "verifier"]);
  });

  it("should return full priority list for count = priority length", () => {
    expect(assignRoles(5)).toEqual(ROLE_PRIORITY);
  });

  it("should add executor roles for count > priority length", () => {
    const result = assignRoles(7);
    expect(result).toEqual([...ROLE_PRIORITY, "executor", "executor"]);
  });

  it("should use magic role priority when magicMode is true", () => {
    const result = assignRoles(6, true);
    expect(result).toEqual(MAGIC_ROLE_PRIORITY);
  });

  it("should add executor roles for magic mode when count > magic priority length", () => {
    const result = assignRoles(8, true);
    expect(result).toEqual([...MAGIC_ROLE_PRIORITY, "executor", "executor"]);
  });
});

describe("generateWorkerNames", () => {
  it("should generate names from builtin pool when available", () => {
    const usedNames = new Set<string>();
    const result = generateWorkerNames(3, usedNames);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("Tom");
    expect(result[1].name).toBe("Jerry");
    expect(result[2].name).toBe("Lucy");
  });

  it("should skip used names", () => {
    const usedNames = new Set(["Tom", "Jerry"]);
    const result = generateWorkerNames(3, usedNames);
    expect(result[0].name).toBe("Lucy");
    expect(result[1].name).toBe("Thomas");
    expect(result[2].name).toBe("Jack");
  });

  it("should use fallback names when builtin pool is exhausted", () => {
    const usedNames = new Set(BUILTIN_NAMES);
    const result = generateWorkerNames(3, usedNames);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("Tom2");
    expect(result[1].name).toBe("Jerry2");
    expect(result[2].name).toBe("Lucy2");
  });

  it("should respect magic mode role assignment", () => {
    const usedNames = new Set<string>();
    const result = generateWorkerNames(6, usedNames, true);
    expect(result).toHaveLength(6);
    expect(result[5].role).toBe("explorer");
  });
});

describe("generateFallbackNames", () => {
  it("should generate names with numeric suffix", () => {
    const used: string[] = [];
    const result = generateFallbackNames(3, used);
    expect(result).toEqual(["Tom2", "Jerry2", "Lucy2"]);
  });

  it("should skip already used names", () => {
    const used = ["Tom2", "Jerry2"];
    const result = generateFallbackNames(3, used);
    expect(result).toEqual(["Lucy2", "Thomas2", "Jack2"]);
  });

  it("should increment suffix when pool is exhausted", () => {
    const used = BUILTIN_NAMES.map((n) => `${n}2`);
    const result = generateFallbackNames(3, used);
    expect(result).toEqual(["Tom3", "Jerry3", "Lucy3"]);
  });
});
