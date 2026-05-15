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
  asChainId,
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
    projects_root: "/tmp/projects",
    leader_instance_id: asInstanceId("leader1"),
  };
  it("composes task / message / chain / docs paths under the per-leader root", () => {
    // 4 顶层语义目录：chains/ tasks/ messages/ docs/。所有 per-task 产物
    // 归并到 tasks/<task_id>/，per-message 产物归并到 messages/<message_id>/，
    // 链审计三件套和 link artifacts 都在 chains/<chain_id>/。
    expect(cachePaths.coRootDir(opts)).toBe("/tmp/projects/leader1");

    // tasks/<task_id>/ —— definition + all per-task artifacts in one folder
    expect(cachePaths.taskDefinitionPath(opts, asTaskId("task-1"))).toBe(
      "/tmp/projects/leader1/tasks/task-1/definition.md",
    );
    expect(cachePaths.taskLogPath(opts, asTaskId("task-1"), "ts")).toBe(
      "/tmp/projects/leader1/tasks/task-1/exec-ts.log",
    );
    expect(cachePaths.taskResultPath(opts, asTaskId("task-1"))).toBe(
      "/tmp/projects/leader1/tasks/task-1/result.md",
    );
    expect(cachePaths.evalLogPath(opts, asTaskId("task-1"), 0)).toBe(
      "/tmp/projects/leader1/tasks/task-1/eval-0.log",
    );
    expect(cachePaths.commitLogPath(opts, asTaskId("task-1"))).toBe(
      "/tmp/projects/leader1/tasks/task-1/commit.log",
    );

    // messages/<message_id>/ —— inbound log + (optionally) decompose output
    expect(cachePaths.messageLogPath(opts, asMessageId("m-1"))).toBe(
      "/tmp/projects/leader1/messages/m-1/inbound.log",
    );
    expect(cachePaths.decomposeResultPath(opts, asMessageId("msg-1"))).toBe(
      "/tmp/projects/leader1/messages/msg-1/decompose.md",
    );

    // chains/<chain_id>/ —— audit triple. The chainArtifactPath helper is
    // intentionally removed; downstream link workers resolve upstream task
    // outputs via manifest.link_tasks[link] → tasks/<task_id>/result.md.
    expect(cachePaths.chainRequirementPath(opts, asChainId("chain-x"))).toBe(
      "/tmp/projects/leader1/chains/chain-x/requirement.md",
    );
    expect(cachePaths.chainManifestPath(opts, asChainId("chain-x"))).toBe(
      "/tmp/projects/leader1/chains/chain-x/manifest.json",
    );
    expect(cachePaths.chainAuditPath(opts, asChainId("chain-x"))).toBe(
      "/tmp/projects/leader1/chains/chain-x/audit.jsonl",
    );

    // docs/<worker>/<date>/<prefix>-<uniqueKey>.md — worker local copy
    expect(
      cachePaths.workerLocalDocPath(opts, "alpha", "2026-05-15", "plan", "chain-x"),
    ).toBe("/tmp/projects/leader1/docs/alpha/2026-05-15/plan-chain-x.md");
  });
});
