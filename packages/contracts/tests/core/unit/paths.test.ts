// CORE-RETENTION
// Locks in: zkPaths / cachePaths string composition — including the opt-in
//   `project_id` namespace branch that switches the root from
//   /claude-orchestrator to /co/{project_id}.
// Core path because: every subsystem constructs ZK and cache paths via
//   these pure helpers; a misformed path silently misroutes work.
// Owner subsystem: contracts.
// Primary source files exercised:
//   - packages/contracts/src/paths/zkPaths.ts
//   - packages/contracts/src/paths/cachePaths.ts

import { describe, expect, it } from "vitest";
import {
  asInstanceId,
  asMessageId,
  asProjectId,
  asTaskId,
  cachePaths,
  zkPaths,
} from "../../../src/index.js";

describe("zkPaths default namespace", () => {
  it("uses /claude-orchestrator without project_id", () => {
    expect(zkPaths.leader()).toBe("/claude-orchestrator/leader");
    expect(zkPaths.instances()).toBe("/claude-orchestrator/instances");
    expect(zkPaths.tasksPending()).toBe("/claude-orchestrator/tasks/pending");
    expect(zkPaths.messages()).toBe("/claude-orchestrator/messages");
  });

  it("switches to /co/{project_id} when project_id is provided", () => {
    const opts = { project_id: asProjectId("myapp") };
    expect(zkPaths.leader(opts)).toBe("/co/myapp/leader");
    expect(zkPaths.instances(opts)).toBe("/co/myapp/instances");
  });
});

describe("zkPaths instance / task / message", () => {
  it("composes nested paths with branded IDs", () => {
    const inst = asInstanceId("abc123");
    const task = asTaskId("task-00001");
    const msg = asMessageId("msg-0001");
    expect(zkPaths.instance(inst)).toBe("/claude-orchestrator/instances/abc123");
    expect(zkPaths.taskPending(task)).toBe(
      "/claude-orchestrator/tasks/pending/task-00001",
    );
    expect(zkPaths.taskClaimed(inst, task)).toBe(
      "/claude-orchestrator/tasks/claimed/abc123-task-00001",
    );
    expect(zkPaths.message(inst, msg)).toBe(
      "/claude-orchestrator/messages/abc123/msg-0001",
    );
  });
});

describe("cachePaths", () => {
  const opts = {
    cache_dir: "/tmp/cache",
    leader_instance_id: asInstanceId("leader1"),
  };
  it("composes task / log / result / eval / commit / message paths", () => {
    expect(cachePaths.taskDocPath(opts, 1)).toBe(
      "/tmp/cache/leader1/tasks/task-1.md",
    );
    // Cache path helpers do NOT add an extra "task-" prefix — task ids from
    // task_queue.push already have it (e.g. "task-0000000001"). This avoids
    // the historical "task-task-..." double-prefix bug.
    expect(cachePaths.taskLogPath(opts, asTaskId("task-1"), "ts")).toBe(
      "/tmp/cache/leader1/logs/task-1-ts.log",
    );
    expect(cachePaths.taskResultPath(opts, asTaskId("task-1"))).toBe(
      "/tmp/cache/leader1/results/task-1.md",
    );
    expect(cachePaths.evalLogPath(opts, asTaskId("task-1"), 0)).toBe(
      "/tmp/cache/leader1/evals/task-1-attempt-0.log",
    );
    expect(cachePaths.commitLogPath(opts, asTaskId("task-1"))).toBe(
      "/tmp/cache/leader1/commits/task-1.log",
    );
    expect(cachePaths.messageLogPath(opts, asMessageId("m-1"))).toBe(
      "/tmp/cache/leader1/messages/m-1.log",
    );
  });
});
