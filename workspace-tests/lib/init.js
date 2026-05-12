// Set ZK_ROOT_PATH BEFORE any imports that depend on paths.ts.
// Must be set before dynamic imports so paths.ts sees it during evaluation.
process.env.ZK_ROOT_PATH =
  process.env.ZK_ROOT_PATH || `/workspace-test-${process.pid}`;

/**
 * Dynamically imports all orchestrator modules after ZK_ROOT_PATH is set.
 * This is needed because ESM static imports are hoisted and evaluate before
 * top-level code, missing the env var set above.
 */
export async function init() {
  const [zkClient, registryMod, taskQueueMod, messageRouterMod] =
    await Promise.all([
      import("../../dist/zk/client.js"),
      import("../../dist/modules/registry.js"),
      import("../../dist/modules/task-queue.js"),
      import("../../dist/modules/message-router.js"),
    ]);

  return {
    ZkClient: zkClient.ZkClient,
    InstanceRegistry: registryMod.InstanceRegistry,
    TaskQueue: taskQueueMod.TaskQueue,
    MessageRouter: messageRouterMod.MessageRouter,
  };
}
