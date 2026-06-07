import { InMemoryZkClient } from "@co/infra";
import { TaskQueue } from "./src/task-queue.js";
import { zkPaths, asInstanceId } from "@co/contracts";

async function test() {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();

  const q = new TaskQueue({ zk });

  console.log("Testing task_queue.listPending with link: null tasks");

  try {
    // Create tasks with link: null
    await q.push({
      title: "Task 1",
      link: null,
    });

    await q.push({
      title: "Task 2",
      link: null,
    });

    await q.push({
      title: "Task 3",
      link: "execute",
    });

    // List pending tasks
    const pending = await q.listPending();

    console.log("Pending tasks:");
    for (const task of pending) {
      console.log(`  ${task.id}: ${task.title} (link: ${task.link})`);
    }
  } catch (err) {
    console.error("Error listing pending tasks:", err);
  }
}

test();
