import { describe, it, expect } from "vitest";
import {
  createInstance, createTask, createMessage,
  InstanceSchema, TaskSchema, MessageSchema,
  ChainDefSchema, EvalDecisionSchema,
} from "../../../src/models/schemas.js";

describe("createInstance", () => {
  it("returns a valid Instance with sensible defaults", () => {
    const i = createInstance({ name: "Alice" });
    expect(i.name).toBe("Alice");
    expect(i.role).toBe("builder");
    expect(i.status).toBe("idle");
    expect(i.id).toBeTruthy();
    expect(() => InstanceSchema.parse(i)).not.toThrow();
  });

  it("honors id and workDir overrides", () => {
    const i = createInstance({ id: "explicit", name: "X", workDir: "/work" });
    expect(i.id).toBe("explicit");
    expect(i.work_dir).toBe("/work");
  });
});

describe("createTask", () => {
  it("defaults priority=1, status='pending', retry_count=0", () => {
    const t = createTask({ title: "T" });
    expect(t.priority).toBe(1);
    expect(t.status).toBe("pending");
    expect(t.retry_count).toBe(0);
  });

  it("rejects invalid link via Zod", () => {
    expect(() =>
      TaskSchema.parse({
        title: "T", created_at: "now", link: "not-a-valid-link",
      } as never),
    ).toThrow();
  });
});

describe("createMessage", () => {
  it("defaults read=false and type=direct", () => {
    const m = createMessage({
      from_instance: "a", from_name: "A", to_instance: "b", content: "hi",
    });
    expect(m.read).toBe(false);
    expect(m.type).toBe("direct");
  });

  it("MessageSchema requires content", () => {
    expect(() => MessageSchema.parse({} as never)).toThrow();
  });
});

describe("ChainDefSchema", () => {
  it("accepts a valid chain definition (plan may be null)", () => {
    const c = ChainDefSchema.parse({
      chain_id: "c", chain_title: "t",
      tasks: {
        plan: null,
        build: { title: "b", description: "d", criteria: "c", priority: 1 },
        verify: { title: "v", description: "d", criteria: "c", priority: 1 },
        review: { title: "r", description: "d", criteria: "c", priority: 1 },
        accept: { title: "a", description: "d", criteria: "c", priority: 1 },
      },
    });
    expect(c.chain_id).toBe("c");
    expect(c.tasks.plan).toBeNull();
  });
});

describe("EvalDecisionSchema", () => {
  it("activate_next minimal valid", () => {
    const d = EvalDecisionSchema.parse({ decision: "activate_next", reason: "ok" });
    expect(d.decision).toBe("activate_next");
  });

  it("rejects unknown decision values", () => {
    expect(() => EvalDecisionSchema.parse({ decision: "explode", reason: "no" })).toThrow();
  });
});
