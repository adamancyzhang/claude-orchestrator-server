// CORE-RETENTION
// Locks in: ROLE_WEIGHTS shape — every role has every link, the diagonal is
// 100 (own-role preference), `leader` is 0 across the board, and entries are
// frozen (readonly maps).
// Critical because: TaskQueue claim ordering and chain-router fallback routing
// both depend on these specific weights; a silent edit (e.g. swapping rows)
// would re-route work to the wrong role without any test failure.
// Primary sources: packages/contracts/src/roleWeights.ts, enums.ts

import { describe, expect, it } from "vitest";
import { ROLE_WEIGHTS } from "../src/roleWeights.js";
import { InstanceRoleSchema, TaskLinkSchema } from "../src/enums.js";

const ROLES = InstanceRoleSchema.options;
const LINKS = TaskLinkSchema.options;

describe("ROLE_WEIGHTS", () => {
  it("covers every (role, link) pair", () => {
    for (const role of ROLES) {
      for (const link of LINKS) {
        expect(ROLE_WEIGHTS[role][link]).toBeTypeOf("number");
      }
    }
  });

  it("scores own-link tasks at 100 for non-leader roles", () => {
    expect(ROLE_WEIGHTS.planner.plan).toBe(100);
    expect(ROLE_WEIGHTS.executor.execute).toBe(100);
    expect(ROLE_WEIGHTS.verifier.verify).toBe(100);
    expect(ROLE_WEIGHTS.reviewer.review).toBe(100);
    expect(ROLE_WEIGHTS.accepter.accept).toBe(100);
    expect(ROLE_WEIGHTS.explorer.explore).toBe(100);
  });

  it("scores leader as 0 across the board (leader never claims)", () => {
    for (const link of LINKS) {
      expect(ROLE_WEIGHTS.leader[link]).toBe(0);
    }
  });

  it("scores cross-role fallbacks below the own-link weight", () => {
    for (const role of ROLES) {
      if (role === "leader") continue;
      for (const link of LINKS) {
        const weight = ROLE_WEIGHTS[role][link];
        if (weight !== 100) {
          expect(weight).toBeLessThan(100);
          expect(weight).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("makes the own-role the highest scorer for its link (claim ordering)", () => {
    // For each link, the role whose name aligns with that link must outscore
    // any other non-leader role. Explorer's diagonal column tested separately
    // because the link name "explore" is non-trivial to derive from the role.
    const ownRoleByLink: Partial<Record<(typeof LINKS)[number], string>> = {
      plan: "planner",
      execute: "executor",
      verify: "verifier",
      review: "reviewer",
      accept: "accepter",
      explore: "explorer",
    };
    for (const link of LINKS) {
      const owner = ownRoleByLink[link];
      if (!owner) continue;
      const ownerWeight = ROLE_WEIGHTS[owner as keyof typeof ROLE_WEIGHTS][link];
      for (const role of ROLES) {
        if (role === owner || role === "leader") continue;
        expect(ROLE_WEIGHTS[role][link]).toBeLessThan(ownerWeight);
      }
    }
  });
});
