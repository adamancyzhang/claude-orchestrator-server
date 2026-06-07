import { InMemoryZkClient } from "@co/infra";
import { TaskQueue } from "./src/task-queue.js";
import { zkPaths, asInstanceId } from "@co/contracts";

async function test() {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();

  const q = new TaskQueue({ zk });

  console.log("Testing task_queue.claim with link: null task");

  try {
    // Create a task with link: null
    const task = await q.push({
      title: "Test task",
      description: "Test description",
      criteria: "",
      priority: 1,
      link: null,
      chain_id: "test-chain-id",
      created_by: asInstanceId("leader-id"),
      created_by_name: "leader",
    });

    console.log("Task created:", task.id, "link:", task.link);

    // Claim the task
    const claimed = await q.claim(asInstanceId("worker-id"), "executor");

    console.log("Task claimed:", claimed?.id, "link:", claimed?.link);
  } catch (err) {
    console.error("Error claiming task:", err);
  }
}

test();
