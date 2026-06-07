// CORE-RETENTION
// Locks in: TaskSchema / InstanceSchema / MessageSchema / ChainDefSchema /
// EvalDecisionSchema / MergeDecisionSchema parse-and-default behavior. These
// schemas are the boundary between in-memory state and persisted JSON; the
// `safeParse` failure paths protect downstream code from malformed payloads.
// Critical because: every worker → leader / leader → worker hop revalidates
// against these schemas. A schema that quietly drops a required field would
// emit a "successful" parse with undefined-shaped objects, corrupting
// state-machine transitions in chain-router.
// Primary sources: packages/contracts/src/schemas/{task,instance,message,chain,eval,merge}.ts

import { describe, expect, it } from "vitest";
import { TaskSchema } from "../src/schemas/task.js";
import { InstanceSchema } from "../src/schemas/instance.js";
import { MessageSchema } from "../src/schemas/message.js";
import { ChainDefSchema, LegacyChainDefSchema, NewChainDefSchema, ChainTaskSchema } from "../src/schemas/chain.js";
import { EvalDecisionSchema } from "../src/schemas/eval.js";
import { MergeDecisionSchema } from "../src/schemas/merge.js";

// ── TaskSchema ─────────────────────────────────────────────────────────

describe("TaskSchema", () => {
  it("requires title and created_at; everything else has defaults", () => {
    const parsed = TaskSchema.parse({
      title: "do the thing",
      created_at: "2025-01-02T00:00:00Z",
    });
    expect(parsed.title).toBe("do the thing");
    expect(parsed.created_at).toBe("2025-01-02T00:00:00Z");
    expect(parsed.status).toBe("pending");
    expect(parsed.priority).toBe(1);
    expect(parsed.retry_count).toBe(0);
    expect(parsed.description).toBe("");
    expect(parsed.criteria).toBe("");
    expect(parsed.link).toBeNull();
    expect(parsed.chain_id).toBeNull();
    expect(parsed.result_path).toBeNull();
    expect(parsed.assigned_to).toBeNull();
    expect(parsed.claimed_by).toBeNull();
    expect(parsed.leader_only).toBe(false);
  });

  it("rejects missing title (a Task with no title cannot route)", () => {
    const r = TaskSchema.safeParse({ created_at: "2025-01-02T00:00:00Z" });
    expect(r.success).toBe(false);
  });

  it("rejects priority outside 0..2", () => {
    const r = TaskSchema.safeParse({
      title: "x",
      created_at: "now",
      priority: 5,
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown status / link enum values", () => {
    expect(
      TaskSchema.safeParse({
        title: "x",
        created_at: "now",
        status: "exploding",
      }).success,
    ).toBe(false);
    expect(
      TaskSchema.safeParse({
        title: "x",
        created_at: "now",
        link: "destruct",
      }).success,
    ).toBe(false);
  });

  it("brands id-shaped fields through `transform`", () => {
    const parsed = TaskSchema.parse({
      id: "t-1",
      title: "x",
      created_at: "now",
      assigned_to: "inst-2",
      created_by: "inst-3",
      chain_id: "c-1",
    });
    // Branding is erased at runtime — just confirm the string passes through.
    expect(parsed.id).toBe("t-1");
    expect(parsed.assigned_to).toBe("inst-2");
    expect(parsed.created_by).toBe("inst-3");
    expect(parsed.chain_id).toBe("c-1");
  });

  it("accepts upstream_commits subfields as optional", () => {
    const parsed = TaskSchema.parse({
      title: "x",
      created_at: "now",
      upstream_commits: { plan: "abc", execute: null },
    });
    expect(parsed.upstream_commits).toEqual({ plan: "abc", execute: null });
  });
});

// ── InstanceSchema ─────────────────────────────────────────────────────

describe("InstanceSchema", () => {
  it("requires id / name / connected_since / protocol_version", () => {
    const parsed = InstanceSchema.parse({
      id: "inst-1",
      name: "Tom",
      connected_since: "2025-01-02T00:00:00Z",
      protocol_version: "0.7.0",
    });
    expect(parsed.id).toBe("inst-1");
    expect(parsed.name).toBe("Tom");
    expect(parsed.role).toBe("executor");
    expect(parsed.status).toBe("idle");
    expect(parsed.current_task_id).toBeNull();
    expect(parsed.work_dir).toBeNull();
    expect(parsed.pid).toBeNull();
    expect(parsed.protocol_version).toBe("0.7.0");
  });

  it("rejects unknown roles", () => {
    expect(
      InstanceSchema.safeParse({
        id: "i",
        name: "n",
        role: "wizard",
        connected_since: "now",
        protocol_version: "0.7.0",
      }).success,
    ).toBe(false);
  });

  it("rejects non-integer pid", () => {
    expect(
      InstanceSchema.safeParse({
        id: "i",
        name: "n",
        connected_since: "now",
        protocol_version: "0.7.0",
        pid: 3.14,
      }).success,
    ).toBe(false);
  });
});

// ── MessageSchema ──────────────────────────────────────────────────────

describe("MessageSchema", () => {
  it("parses a minimal direct message and applies defaults", () => {
    const parsed = MessageSchema.parse({
      from_instance: "inst-a",
      from_name: "Alice",
      content: "hi",
      created_at: "now",
    });
    expect(parsed.type).toBe("direct");
    expect(parsed.to_instance).toBeNull();
    expect(parsed.read).toBe(false);
    expect(parsed.link).toBeNull();
    expect(parsed.task_id).toBeNull();
    expect(parsed.chain_id).toBeNull();
  });

  it("rejects an unknown message type", () => {
    const r = MessageSchema.safeParse({
      type: "fax",
      from_instance: "a",
      from_name: "n",
      content: "x",
      created_at: "now",
    });
    expect(r.success).toBe(false);
  });

  it("requires content + created_at + from_instance + from_name", () => {
    const r = MessageSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

// ── ChainDefSchema ─────────────────────────────────────────────────────

describe("ChainDefSchema", () => {
  const taskDef = {
    title: "t",
    description: "d",
    criteria: "c",
    priority: 1,
  };

  it("requires chain_id + chain_title + the five core tasks", () => {
    const parsed = ChainDefSchema.parse({
      chain_id: "c-1",
      chain_title: "title",
      tasks: {
        plan: taskDef,
        execute: taskDef,
        verify: taskDef,
        review: taskDef,
        accept: taskDef,
      },
    });
    expect(parsed.chain_id).toBe("c-1");
    expect(parsed.tasks.explore).toBeUndefined();
  });

  it("allows `plan` to be null (caller-skipped plan link)", () => {
    const parsed = ChainDefSchema.parse({
      chain_id: "c-1",
      chain_title: "title",
      tasks: {
        plan: null,
        execute: taskDef,
        verify: taskDef,
        review: taskDef,
        accept: taskDef,
      },
    });
    expect(parsed.tasks.plan).toBeNull();
  });

  it("accepts optional explore task (magic mode)", () => {
    const parsed = ChainDefSchema.parse({
      chain_id: "c-1",
      chain_title: "title",
      tasks: {
        plan: taskDef,
        execute: taskDef,
        verify: taskDef,
        review: taskDef,
        accept: taskDef,
        explore: taskDef,
      },
    });
    expect(parsed.tasks.explore).toEqual(taskDef);
  });

  it("rejects a ChainDef missing any of the five core tasks", () => {
    expect(
      ChainDefSchema.safeParse({
        chain_id: "c-1",
        chain_title: "title",
        tasks: {
          plan: taskDef,
          execute: taskDef,
          verify: taskDef,
          review: taskDef,
          // accept missing
        },
      }).success,
    ).toBe(false);
  });

  // ── New format (task_list with system_prompt) ──────────────────────

  it("accepts new format with task_list", () => {
    const parsed = ChainDefSchema.parse({
      chain_id: "c-2",
      chain_title: "dynamic chain",
      task_list: [
        {
          task_id: "t-1",
          title: "Set up project",
          description: "Initialize the project",
          system_prompt: "You are setting up a new project.",
        },
      ],
    });
    expect(parsed.chain_id).toBe("c-2");
    if ("task_list" in parsed) {
      expect(parsed.task_list).toHaveLength(1);
      expect(parsed.task_list[0].task_id).toBe("t-1");
      expect(parsed.task_list[0].system_prompt).toBe("You are setting up a new project.");
    }
  });

  it("accepts new format with depends_on and defaults", () => {
    const parsed = ChainDefSchema.parse({
      chain_id: "c-3",
      chain_title: "chained tasks",
      task_list: [
        {
          task_id: "t-1",
          title: "First",
          description: "Step one",
          system_prompt: "Do step one.",
        },
        {
          task_id: "t-2",
          title: "Second",
          description: "Step two",
          system_prompt: "Do step two.",
          depends_on: ["t-1"],
          priority: 2,
          criteria: "Code compiles",
        },
      ],
    });
    if ("task_list" in parsed) {
      expect(parsed.task_list).toHaveLength(2);
      expect(parsed.task_list[1].depends_on).toEqual(["t-1"]);
      expect(parsed.task_list[1].priority).toBe(2);
      expect(parsed.task_list[1].criteria).toBe("Code compiles");
      // defaults applied
      expect(parsed.task_list[0].depends_on).toEqual([]);
      expect(parsed.task_list[0].priority).toBe(1);
    }
  });

  it("rejects new format with empty task_list", () => {
    expect(
      NewChainDefSchema.safeParse({
        chain_id: "c-4",
        chain_title: "empty",
        task_list: [],
      }).success,
    ).toBe(false);
  });

  it("rejects new format missing system_prompt", () => {
    expect(
      NewChainDefSchema.safeParse({
        chain_id: "c-5",
        chain_title: "no prompt",
        task_list: [
          {
            task_id: "t-1",
            title: "Task",
            description: "Desc",
            // system_prompt missing
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects new format missing task_id", () => {
    expect(
      NewChainDefSchema.safeParse({
        chain_id: "c-6",
        chain_title: "no id",
        task_list: [
          {
            title: "Task",
            description: "Desc",
            system_prompt: "prompt",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("distinguishes legacy and new formats", () => {
    // Legacy: has `tasks` key with object value
    const legacy = LegacyChainDefSchema.safeParse({
      chain_id: "c-1",
      chain_title: "old",
      tasks: {
        plan: taskDef,
        execute: taskDef,
        verify: taskDef,
        review: taskDef,
        accept: taskDef,
      },
    });
    expect(legacy.success).toBe(true);

    // New: has `task_list` key with array value
    const fresh = NewChainDefSchema.safeParse({
      chain_id: "c-2",
      chain_title: "new",
      task_list: [
        { task_id: "t-1", title: "T", description: "D", system_prompt: "P" },
      ],
    });
    expect(fresh.success).toBe(true);

    // Cross-rejection: legacy data rejected by new schema
    expect(NewChainDefSchema.safeParse({ chain_id: "c", chain_title: "x", tasks: {} }).success).toBe(false);
    // Cross-rejection: new data rejected by legacy schema
    expect(LegacyChainDefSchema.safeParse({ chain_id: "c", chain_title: "x", task_list: [] }).success).toBe(false);
  });
});

// ── EvalDecisionSchema (discriminated union) ──────────────────────────

describe("EvalDecisionSchema", () => {
  it("parses activate_next with required next_link", () => {
    const parsed = EvalDecisionSchema.parse({
      decision: "activate_next",
      reason: "ok",
      next_link: "execute",
    });
    expect(parsed.decision).toBe("activate_next");
    if (parsed.decision === "activate_next") {
      expect(parsed.next_link).toBe("execute");
    }
  });

  it("rejects activate_next missing next_link", () => {
    expect(
      EvalDecisionSchema.safeParse({
        decision: "activate_next",
        reason: "ok",
      }).success,
    ).toBe(false);
  });

  it("parses feedback with required feedback_to_worker", () => {
    const parsed = EvalDecisionSchema.parse({
      decision: "feedback",
      reason: "needs fix",
      feedback_to_worker: "Alice",
    });
    expect(parsed.decision).toBe("feedback");
  });

  it("parses spawn_chain with non-empty next_requirement", () => {
    const parsed = EvalDecisionSchema.parse({
      decision: "spawn_chain",
      reason: "explore deeper",
      next_requirement: "investigate X",
    });
    expect(parsed.decision).toBe("spawn_chain");
  });

  it("rejects spawn_chain with empty next_requirement", () => {
    expect(
      EvalDecisionSchema.safeParse({
        decision: "spawn_chain",
        reason: "x",
        next_requirement: "",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown decision kind", () => {
    expect(
      EvalDecisionSchema.safeParse({
        decision: "destroy_everything",
        reason: "x",
      }).success,
    ).toBe(false);
  });

  it("parses reject / close_chain with reason only", () => {
    expect(
      EvalDecisionSchema.parse({ decision: "reject", reason: "bad" }).decision,
    ).toBe("reject");
    expect(
      EvalDecisionSchema.parse({ decision: "close_chain", reason: "done" })
        .decision,
    ).toBe("close_chain");
  });
});

// ── MergeDecisionSchema ────────────────────────────────────────────────

describe("MergeDecisionSchema", () => {
  it("applies default empty arrays for conflict / reviewed branches", () => {
    const parsed = MergeDecisionSchema.parse({
      decision: "merge",
      reason: "clean",
    });
    expect(parsed.conflict_files).toEqual([]);
    expect(parsed.reviewed_branches).toEqual([]);
  });

  it("rejects an unknown decision kind", () => {
    expect(
      MergeDecisionSchema.safeParse({
        decision: "abort",
        reason: "no",
      }).success,
    ).toBe(false);
  });
});
