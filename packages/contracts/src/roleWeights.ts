import type { InstanceRole, TaskLink } from "./enums.js";

export const ROLE_WEIGHTS: Readonly<
  Record<InstanceRole, Readonly<Record<TaskLink, number>>>
> = {
  planner: { plan: 100, build: 10, verify: 10, review: 20, accept: 10 },
  builder: { plan: 10, build: 100, verify: 20, review: 10, accept: 10 },
  verifier: { plan: 10, build: 20, verify: 100, review: 20, accept: 10 },
  reviewer: { plan: 20, build: 10, verify: 20, review: 100, accept: 20 },
  accepter: { plan: 10, build: 10, verify: 10, review: 20, accept: 100 },
  leader: { plan: 0, build: 0, verify: 0, review: 0, accept: 0 },
};
