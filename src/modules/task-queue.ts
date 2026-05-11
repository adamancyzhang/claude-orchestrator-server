import { ZkClient } from "../zk/client.js";
import {
  TaskSchema,
  createTask,
  TaskStatus,
  type Task,
} from "../models/schemas.js";

function utcNow(): string {
  return new Date().toISOString();
}

export class TaskQueue {
  constructor(private zk: ZkClient) {}

  async push(
    title: string,
    description: string = "",
    priority: number = 1,
    createdBy: string = "",
    assignedTo?: string
  ): Promise<Task> {
    const task = createTask({
      title,
      description,
      priority: [0, 1, 2].includes(priority) ? priority : 1,
      created_by: createdBy,
      assigned_to: assignedTo ?? null,
    });
    const taskId = await this.zk.createPendingTask(
      task as unknown as Record<string, unknown>
    );
    task.id = taskId;
    return task;
  }

  async claim(instanceId: string): Promise<Task | null> {
    const pending = await this.zk.listPendingTasks();

    // Sort: assigned_to matches instanceId first, then priority (lower = higher), then FIFO
    const sortKey = (item: [string, Record<string, unknown>]) => {
      const [, data] = item;
      const assigned = data.assigned_to as string | null;
      const prio = (data.priority as number) ?? 1;
      const isAssignedToMe = assigned === instanceId ? 0 : 1;
      return [isAssignedToMe, prio, item[0]];
    };

    pending.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });

    for (const [taskId, data] of pending) {
      const taskBytes = Buffer.from(JSON.stringify(data), "utf-8");
      const claimed = await this.zk.claimTask(instanceId, taskId, taskBytes);
      if (!claimed) continue;

      await this.zk.deletePendingTask(taskId);
      const now = utcNow();
      data.id = taskId;
      data.status = "claimed";
      data.claimed_at = now;
      data.claimed_by = instanceId;
      return TaskSchema.parse(data);
    }

    return null;
  }

  async complete(
    instanceId: string,
    taskId: string,
    result: string
  ): Promise<Task> {
    const claimedData = await this.zk.getClaimedTask(instanceId, taskId);
    await this.zk.deleteClaimedTask(instanceId, taskId);

    const now = utcNow();
    const data = {
      id: taskId,
      title: (claimedData.title as string) ?? "",
      description: (claimedData.description as string) ?? "",
      priority: (claimedData.priority as number) ?? 1,
      created_by: (claimedData.created_by as string) ?? "",
      assigned_to: (claimedData.assigned_to as string) ?? null,
      completed_by: instanceId,
      completed_at: now,
      result,
    };
    await this.zk.saveCompletedTask(taskId, data);
    return TaskSchema.parse({ ...data, status: "completed" });
  }

  async listTasks(status?: string): Promise<Task[]> {
    const tasks: Task[] = [];

    if (!status || status === "pending") {
      for (const [tid, data] of await this.zk.listPendingTasks()) {
        data.id = tid;
        data.status = "pending";
        tasks.push(TaskSchema.parse(data));
      }
    }
    if (!status || status === "claimed") {
      for (const [insId, taskId, data] of await this.zk.listClaimedTasks()) {
        data.id = taskId;
        data.status = "claimed";
        data.claimed_by = insId;
        tasks.push(TaskSchema.parse(data));
      }
    }
    if (!status || status === "completed") {
      for (const data of await this.zk.listCompletedTasks()) {
        data.title = data.title ?? "";
        data.status = "completed";
        tasks.push(TaskSchema.parse(data));
      }
    }

    return tasks;
  }
}
