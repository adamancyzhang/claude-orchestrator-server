// CORE-RETENTION
// Locks in: ROLE_WEIGHTS matrix invariants — each role weights its own link
//   highest (100), other roles' links carry 10-20 (still claimable but not
//   preferred), and `leader` carries 0 across the board (Leader does not
//   claim ordinary tasks).
// Core path because: TaskQueue.claim() sorts pending tasks by ROLE_WEIGHTS;
//   a regression here misroutes work between Workers.
// Owner subsystem: contracts.
// Primary source files exercised:
//   - packages/contracts/src/roleWeights.ts
//   - (consumed by) packages/coordination/src/task-queue.ts

import { describe, expect, it } from "vitest";
import { ROLE_WEIGHTS } from "../../../src/index.js";

describe("ROLE_WEIGHTS", () => {
  it("gives each role 100 on its own link", () => {
    expect(ROLE_WEIGHTS.planner.plan).toBe(100);
    expect(ROLE_WEIGHTS.builder.build).toBe(100);
    expect(ROLE_WEIGHTS.verifier.verify).toBe(100);
    expect(ROLE_WEIGHTS.reviewer.review).toBe(100);
    expect(ROLE_WEIGHTS.accepter.accept).toBe(100);
  });

  it("leader weight is 0 for every link", () => {
    for (const link of ["plan", "build", "verify", "review", "accept"] as const) {
      expect(ROLE_WEIGHTS.leader[link]).toBe(0);
    }
  });

  it("non-own links are always > 0 for non-leader roles", () => {
    for (const role of [
      "planner",
      "builder",
      "verifier",
      "reviewer",
      "accepter",
    ] as const) {
      for (const link of ["plan", "build", "verify", "review", "accept"] as const) {
        expect(ROLE_WEIGHTS[role][link]).toBeGreaterThan(0);
      }
    }
  });
});
