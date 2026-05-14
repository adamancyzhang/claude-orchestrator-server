import { describe, it, expect } from "vitest";
import { MessageRouter } from "../../../src/modules/message-router.js";
import { MockZkClient } from "../../fixtures/mock-zk.js";
import { makeInstance } from "../../fixtures/factories.js";
import type { ZkClient } from "../../../src/zk/client.js";

describe("MessageRouter.send", () => {
  it("resolves toName to instance id and sends", async () => {
    const zk = new MockZkClient();
    const alice = makeInstance({ name: "Alice" });
    zk.instances.set(alice.id, alice);

    const router = new MessageRouter(zk as unknown as ZkClient);
    const msgs = await router.send("leader-1", "Leader", "hi", undefined, false, "Alice");

    expect(msgs).toHaveLength(1);
    expect(msgs[0].to_instance).toBe(alice.id);
    expect(msgs[0].type).toBe("direct");
  });

  it("@all broadcasts to all non-leader instances except self", async () => {
    const zk = new MockZkClient();
    const a = makeInstance({ name: "A" });
    const b = makeInstance({ name: "B" });
    const c = makeInstance({ name: "C" });
    for (const i of [a, b, c]) zk.instances.set(i.id, i);

    const router = new MessageRouter(zk as unknown as ZkClient);
    const msgs = await router.send(a.id, "A-name", "yo", undefined, false, "@all");

    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe("broadcast");
    // Sender excluded
    expect(msgs.find((m) => m.to_instance === a.id)).toBeUndefined();
  });

  it("throws when name is not found", async () => {
    const zk = new MockZkClient();
    const router = new MessageRouter(zk as unknown as ZkClient);
    await expect(router.send("l", "L", "x", undefined, false, "Nobody")).rejects.toThrow(/not found/);
  });

  it("throws without recipient", async () => {
    const zk = new MockZkClient();
    const router = new MessageRouter(zk as unknown as ZkClient);
    await expect(router.send("l", "L", "x")).rejects.toThrow();
  });
});
