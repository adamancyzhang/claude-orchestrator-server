import { describe, it, expect } from "vitest";
import {
  ROOT,
  LEADER,
  INSTANCES,
  TASKS,
  TASKS_PENDING,
  TASKS_CLAIMED,
  TASKS_COMPLETED,
  MESSAGES,
  instancePath,
  pendingTaskPath,
  claimedTaskPath,
  completedTaskPath,
  messageDirPath,
  messagePath,
  leaderPath,
  ALL_ENSURE_PATHS,
} from "../../src/zk/paths.js";

describe("ZK Paths", () => {
  describe("ROOT", () => {
    it("defaults to /claude-orchestrator", () => {
      expect(ROOT).toBe("/claude-orchestrator");
    });
  });

  describe("path constants", () => {
    it("LEADER is under ROOT", () => {
      expect(LEADER).toBe("/claude-orchestrator/leader");
    });

    it("INSTANCES is under ROOT", () => {
      expect(INSTANCES).toBe("/claude-orchestrator/instances");
    });

    it("TASKS is under ROOT", () => {
      expect(TASKS).toBe("/claude-orchestrator/tasks");
    });

    it("TASKS_PENDING is under TASKS", () => {
      expect(TASKS_PENDING).toBe("/claude-orchestrator/tasks/pending");
    });

    it("TASKS_CLAIMED is under TASKS", () => {
      expect(TASKS_CLAIMED).toBe("/claude-orchestrator/tasks/claimed");
    });

    it("TASKS_COMPLETED is under TASKS", () => {
      expect(TASKS_COMPLETED).toBe("/claude-orchestrator/tasks/completed");
    });

    it("MESSAGES is under ROOT", () => {
      expect(MESSAGES).toBe("/claude-orchestrator/messages");
    });
  });

  describe("instancePath", () => {
    it("returns path under INSTANCES", () => {
      expect(instancePath("abc123")).toBe("/claude-orchestrator/instances/abc123");
    });
  });

  describe("pendingTaskPath", () => {
    it("returns path under TASKS_PENDING", () => {
      expect(pendingTaskPath("task-00001")).toBe(
        "/claude-orchestrator/tasks/pending/task-00001"
      );
    });
  });

  describe("claimedTaskPath", () => {
    it("returns {instanceId}-{taskId} under TASKS_CLAIMED", () => {
      expect(claimedTaskPath("inst1", "task-00001")).toBe(
        "/claude-orchestrator/tasks/claimed/inst1-task-00001"
      );
    });
  });

  describe("completedTaskPath", () => {
    it("returns path under TASKS_COMPLETED", () => {
      expect(completedTaskPath("task-00001")).toBe(
        "/claude-orchestrator/tasks/completed/task-00001"
      );
    });
  });

  describe("messageDirPath", () => {
    it("returns path under MESSAGES", () => {
      expect(messageDirPath("inst1")).toBe(
        "/claude-orchestrator/messages/inst1"
      );
    });
  });

  describe("messagePath", () => {
    it("returns instanceId/msgId under MESSAGES", () => {
      expect(messagePath("inst1", "msg-00001")).toBe(
        "/claude-orchestrator/messages/inst1/msg-00001"
      );
    });
  });

  describe("leaderPath", () => {
    it("returns LEADER constant", () => {
      expect(leaderPath()).toBe("/claude-orchestrator/leader");
    });
  });

  describe("ALL_ENSURE_PATHS", () => {
    it("contains all required base paths", () => {
      expect(ALL_ENSURE_PATHS).toEqual([
        "/claude-orchestrator",
        "/claude-orchestrator/instances",
        "/claude-orchestrator/tasks",
        "/claude-orchestrator/tasks/pending",
        "/claude-orchestrator/tasks/claimed",
        "/claude-orchestrator/tasks/completed",
        "/claude-orchestrator/messages",
      ]);
    });

    it("has 7 entries", () => {
      expect(ALL_ENSURE_PATHS).toHaveLength(7);
    });
  });
});
