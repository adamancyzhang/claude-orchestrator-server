import { ZkClient } from "../zk/client.js";
import {
  TaskSchema,
  createTask,
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
    assignedTo?: string,
    createdByName?: string,
    assignedToName?: string | null,
    link?: string | null,
    chainId?: string | null,
    dependsOn?: string[],
    blockedBy?: string[],
  ): Promise<Task> {
    const task = createTask({
      title,
      description,
      priority: [0, 1, 2].includes(priority) ? priority : 1,
      created_by: createdBy,
      assigned_to: assignedTo ?? null,
      created_by_name: createdByName,
      assigned_to_name: assignedToName ?? null,
      link,
      chain_id: chainId,
      depends_on: dependsOn ?? [],
      blocked_by: blockedBy ?? [],
    });
    const taskId = await this.zk.createPendingTask(
      task as unknown as Record<string, unknown>
    );
    task.id = taskId;
    return task;
  }

  async claim(instanceId: string): Promise<Task | null> {
    const pending = await this.zk.listPendingTasks();

    // Read instance role for weight matching
    let instanceRole = "";
    try {
      const instData = await this.zk.getInstance(instanceId);
      instanceRole = (instData?.role as string) ?? "";
    } catch {
      // proceed without role-weight sorting
    }

    const roleToLink: Record<string, string> = {
      planner: "plan",
      builder: "build",
      verifier: "verify",
      reviewer: "review",
      accepter: "accept",
    };

    const sortKey = (item: [string, Record<string, unknown>]) => {
      const [, data] = item;
      const assigned = data.assigned_to as string | null;
      const prio = (data.priority as number) ?? 1;
      const isAssignedToMe = assigned === instanceId ? 0 : 1;
      const taskLink = (data.link as string) ?? "";
      const roleMatch = taskLink && roleToLink[instanceRole] === taskLink ? 0 : 1;
      return [isAssignedToMe, roleMatch, prio, item[0]];
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
      // Embed full task_data in claimed node for recovery
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
    if (!claimedData || Object.keys(claimedData).length === 0) {
      throw new Error(`Task ${taskId} is not claimed by ${instanceId}`);
    }

    const claimedAt = claimedData.claimed_at as string;
    const durationSeconds = claimedAt
      ? Math.round((Date.now() - new Date(claimedAt).getTime()) / 1000)
      : null;

    const now = utcNow();
    const data = {
      id: taskId,
      title: (claimedData.title as string) ?? "",
      description: (claimedData.description as string) ?? "",
      priority: (claimedData.priority as number) ?? 1,
      status: "completed",
      created_by: (claimedData.created_by as string) ?? "",
      created_at: (claimedData.created_at as string) ?? now,
      assigned_to: (claimedData.assigned_to as string) ?? null,
      claimed_by: instanceId,
      claimed_at: claimedAt ?? now,
      completed_at: now,
      completed_by_name: (claimedData.claimed_by_name as string) ?? "",
      result,
      link: (claimedData.link as string) ?? null,
      chain_id: (claimedData.chain_id as string) ?? null,
      retry_count: (claimedData.retry_count as number) ?? 0,
      duration_seconds: durationSeconds,
      created_by_name: (claimedData.created_by_name as string) ?? "",
      assigned_to_name: (claimedData.assigned_to_name as string) ?? null,
      blocked_reason: null,
      fail_reason: null,
    };
    await this.zk.saveCompletedTask(taskId, data);
    await this.zk.deleteClaimedTask(instanceId, taskId);
    return TaskSchema.parse(data);
  }

  async block(instanceId: string, taskId: string, reason: string): Promise<Task> {
    const claimedData = await this.zk.getClaimedTask(instanceId, taskId);
    if (!claimedData || Object.keys(claimedData).length === 0) {
      throw new Error(`Task ${taskId} is not claimed by ${instanceId}`);
    }
    claimedData.status = "blocked";
    claimedData.blocked_reason = reason;
    await this.zk.updateClaimedTask(instanceId, taskId, claimedData);
    return TaskSchema.parse({ ...claimedData, id: taskId });
  }

  async fail(instanceId: string, taskId: string, reason: string): Promise<Task> {
    const claimedData = await this.zk.getClaimedTask(instanceId, taskId);
    if (!claimedData || Object.keys(claimedData).length === 0) {
      throw new Error(`Task ${taskId} is not claimed by ${instanceId}`);
    }
    await this.zk.deleteClaimedTask(instanceId, taskId);

    const now = utcNow();
    const data = {
      ...claimedData,
      id: taskId,
      status: "failed",
      completed_at: now,
      fail_reason: reason,
      result: `Failed: ${reason}`,
    };
    await this.zk.saveCompletedTask(taskId, data);
    return TaskSchema.parse(data);
  }

  async retry(taskId: string): Promise<Task> {
    const completedData = await this.zk.getCompletedTask(taskId);
    if (!completedData) {
      throw new Error(`Task ${taskId} not found in completed tasks`);
    }

    const retryCount = (completedData.retry_count as number ?? 0) + 1;
    const taskData = {
      title: completedData.title ?? "",
      description: completedData.description ?? "",
      priority: completedData.priority ?? 1,
      created_by: (completedData.created_by as string) ?? "",
      assigned_to: (completedData.assigned_to as string) ?? null,
      assigned_to_name: (completedData.assigned_to_name as string) ?? null,
      created_by_name: (completedData.created_by_name as string) ?? "",
      created_at: utcNow(),
      link: (completedData.link as string) ?? null,
      chain_id: (completedData.chain_id as string) ?? null,
      retry_count: retryCount,
      status: "pending",
      blocked_reason: null,
      fail_reason: null,
      claimed_at: null,
      claimed_by: null,
      completed_at: null,
      completed_by_name: null,
      duration_seconds: null,
      result: null,
    };
    const newTaskId = await this.zk.createPendingTask(taskData);
    return TaskSchema.parse({ ...taskData, id: newTaskId });
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
    if (!status || status === "claimed" || status === "in_progress" || status === "blocked") {
      for (const [insId, taskId, data] of await this.zk.listClaimedTasks()) {
        data.id = taskId;
        data.claimed_by = insId;
        if (status && data.status !== status) continue;
        tasks.push(TaskSchema.parse(data));
      }
    }
    if (!status || status === "completed" || status === "failed") {
      for (const data of await this.zk.listCompletedTasks()) {
        data.title = data.title ?? "";
        if (status && data.status !== status) continue;
        tasks.push(TaskSchema.parse(data));
      }
    }

    return tasks;
  }
}
