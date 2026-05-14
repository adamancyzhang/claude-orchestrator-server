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

  it("carries task_doc_path and result_path", () => {
    const t = TaskSchema.parse({
      title: "x",
      created_at: "2026-05-14T00:00:00Z",
      task_doc_path: "/cache/tasks/t-1.md",
      result_path: "/cache/results/t-1.md",
    });
    expect(t.task_doc_path).toBe("/cache/tasks/t-1.md");
    expect(t.result_path).toBe("/cache/results/t-1.md");
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
});

describe("ChainDefSchema", () => {
  it("allows plan to be null", () => {
    const def = {
      chain_id: "c-1",
      chain_title: "demo",
      tasks: {
        plan: null,
        build: { title: "b", description: "", criteria: "", priority: 1 },
        verify: { title: "v", description: "", criteria: "", priority: 1 },
        review: { title: "r", description: "", criteria: "", priority: 1 },
        accept: { title: "a", description: "", criteria: "", priority: 1 },
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
      next_link: "build",
    });
    if (d.decision !== "activate_next") throw new Error("wrong variant");
    expect(d.next_link).toBe("build");
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
