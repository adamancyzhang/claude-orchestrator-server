// CORE-RETENTION
// Locks in: zkPaths.* and cachePaths.* deterministic layout. Path strings are
// the on-disk / on-ZK contract; any silent edit (e.g. swapping "/" segments
// or rename "claimed" → "Claimed") immediately splits the cluster — leader
// reads from one tree, worker writes to another.
// Critical because: recovery / chain-audit / message-router all rely on these
// exact strings. The functions look trivial, which is precisely when regressions
// happen.
// Primary sources: packages/contracts/src/paths/zkPaths.ts, paths/cachePaths.ts

import { describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  asMessageId,
  asProjectId,
  asTaskId,
} from "../src/ids.js";
import * as zkPaths from "../src/paths/zkPaths.js";
import * as cachePaths from "../src/paths/cachePaths.js";

const inst = asInstanceId("inst-1");
const task = asTaskId("t-9");
const msg = asMessageId("m-3");
const chain = asChainId("c-7");
const proj = asProjectId("alpha");

describe("zkPaths defaults (no project_id)", () => {
  it("uses /claude-orchestrator as the default root", () => {
    expect(zkPaths.DEFAULT_ROOT).toBe("/claude-orchestrator");
    expect(zkPaths.projectRoot()).toBe("/claude-orchestrator");
  });

  it("builds canonical top-level paths", () => {
    expect(zkPaths.leader()).toBe("/claude-orchestrator/leader");
    expect(zkPaths.instances()).toBe("/claude-orchestrator/instances");
    expect(zkPaths.tasksRoot()).toBe("/claude-orchestrator/tasks");
    expect(zkPaths.tasksPending()).toBe("/claude-orchestrator/tasks/pending");
    expect(zkPaths.tasksClaimed()).toBe("/claude-orchestrator/tasks/claimed");
    expect(zkPaths.tasksCompleted()).toBe(
      "/claude-orchestrator/tasks/completed",
    );
    expect(zkPaths.messages()).toBe("/claude-orchestrator/messages");
  });

  it("builds parameterized per-entity paths", () => {
    expect(zkPaths.instance(inst)).toBe(
      "/claude-orchestrator/instances/inst-1",
    );
    expect(zkPaths.taskPending(task)).toBe(
      "/claude-orchestrator/tasks/pending/t-9",
    );
    expect(zkPaths.taskClaimed(inst, task)).toBe(
      "/claude-orchestrator/tasks/claimed/inst-1-t-9",
    );
    expect(zkPaths.taskCompleted(task)).toBe(
      "/claude-orchestrator/tasks/completed/t-9",
    );
    expect(zkPaths.messageDir(inst)).toBe(
      "/claude-orchestrator/messages/inst-1",
    );
    expect(zkPaths.message(inst, msg)).toBe(
      "/claude-orchestrator/messages/inst-1/m-3",
    );
  });

  it("enumerates exactly the seven ensure paths (init contract)", () => {
    expect(zkPaths.allEnsurePaths()).toEqual([
      "/claude-orchestrator",
      "/claude-orchestrator/instances",
      "/claude-orchestrator/tasks",
      "/claude-orchestrator/tasks/pending",
      "/claude-orchestrator/tasks/claimed",
      "/claude-orchestrator/tasks/completed",
      "/claude-orchestrator/messages",
    ]);
  });
});

describe("zkPaths with project_id", () => {
  it("scopes the root under /co/<project_id>", () => {
    const o = { project_id: proj };
    expect(zkPaths.projectRoot(o)).toBe("/co/alpha");
    expect(zkPaths.tasksPending(o)).toBe("/co/alpha/tasks/pending");
    expect(zkPaths.instance(inst, o)).toBe("/co/alpha/instances/inst-1");
    expect(zkPaths.message(inst, msg, o)).toBe(
      "/co/alpha/messages/inst-1/m-3",
    );
  });
});

describe("cachePaths layout", () => {
  const opts = {
    projects_root: "/tmp/proj",
    leader_instance_id: asInstanceId("leader-001"),
  };

  it("builds the CO root from projects_root + leader instance id", () => {
    expect(cachePaths.coRootDir(opts)).toBe("/tmp/proj/leader-001");
  });

  it("places chain artifacts under chains/<chain_id>/", () => {
    expect(cachePaths.chainDir(opts, chain)).toBe(
      "/tmp/proj/leader-001/chains/c-7",
    );
    expect(cachePaths.chainRequirementPath(opts, chain)).toBe(
      "/tmp/proj/leader-001/chains/c-7/requirement.md",
    );
    expect(cachePaths.chainManifestPath(opts, chain)).toBe(
      "/tmp/proj/leader-001/chains/c-7/manifest.json",
    );
    expect(cachePaths.chainAuditPath(opts, chain)).toBe(
      "/tmp/proj/leader-001/chains/c-7/audit.jsonl",
    );
  });

  it("places task artifacts under tasks/<task_id>/", () => {
    expect(cachePaths.taskDir(opts, task)).toBe(
      "/tmp/proj/leader-001/tasks/t-9",
    );
    expect(cachePaths.taskDefinitionPath(opts, task)).toBe(
      "/tmp/proj/leader-001/tasks/t-9/definition.md",
    );
    expect(cachePaths.taskLogPath(opts, task, "1234")).toBe(
      "/tmp/proj/leader-001/tasks/t-9/exec-1234.log",
    );
    expect(cachePaths.taskResultPath(opts, task)).toBe(
      "/tmp/proj/leader-001/tasks/t-9/result.md",
    );
    expect(cachePaths.evalLogPath(opts, task, 2)).toBe(
      "/tmp/proj/leader-001/tasks/t-9/eval-2.log",
    );
    expect(cachePaths.commitLogPath(opts, task)).toBe(
      "/tmp/proj/leader-001/tasks/t-9/commit.log",
    );
  });

  it("places message artifacts under messages/<message_id>/", () => {
    expect(cachePaths.messageDir(opts, msg)).toBe(
      "/tmp/proj/leader-001/messages/m-3",
    );
    expect(cachePaths.messageLogPath(opts, msg)).toBe(
      "/tmp/proj/leader-001/messages/m-3/inbound.log",
    );
  });

  it("places decompose result under docs/<leader>/<date>/ (model artifact layer)", () => {
    expect(cachePaths.decomposeResultPath(opts, msg, "2026-06-07")).toBe(
      "/tmp/proj/leader-001/docs/leader-001/2026-06-07/decompose-m-3.md",
    );
  });

  it("worker local doc embeds worker / date / prefix / uniqueKey verbatim", () => {
    expect(
      cachePaths.workerLocalDocPath(opts, "Tom", "2025-01-02", "fact", "abc"),
    ).toBe("/tmp/proj/leader-001/docs/Tom/2025-01-02/fact-abc.md");
  });

  it("workspace memory file path swaps file extension to .md and strips leading slashes", () => {
    expect(
      cachePaths.workspaceMemoryFilePath(opts, "packages/worker/src/watcher.ts"),
    ).toBe("/tmp/proj/leader-001/memory/packages/worker/src/watcher.md");

    expect(
      cachePaths.workspaceMemoryFilePath(opts, "/leading/slash/file.ts"),
    ).toBe("/tmp/proj/leader-001/memory/leading/slash/file.md");
  });

  it("workspace memory dir index collapses '' and '.' to root CLAUDE.md", () => {
    expect(cachePaths.workspaceMemoryDirIndexPath(opts, "")).toBe(
      "/tmp/proj/leader-001/memory/CLAUDE.md",
    );
    expect(cachePaths.workspaceMemoryDirIndexPath(opts, ".")).toBe(
      "/tmp/proj/leader-001/memory/CLAUDE.md",
    );
    expect(
      cachePaths.workspaceMemoryDirIndexPath(opts, "packages/worker/src"),
    ).toBe("/tmp/proj/leader-001/memory/packages/worker/src/CLAUDE.md");
    expect(cachePaths.workspaceMemoryDirIndexPath(opts, "/a/b/")).toBe(
      "/tmp/proj/leader-001/memory/a/b/CLAUDE.md",
    );
  });
});
