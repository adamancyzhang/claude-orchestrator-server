// ZK_ROOT_PATH must be set via environment before running this test.
// Use: ZK_ROOT_PATH=/test-root node this-file.js
// Or run via: bash workspace-tests/run-all.sh


import { InstanceRegistry } from "../../dist/modules/registry.js";
import { MockWorker } from "../lib/mock-worker.js";
import { assert, runScenario } from "../lib/test-zk.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

await runScenario(
  "04 — Direct Messages Between Workers",
  ZK_HOSTS,
  process.env.ZK_ROOT_PATH,
  async (zk) => {
    const alice = new MockWorker(zk, "Alice", "planner");
    const bob = new MockWorker(zk, "Bob", "builder");

    await alice.register();
    await bob.register();

    // Alice sends a message to Bob
    const sent = await alice.sendMessage(
      bob.instanceId,
      "Hey Bob, can you review my plan?"
    );
    assert(sent.length === 1, `Expected 1 message sent, got ${sent.length}`);
    assert(sent[0].type === "direct", "Message should be direct type");
    assert(sent[0].from_name === "Alice", "From should be Alice");

    // Bob polls and sees the message
    const inbox = await bob.pollMessages();
    assert(inbox.length >= 1, `Bob should have at least 1 message, got ${inbox.length}`);

    const msg = inbox.find((m) => m.content.includes("review my plan"));
    assert(msg !== undefined, "Bob should see Alice's message");
    assert(msg.from_name === "Alice", `From should be Alice, got ${msg.from_name}`);
    assert(msg.read === true, "Message should be marked read after poll");

    // Bob replies
    const reply = await bob.sendMessage(
      alice.instanceId,
      "Sure Alice, send it over!"
    );
    assert(reply.length === 1, "Reply should be sent");

    // Alice polls and sees the reply
    const aliceInbox = await alice.pollMessages();
    const replyMsg = aliceInbox.find((m) => m.content.includes("Sure"));
    assert(replyMsg !== undefined, "Alice should see Bob's reply");
    assert(replyMsg.from_name === "Bob", "Reply from should be Bob");
    assert(replyMsg.type === "direct", "Reply should be direct type");
  }
);
