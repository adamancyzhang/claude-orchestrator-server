// ZK_ROOT_PATH must be set via environment before running this test.
// Use: ZK_ROOT_PATH=/test-root node this-file.js
// Or run via: bash workspace-tests/run-all.sh


import { InstanceRegistry } from "../../dist/modules/registry.js";
import { TaskQueue } from "../../dist/modules/task-queue.js";
import { MockWorker } from "../lib/mock-worker.js";
import { CHAIN_LINKS, LINK_TO_ROLE } from "../lib/chain-helpers.js";
import { assert, sleep, runScenario } from "../lib/test-zk.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

await runScenario(
  "06 — Concurrent Task Chains",
  ZK_HOSTS,
  process.env.ZK_ROOT_PATH,
  async (zk) => {
    const registry = new InstanceRegistry(zk);
    const taskQueue = new TaskQueue(zk);

    // 3 independent chains
    const chainIds = ["chain-A", "chain-B", "chain-C"].map(
      (suffix) => `concurrent-${Date.now()}-${suffix}`
    );
    const baseTitles = ["Build Auth API", "Build DB Layer", "Build Frontend"];

    // Create and register 5 role workers
    const planner = new MockWorker(zk, "Alice", "planner");
    const builder = new MockWorker(zk, "Bob", "builder");
    const verifier = new MockWorker(zk, "Eve", "verifier");
    const reviewer = new MockWorker(zk, "Frank", "reviewer");
    const accepter = new MockWorker(zk, "Grace", "accepter");

    for (const w of [planner, builder, verifier, reviewer, accepter]) {
      await w.register();
    }

    // Push ALL 15 tasks upfront (3 chains × 5 links)
    for (let i = 0; i < 3; i++) {
      for (const link of CHAIN_LINKS) {
        await taskQueue.push(
          `${baseTitles[i]} — ${link.toUpperCase()}`,
          `Step ${link} for chain ${chainIds[i]}`,
          1,
          planner.instanceId,
          undefined,
          undefined,
          undefined,
          link,
          chainIds[i]
        );
      }
    }

    // Run workers in rounds: each round processes one link across all chains
    // This avoids NODE_EXISTS from concurrent completions while still testing
    // that role-weight matching correctly routes tasks
    const workersByLink = {
      plan: planner,
      build: builder,
      verify: verifier,
      review: reviewer,
      accept: accepter,
    };

    for (const link of CHAIN_LINKS) {
      const worker = workersByLink[link];
      // Worker claims all tasks matching its role (3 tasks per chain)
      for (let i = 0; i < 3; i++) {
        let result = null;
        for (let attempt = 0; attempt < 10 && !result; attempt++) {
          result = await worker.doOneWorkCycle();
          if (!result) await sleep(100);
        }
        assert(
          result !== null,
          `${worker.name} should complete task ${i + 1}/3 for link "${link}"`
        );
        assert(
          result.completed.link === link,
          `Completed task link should be "${link}", got "${result.completed.link}"`
        );
      }
    }

    // Verify: all 15 tasks completed, 5 links per chain
    const allTasks = await taskQueue.listTasks();
    for (const chainId of chainIds) {
      const chainTasks = allTasks.filter((t) => t.chain_id === chainId);
      assert(
        chainTasks.length === 5,
        `Chain ${chainId} should have 5 tasks, got ${chainTasks.length}`
      );

      const completed = chainTasks.filter((t) => t.status === "completed");
      assert(
        completed.length === 5,
        `Chain ${chainId}: expected 5 completed, got ${completed.length}: ` +
          chainTasks.map((t) => `${t.link}=${t.status}`).join(", ")
      );

      for (const link of CHAIN_LINKS) {
        const match = chainTasks.find((t) => t.link === link);
        assert(match, `Chain ${chainId} missing link: ${link}`);
        assert(
          match.status === "completed",
          `Chain ${chainId} link ${link} should be completed, got ${match.status}`
        );
      }
    }
  }
);
