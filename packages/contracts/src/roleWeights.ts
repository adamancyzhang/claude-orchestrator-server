import type { InstanceRole, TaskLink } from "./enums.js";

export const ROLE_WEIGHTS: Readonly<
  Record<InstanceRole, Readonly<Record<TaskLink, number>>>
> = {
  planner:  { plan: 100, execute: 10,  verify: 10,  review: 20,  accept: 10,  explore: 20  },
  executor: { plan: 10,  execute: 100, verify: 20,  review: 10,  accept: 10,  explore: 10  },
  verifier: { plan: 10,  execute: 20,  verify: 100, review: 20,  accept: 10,  explore: 10  },
  reviewer: { plan: 20,  execute: 10,  verify: 20,  review: 100, accept: 20,  explore: 10  },
  accepter: { plan: 10,  execute: 10,  verify: 10,  review: 20,  accept: 100, explore: 20  },
  explorer: { plan: 20,  execute: 10,  verify: 10,  review: 20,  accept: 10,  explore: 100 },
  leader:   { plan: 0,   execute: 0,   verify: 0,   review: 0,   accept: 0,   explore: 0   },
};
