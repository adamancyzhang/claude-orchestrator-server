// ZK_ROOT_PATH must be set via environment before running this test.
// Use: ZK_ROOT_PATH=/test-root node this-file.js
// Or run via: bash workspace-tests/run-all.sh


import { InstanceRegistry } from "../../dist/modules/registry.js";
import { TaskQueue } from "../../dist/modules/task-queue.js";
import { MockWorker } from "../lib/mock-worker.js";
import { assert, runScenario } from "../lib/test-zk.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

await runScenario(
  "02 — Task Block → Fail → Retry",
  ZK_HOSTS,
  process.env.ZK_ROOT_PATH,
  async (zk) => {
    const taskQueue = new TaskQueue(zk);
    const worker = new MockWorker(zk, "Dev1", "builder");
    await worker.register();

    // 1. Push a task
    const task = await taskQueue.push(
      "Block/Fail/Retry Test Task",
      "Will be blocked then failed then retried",
      1,
      worker.instanceId
    );
    assert(task.status === "pending", "Task should start pending");

    // 2. Claim
    const claimed = await taskQueue.claim(worker.instanceId);
    assert(claimed !== null, "Should claim a task");
    assert(claimed.id === task.id, "Should claim the exact task we pushed");
    assert(claimed.status === "claimed", "Task should be claimed");
    assert(claimed.retry_count === 0, "Initial retry_count should be 0");

    // 3. Block
    const blocked = await taskQueue.block(
      worker.instanceId,
      claimed.id,
      "Waiting for upstream dependency"
    );
    assert(blocked.status === "blocked", "Task should be blocked");
    assert(
      blocked.blocked_reason === "Waiting for upstream dependency",
      "Block reason should be set"
    );

    // Verify blocked tasks appear in filtered list
    const blockedList = await taskQueue.listTasks("blocked");
    assert(
      blockedList.some((t) => t.id === claimed.id),
      "Blocked task should appear in blocked list"
    );

    // 4. Fail
    const failed = await taskQueue.fail(
      worker.instanceId,
      claimed.id,
      "Dependency timed out after 30min"
    );
    assert(failed.status === "failed", "Task should be failed");
    assert(
      failed.fail_reason === "Dependency timed out after 30min",
      "Fail reason should be set"
    );

    // Verify failed tasks appear in filtered list
    const failedList = await taskQueue.listTasks("failed");
    assert(
      failedList.some((t) => t.id === claimed.id),
      "Failed task should appear in failed list"
    );

    // 5. Retry — creates NEW task with incremented retry_count
    const retried = await taskQueue.retry(claimed.id);
    assert(retried.status === "pending", "Retried task should be pending");
    assert(
      retried.retry_count === 1,
      `Retried task retry_count should be 1, got ${retried.retry_count}`
    );
    assert(
      retried.id !== claimed.id,
      "Retried task should have a new ID"
    );

    // 6. Claim the retried task (should be the only pending task)
    const reclaimed = await taskQueue.claim(worker.instanceId);
    assert(reclaimed !== null, "Should claim the retried task");
    assert(
      reclaimed.id === retried.id,
      `Should claim retried task ${retried.id}, got ${reclaimed.id}`
    );
    assert(
      reclaimed.retry_count === 1,
      `Reclaimed task should have retry_count=1, got ${reclaimed.retry_count}`
    );

    // 7. Complete the retried task
    const completed = await taskQueue.complete(
      worker.instanceId,
      reclaimed.id,
      "Fixed and completed after retry"
    );
    assert(completed.status === "completed", "Should complete after retry");
    assert(
      completed.retry_count === 1,
      "Completed task should retain retry_count=1"
    );
  }
);
