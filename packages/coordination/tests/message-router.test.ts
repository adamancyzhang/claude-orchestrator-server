// CORE-RETENTION
// Locks in: MessageRouter.send delivers to the recipient's inbox path with
// optional v0.7 fields (upstream_commits / spawned_from / next_requirement)
// forwarded verbatim, poll returns unread messages without marking them,
// ack marks a message as read after processing, waitForMessage fires the
// callback for both pre-existing and newly arrived messages and acks them,
// and dismiss removes a message from the inbox. send() requires `to_instance`.
// Critical because: every inter-Worker hop and every chain dispatch goes
// through this surface; a silent drop of upstream_commits would break the
// per-link rebase contract and corrupt the chain's commit history.
// Primary sources: packages/coordination/src/message-router.ts

import { describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  ValidationError,
  zkPaths,
} from "@co/contracts";
import { InMemoryZkClient } from "@co/infra";
import { MessageRouter } from "../src/message-router.js";

async function makeZk(): Promise<InMemoryZkClient> {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();
  return zk;
}

const ALICE = asInstanceId("inst-alice");
const BOB = asInstanceId("inst-bob");

describe("MessageRouter.send", () => {
  it("delivers a direct message to the recipient inbox", async () => {
    const zk = await makeZk();
    const router = new MessageRouter({ zk });

    const sent = await router.send({
      type: "direct",
      from_instance: ALICE,
      from_name: "Alice",
      to_instance: BOB,
      content: "hi bob",
    });
    expect(sent.id).toMatch(/^msg-/);
    expect(sent.to_instance).toBe(BOB);
    expect(sent.content).toBe("hi bob");

    const received = await router.poll(BOB);
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toBe("hi bob");
    // poll returns unread messages without marking them as read.
    expect(received[0]?.read).toBe(false);

    // After ack, the message is marked as read and excluded from future polls.
    await router.ack(BOB, received[0]!.id);
    const second = await router.poll(BOB);
    expect(second).toHaveLength(0);
  });

  it("forwards upstream_commits / spawned_from / next_requirement when present", async () => {
    const zk = await makeZk();
    const router = new MessageRouter({ zk });

    await router.send({
      type: "task_dispatch",
      from_instance: ALICE,
      from_name: "Alice",
      to_instance: BOB,
      content: "do work",
      upstream_commits: { plan: "abc", execute: "def" },
      spawned_from: asChainId("c-parent"),
      next_requirement: "follow-up requirement",
    });

    const received = await router.poll(BOB);
    expect(received[0]?.upstream_commits).toEqual({
      plan: "abc",
      execute: "def",
    });
    expect(received[0]?.spawned_from).toBe("c-parent");
    expect(received[0]?.next_requirement).toBe("follow-up requirement");
  });

  it("rejects send() without to_instance (broadcast must use a different path)", async () => {
    const zk = await makeZk();
    const router = new MessageRouter({ zk });
    await expect(
      router.send({
        type: "direct",
        from_instance: ALICE,
        from_name: "Alice",
        to_instance: null,
        content: "x",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("MessageRouter.poll", () => {
  it("returns messages in deterministic id order (sequential sort)", async () => {
    const zk = await makeZk();
    const router = new MessageRouter({ zk });

    await router.send({
      type: "direct",
      from_instance: ALICE,
      from_name: "Alice",
      to_instance: BOB,
      content: "first",
    });
    await router.send({
      type: "direct",
      from_instance: ALICE,
      from_name: "Alice",
      to_instance: BOB,
      content: "second",
    });

    const msgs = await router.poll(BOB);
    expect(msgs.map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("poll does not mark messages as read; ack persists the read flag", async () => {
    const zk = await makeZk();
    const router = new MessageRouter({ zk });
    await router.send({
      type: "direct",
      from_instance: ALICE,
      from_name: "Alice",
      to_instance: BOB,
      content: "x",
    });
    const first = await router.poll(BOB);
    expect(first[0]?.read).toBe(false);
    // Second poll without ack still returns the message (unread).
    const second = await router.poll(BOB);
    expect(second[0]?.read).toBe(false);
    // After ack, the message is marked read and excluded from polls.
    await router.ack(BOB, first[0]!.id);
    const third = await router.poll(BOB);
    expect(third).toHaveLength(0);
  });
});

describe("MessageRouter.waitForMessage", () => {
  it("delivers existing messages immediately and newly-arrived ones via the watcher", async () => {
    const zk = await makeZk();
    const router = new MessageRouter({ zk });

    // Pre-existing message before the wait starts.
    await router.send({
      type: "direct",
      from_instance: ALICE,
      from_name: "Alice",
      to_instance: BOB,
      content: "old",
    });

    const received: string[] = [];
    await router.waitForMessage(BOB, (m) => {
      received.push(m.content);
    });

    expect(received).toContain("old");

    // New message after the watcher is wired up.
    await router.send({
      type: "direct",
      from_instance: ALICE,
      from_name: "Alice",
      to_instance: BOB,
      content: "new",
    });

    // Drain microtasks; InMemoryZkClient fires watch callbacks synchronously
    // via fireChildWatch, but the watcher kicks off an async poll inside.
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toContain("new");
    expect(received).toHaveLength(2);
  });

  it("does not emit the same message twice across initial + watch deliveries", async () => {
    const zk = await makeZk();
    const router = new MessageRouter({ zk });
    await router.send({
      type: "direct",
      from_instance: ALICE,
      from_name: "Alice",
      to_instance: BOB,
      content: "once",
    });

    const seen: string[] = [];
    await router.waitForMessage(BOB, (m) => {
      seen.push(m.id);
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toHaveLength(1);
  });
});

describe("MessageRouter.dismiss", () => {
  it("removes a message from the inbox", async () => {
    const zk = await makeZk();
    const router = new MessageRouter({ zk });

    const sent = await router.send({
      type: "direct",
      from_instance: ALICE,
      from_name: "Alice",
      to_instance: BOB,
      content: "remove me",
    });

    await router.dismiss(BOB, sent.id);
    expect(await router.poll(BOB)).toEqual([]);
  });
});
