import { InMemoryZkClient } from "@co/infra";
import { TaskQueue } from "./src/task-queue.js";
import { zkPaths, asInstanceId } from "@co/contracts";

async function test() {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();

  const q = new TaskQueue({ zk });

  console.log("Testing task_queue.watchPending with link: null tasks");

  try {
    // Watch for pending tasks
    const initial = await q.watchPending((tasks) => {
      console.log("Watch callback:", tasks);
    });

    console.log("Initial pending tasks:", initial);

    // Create a task with link: null
    await q.push({
      title: "Task 1",
      link: null,
    });

    // Wait a bit for the watch to trigger
    await new Promise(resolve => setTimeout(resolve, 100));

    console.log("Done");
  } catch (err) {
    console.error("Error watching pending tasks:", err);
  }
}

test();
