import { InMemoryZkClient } from "@co/infra";
import { TaskQueue } from "./src/task-queue.js";
import { zkPaths, asInstanceId } from "@co/contracts";

async function test() {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();

  const q = new TaskQueue({ zk });

  console.log("Testing task_queue.push with link: null");

  try {
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

    console.log("Task created successfully:", task);
    console.log("Task link:", task.link);
  } catch (err) {
    console.error("Error creating task:", err);
  }
}

test();
