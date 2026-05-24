// CORE-RETENTION
// Locks in: enum membership (status, role, link, priority, message type,
// decision kind). These are part of the on-the-wire contract — every persisted
// task / instance / message JSON includes one of these strings and any silent
// addition or removal corrupts every consumer.
// Critical because: leader and worker share these enums via parsed JSON from
// ZK; if an enum drifts, parse-time validation silently widens the allowed set
// or rejects valid state across protocol versions.
// Primary sources: packages/contracts/src/enums.ts

import { describe, expect, it } from "vitest";
import {
  EvalDecisionKindSchema,
  InstanceRoleSchema,
  InstanceStatusSchema,
  MergeDecisionKindSchema,
  MessageTypeSchema,
  TaskLinkSchema,
  TaskPrioritySchema,
  TaskStatusSchema,
} from "../src/enums.js";

describe("enum membership", () => {
  it("InstanceStatus is exactly idle | busy", () => {
    expect(InstanceStatusSchema.options).toEqual(["idle", "busy"]);
  });

  it("InstanceRole covers the canonical seven roles", () => {
    expect(InstanceRoleSchema.options).toEqual([
      "planner",
      "executor",
      "verifier",
      "reviewer",
      "accepter",
      "explorer",
      "leader",
    ]);
  });

  it("TaskLink covers the canonical six links", () => {
    expect(TaskLinkSchema.options).toEqual([
      "plan",
      "execute",
      "verify",
      "review",
      "accept",
      "explore",
    ]);
  });

  it("TaskStatus is exactly pending | claimed | completed | failed", () => {
    expect(TaskStatusSchema.options).toEqual([
      "pending",
      "claimed",
      "completed",
      "failed",
    ]);
  });

  it("MessageType matches the wire enum", () => {
    expect(MessageTypeSchema.options).toEqual([
      "direct",
      "broadcast",
      "task_dispatch",
      "completion_report",
      "user_input",
      "help",
      "memory_refresh",
    ]);
  });

  it("EvalDecisionKind matches the five chain decisions", () => {
    expect(EvalDecisionKindSchema.options).toEqual([
      "activate_next",
      "feedback",
      "reject",
      "close_chain",
      "spawn_chain",
    ]);
  });

  it("MergeDecisionKind matches the three merge decisions", () => {
    expect(MergeDecisionKindSchema.options).toEqual([
      "merge",
      "skip",
      "review_first",
    ]);
  });
});

describe("TaskPriority", () => {
  it("accepts integers 0..2", () => {
    expect(TaskPrioritySchema.parse(0)).toBe(0);
    expect(TaskPrioritySchema.parse(1)).toBe(1);
    expect(TaskPrioritySchema.parse(2)).toBe(2);
  });

  it("rejects non-integers and out-of-range values", () => {
    expect(() => TaskPrioritySchema.parse(-1)).toThrow();
    expect(() => TaskPrioritySchema.parse(3)).toThrow();
    expect(() => TaskPrioritySchema.parse(1.5)).toThrow();
    expect(() => TaskPrioritySchema.parse("1")).toThrow();
  });
});
