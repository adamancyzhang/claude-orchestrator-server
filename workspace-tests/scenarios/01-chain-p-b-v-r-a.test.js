// ZK_ROOT_PATH must be set via environment before running this test.
// Use: ZK_ROOT_PATH=/test-root node this-file.js
// Or run via: bash workspace-tests/run-all.sh


import { InstanceRegistry } from "../../dist/modules/registry.js";
import { TaskQueue } from "../../dist/modules/task-queue.js";
import { MockWorker } from "../lib/mock-worker.js";
import { chainFactory, CHAIN_LINKS, LINK_TO_ROLE } from "../lib/chain-helpers.js";
import { assert, sleep, runScenario } from "../lib/test-zk.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

await runScenario(
  "01 — P→B→V→R→A Full Chain",
  ZK_HOSTS,
  process.env.ZK_ROOT_PATH,
  async (zk) => {
    const registry = new InstanceRegistry(zk);
    const taskQueue = new TaskQueue(zk);
    const chainId = `chain-e2e-${Date.now()}`;
    const baseTitle = "Build REST API";

    // Create 5 workers with chain factory
    const factory = chainFactory(chainId, baseTitle);
    const planner = new MockWorker(zk, "Alice", "planner", {
      createNextInChain: factory,
    });
    const builder = new MockWorker(zk, "Bob", "builder", {
      createNextInChain: factory,
    });
    const verifier = new MockWorker(zk, "Eve", "verifier", {
      createNextInChain: factory,
    });
    const reviewer = new MockWorker(zk, "Frank", "reviewer", {
      createNextInChain: factory,
    });
    const accepter = new MockWorker(zk, "Grace", "accepter", {
      createNextInChain: factory,
    });

    // Register all workers
    for (const w of [planner, builder, verifier, reviewer, accepter]) {
      await w.register();
    }

    const instances = await registry.listAll();
    assert(instances.length >= 5, `Expected >=5 instances, got ${instances.length}`);

    // Seed the first plan task
    const seed = await taskQueue.push(
      `${baseTitle} — PLAN`,
      "Design the API architecture and endpoints",
      1,
      planner.instanceId,
      undefined,
      undefined,
      undefined,
      "plan",
      chainId
    );
    assert(seed.status === "pending", "Seed task should be pending");

    // Each worker does exactly one work cycle to claim its role-matched task
    const workers = [planner, builder, verifier, reviewer, accepter];
    for (const w of workers) {
      // Poll until we get a matching task (some workers may need to wait for
      // the previous worker to push the next chain link task)
      let result = null;
      for (let attempt = 0; attempt < 20 && !result; attempt++) {
        result = await w.doOneWorkCycle();
        if (!result) await sleep(100);
      }
      assert(
        result !== null,
        `${w.name} (${w.role}) should complete exactly 1 task`
      );
      assert(
        result.completed.status === "completed",
        `${w.name}'s task should be completed`
      );
    }

    // Verify the full chain: exactly 5 tasks with our chainId
    const allTasks = await taskQueue.listTasks();
    const chainTasks = allTasks.filter((t) => t.chain_id === chainId);
    assert(
      chainTasks.length === 5,
      `Expected 5 chain tasks, got ${chainTasks.length}`
    );

    // Verify each link is present and completed
    for (const link of CHAIN_LINKS) {
      const match = chainTasks.find((t) => t.link === link);
      assert(match, `Missing task with link "${link}"`);
      assert(
        match.status === "completed",
        `Task ${match.id} (${match.link}) should be completed, got ${match.status}`
      );
    }

    // Verify role-based claim: each task was claimed by the correct role
    const completedTasks = chainTasks.filter((t) => t.status === "completed");
    for (const t of completedTasks) {
      const expectedRole = LINK_TO_ROLE[t.link];
      const claimant = instances.find((i) => i.id === t.claimed_by);
      assert(
        claimant && claimant.role === expectedRole,
        `Task ${t.id} (${t.link}) claimed by ${claimant?.role}, expected ${expectedRole}`
      );
    }
  }
);
