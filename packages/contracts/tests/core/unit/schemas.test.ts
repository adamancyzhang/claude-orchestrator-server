// CORE-RETENTION
// Locks in: Zod schema invariants for Instance / Task / Message / ChainDef /
//   the 4-variant EvalDecision discriminated union / MergeDecision. These
//   schemas are the wire-format contract between Leader and Workers.
// Core path because: a schema break silently corrupts ZK payloads — every
//   subsystem deserializes via these schemas; field/default drift is the
//   most common source of cross-process bugs.
// Owner subsystem: contracts.
// Primary source files exercised:
//   - packages/contracts/src/schemas/instance.ts
//   - packages/contracts/src/schemas/task.ts
//   - packages/contracts/src/schemas/message.ts
//   - packages/contracts/src/schemas/chain.ts
//   - packages/contracts/src/schemas/eval.ts
//   - packages/contracts/src/schemas/merge.ts

import { describe, expect, it } from "vitest";
import {
  ChainDefSchema,
  EvalDecisionSchema,
  InstanceSchema,
  MergeDecisionSchema,
  MessageSchema,
  PROTOCOL_VERSION,
  TaskSchema,
} from "../../../src/index.js";

describe("InstanceSchema", () => {
  it("requires protocol_version", () => {
    const parsed = InstanceSchema.safeParse({
      id: "abc",
      name: "Tom",
      connected_since: "2026-05-14T00:00:00Z",
      protocol_version: PROTOCOL_VERSION,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects missing protocol_version", () => {
    const parsed = InstanceSchema.safeParse({
      id: "abc",
      name: "Tom",
      connected_since: "2026-05-14T00:00:00Z",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("TaskSchema", () => {
  it("defaults retry_count to 0 and link to null", () => {
    const t = TaskSchema.parse({
      title: "do thing",
      created_at: "2026-05-14T00:00:00Z",
    });
    expect(t.retry_count).toBe(0);
    expect(t.link).toBeNull();
    expect(t.priority).toBe(1);
  });

  it("carries result_path", () => {
    const t = TaskSchema.parse({
      title: "x",
      created_at: "2026-05-14T00:00:00Z",
      result_path: "/cache/results/t-1.md",
    });
    expect(t.result_path).toBe("/cache/results/t-1.md");
  });

  it("strips legacy task_doc_path / depends_on / blocked_by silently", () => {
    const t = TaskSchema.parse({
      title: "legacy",
      created_at: "2026-05-14T00:00:00Z",
      task_doc_path: "/legacy/path.md",
      depends_on: ["task-x"],
      blocked_by: ["task-y"],
      blocked_reason: "legacy reason",
    });
    expect("task_doc_path" in t).toBe(false);
    expect("depends_on" in t).toBe(false);
    expect("blocked_by" in t).toBe(false);
    expect("blocked_reason" in t).toBe(false);
  });
});

describe("MessageSchema", () => {
  it("accepts all v0.5 message types", () => {
    for (const type of [
      "direct",
      "broadcast",
      "task_dispatch",
      "completion_report",
      "user_input",
      "help",
    ] as const) {
      const m = MessageSchema.safeParse({
        type,
        from_instance: "leader",
        from_name: "Leader",
        content: "hi",
        created_at: "2026-05-14T00:00:00Z",
      });
      expect(m.success).toBe(true);
    }
  });

  // v0.7 NEW — FR-33 spawn_chain wires the parent chain id and the
  // explorer-authored next_requirement onto the synthetic user_input
  // message that bootstraps the child chain.
  it("carries optional spawned_from + next_requirement", () => {
    const parsed = MessageSchema.parse({
      type: "user_input",
      from_instance: "leader",
      from_name: "Leader",
      content: "explorer's next requirement text",
      created_at: "2026-05-14T00:00:00Z",
      spawned_from: "chain-parent-123",
      next_requirement: "explorer's next requirement text",
    });
    expect(parsed.spawned_from).toBe("chain-parent-123");
    expect(parsed.next_requirement).toBe("explorer's next requirement text");
  });
});

describe("ChainDefSchema", () => {
  it("allows plan to be null", () => {
    const def = {
      chain_id: "c-1",
      chain_title: "demo",
      tasks: {
        plan: null,
        execute: { title: "e", description: "", criteria: "", priority: 1 },
        verify: { title: "v", description: "", criteria: "", priority: 1 },
        review: { title: "r", description: "", criteria: "", priority: 1 },
        accept: { title: "a", description: "", criteria: "", priority: 1 },
      },
    };
    expect(ChainDefSchema.safeParse(def).success).toBe(true);
  });

  it("accepts optional explore task (v0.7 magic mode)", () => {
    const def = {
      chain_id: "c-2",
      chain_title: "magic",
      tasks: {
        plan: { title: "p", description: "", criteria: "", priority: 1 },
        execute: { title: "e", description: "", criteria: "", priority: 1 },
        verify: { title: "v", description: "", criteria: "", priority: 1 },
        review: { title: "r", description: "", criteria: "", priority: 1 },
        accept: { title: "a", description: "", criteria: "", priority: 1 },
        explore: { title: "x", description: "", criteria: "", priority: 1 },
      },
    };
    expect(ChainDefSchema.safeParse(def).success).toBe(true);
  });
});

describe("EvalDecisionSchema", () => {
  it("parses activate_next with next_link", () => {
    const d = EvalDecisionSchema.parse({
      decision: "activate_next",
      reason: "ok",
      next_link: "execute",
    });
    if (d.decision !== "activate_next") throw new Error("wrong variant");
    expect(d.next_link).toBe("execute");
  });

  it("parses feedback with feedback_to_worker", () => {
    const d = EvalDecisionSchema.parse({
      decision: "feedback",
      reason: "missing tests",
      feedback_to_worker: "please add tests",
    });
    if (d.decision !== "feedback") throw new Error("wrong variant");
    expect(d.feedback_to_worker).toBe("please add tests");
  });

  it("parses reject as a terminal decision", () => {
    const d = EvalDecisionSchema.parse({ decision: "reject", reason: "bad" });
    expect(d.decision).toBe("reject");
  });

  it("parses close_chain as a terminal decision", () => {
    const d = EvalDecisionSchema.parse({
      decision: "close_chain",
      reason: "done",
    });
    expect(d.decision).toBe("close_chain");
  });

  // v0.7 NEW — FR-33 schema lock for spawn_chain.
  it("parses spawn_chain with next_requirement", () => {
    const d = EvalDecisionSchema.parse({
      decision: "spawn_chain",
      reason: "ready for a follow-up iteration",
      next_requirement: "Add caching to the export endpoint",
    });
    if (d.decision !== "spawn_chain") throw new Error("wrong variant");
    expect(d.next_requirement).toBe("Add caching to the export endpoint");
  });

  it("rejects spawn_chain without next_requirement", () => {
    const r = EvalDecisionSchema.safeParse({
      decision: "spawn_chain",
      reason: "ready",
    });
    expect(r.success).toBe(false);
  });

  it("rejects spawn_chain with empty next_requirement", () => {
    const r = EvalDecisionSchema.safeParse({
      decision: "spawn_chain",
      reason: "ready",
      next_requirement: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown decision values", () => {
    const r = EvalDecisionSchema.safeParse({ decision: "halt", reason: "" });
    expect(r.success).toBe(false);
  });
});

describe("MergeDecisionSchema", () => {
  it("accepts merge / skip / review_first with reason", () => {
    for (const decision of ["merge", "skip", "review_first"] as const) {
      const r = MergeDecisionSchema.safeParse({
        decision,
        reason: "ok",
      });
      expect(r.success).toBe(true);
    }
  });

  it("defaults conflict_files and reviewed_branches to []", () => {
    const r = MergeDecisionSchema.parse({ decision: "merge", reason: "ok" });
    expect(r.conflict_files).toEqual([]);
    expect(r.reviewed_branches).toEqual([]);
  });
});
