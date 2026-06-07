import { InMemoryZkClient } from "@co/infra";
import { TaskQueue } from "./src/task-queue.js";
import { zkPaths, asInstanceId } from "@co/contracts";

async function test() {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();

  const q = new TaskQueue({ zk });

  console.log("Testing task_queue.watchClaimed with link: null tasks");

  try {
    // Watch for claimed tasks
    const initial = await q.watchClaimed((records) => {
      console.log("Watch callback:", records.map(r => ({
        task_id: r.task_id,
        link: r.task_snapshot?.link,
      })));
    });

    console.log("Initial claimed tasks:", initial.length);

    // Create a task with link: null
    const task = await q.push({
      title: "Task 1",
      link: null,
    });

    // Claim the task
    await q.claimById(task.id, asInstanceId("worker-id"));

    // Wait a bit for the watch to trigger
    await new Promise(resolve => setTimeout(resolve, 100));

    console.log("Done");
  } catch (err) {
    console.error("Error watching claimed tasks:", err);
  }
}

test();
