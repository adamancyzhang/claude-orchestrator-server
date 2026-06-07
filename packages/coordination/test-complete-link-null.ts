import { InMemoryZkClient } from "@co/infra";
import { TaskQueue } from "./src/task-queue.js";
import { zkPaths, asInstanceId } from "@co/contracts";

async function test() {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();

  const q = new TaskQueue({ zk });

  console.log("Testing task_queue.complete with link: null task");

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
    const claimed = await q.claimById(task.id, asInstanceId("worker-id"));
    console.log("Task claimed:", claimed?.id, "link:", claimed?.link);

    // Complete the task
    await q.complete(task.id, "Task completed", asInstanceId("worker-id"), "worker", 5.0);

    // Get the completed task
    const completed = await q.getCompleted(task.id);
    console.log("Task completed:", completed?.id, "link:", completed?.link, "status:", completed?.status);
  } catch (err) {
    console.error("Error completing task:", err);
  }
}

test();
