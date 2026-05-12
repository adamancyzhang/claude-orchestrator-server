// ZK_ROOT_PATH must be set via environment before running this test.
// Use: ZK_ROOT_PATH=/test-root node this-file.js
// Or run via: bash workspace-tests/run-all.sh


import { InstanceRegistry } from "../../dist/modules/registry.js";
import { MockWorker } from "../lib/mock-worker.js";
import { assert, runScenario } from "../lib/test-zk.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

await runScenario(
  "05 — Broadcast Messages",
  ZK_HOSTS,
  process.env.ZK_ROOT_PATH,
  async (zk) => {
    const sender = new MockWorker(zk, "Leader", "planner");
    const worker1 = new MockWorker(zk, "Worker1", "builder");
    const worker2 = new MockWorker(zk, "Worker2", "verifier");
    const worker3 = new MockWorker(zk, "Worker3", "reviewer");

    await sender.register();
    await worker1.register();
    await worker2.register();
    await worker3.register();

    // Sender broadcast to all
    const sent = await sender.broadcastMessage("Emergency: server is down!");
    // Broadcast should send to all other instances (3 workers, excluding sender)
    assert(sent.length === 3, `Broadcast should reach 3 workers, got ${sent.length}`);
    assert(
      sent.every((m) => m.type === "broadcast"),
      "All broadcast messages should have type=broadcast"
    );

    // Each worker should receive the broadcast
    for (const w of [worker1, worker2, worker3]) {
      const inbox = await w.pollMessages();
      const broadcast = inbox.find((m) => m.content.includes("Emergency"));
      assert(
        broadcast !== undefined,
        `${w.name} should receive the broadcast message`
      );
      assert(
        broadcast.from_name === "Leader",
        `Broadcast from should be Leader for ${w.name}, got ${broadcast.from_name}`
      );
      assert(
        broadcast.type === "broadcast",
        `Broadcast type should be broadcast for ${w.name}`
      );
    }

    // Sender should NOT have the broadcast in their own inbox (no self-send)
    const senderInbox = await sender.pollMessages();
    const selfMsg = senderInbox.find((m) => m.content.includes("Emergency"));
    assert(
      selfMsg === undefined,
      "Sender should not receive own broadcast message"
    );
  }
);
