// CORE-RETENTION
// Locks in: ROLE_WEIGHTS matrix invariants — each role weights its own link
//   highest (100), other roles' links carry 10-20 (still claimable but not
//   preferred), and `leader` carries 0 across the board (Leader does not
//   claim ordinary tasks).
// v0.7 NEW: matrix is now 7×6 with `executor` (rename of v0.6 `builder`),
//   `explorer` (new), and `explore` (new) column. Explorer×explore=100 is
//   the FR-31 lock that ensures explore tasks land on the explorer worker.
// Core path because: TaskQueue.claim() sorts pending tasks by ROLE_WEIGHTS;
//   a regression here misroutes work between Workers.
// Owner subsystem: contracts.
// Primary source files exercised:
//   - packages/contracts/src/roleWeights.ts
//   - (consumed by) packages/coordination/src/task-queue.ts

import { describe, expect, it } from "vitest";
import { ROLE_WEIGHTS } from "../../../src/index.js";

const ALL_LINKS = [
  "plan",
  "execute",
  "verify",
  "review",
  "accept",
  "explore",
] as const;

const WORKER_ROLES = [
  "planner",
  "executor",
  "verifier",
  "reviewer",
  "accepter",
  "explorer",
] as const;

describe("ROLE_WEIGHTS", () => {
  it("gives each role 100 on its own link", () => {
    expect(ROLE_WEIGHTS.planner.plan).toBe(100);
    expect(ROLE_WEIGHTS.executor.execute).toBe(100);
    expect(ROLE_WEIGHTS.verifier.verify).toBe(100);
    expect(ROLE_WEIGHTS.reviewer.review).toBe(100);
    expect(ROLE_WEIGHTS.accepter.accept).toBe(100);
    // v0.7 NEW — FR-31 lock.
    expect(ROLE_WEIGHTS.explorer.explore).toBe(100);
  });

  it("leader weight is 0 for every link", () => {
    for (const link of ALL_LINKS) {
      expect(ROLE_WEIGHTS.leader[link]).toBe(0);
    }
  });

  it("non-own links are always > 0 for non-leader roles (cross-role assist)", () => {
    for (const role of WORKER_ROLES) {
      for (const link of ALL_LINKS) {
        expect(ROLE_WEIGHTS[role][link]).toBeGreaterThan(0);
      }
    }
  });

  it("non-own weights stay in the 10..20 band", () => {
    for (const role of WORKER_ROLES) {
      for (const link of ALL_LINKS) {
        const w = ROLE_WEIGHTS[role][link];
        if (w === 100) continue;
        expect(w).toBeGreaterThanOrEqual(10);
        expect(w).toBeLessThanOrEqual(20);
      }
    }
  });
});
