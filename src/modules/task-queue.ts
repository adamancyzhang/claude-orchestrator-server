import { ZkClient } from "../zk/client.js";
import {
  TaskSchema,
  InstanceSchema,
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
    const taskId = await this.zk.createPendingTask(task);
    task.id = taskId;
    return task;
  }

  async claim(instanceId: string): Promise<Task | null> {
    const pending = await this.zk.listPendingTasks();

    // Read instance role for weight matching
    const instRaw = await this.zk.getInstance(instanceId);
    const instData = instRaw ? InstanceSchema.parse(instRaw) : null;
    const instanceRole = instData?.role ?? "";

    const roleToLink: Record<string, string> = {
      planner: "plan",
      builder: "build",
      verifier: "verify",
      reviewer: "review",
      accepter: "accept",
      leader: "decompose",
    };

    const sortKey = (item: [string, unknown]) => {
      const [, raw] = item;
      const data = TaskSchema.parse(raw);
      const assigned = data.assigned_to;
      const prio = data.priority ?? 1;
      const isAssignedToMe = assigned === instanceId ? 0 : 1;
      const taskLink = data.link ?? "";
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

    for (const [taskId, raw] of pending) {
      const data = TaskSchema.parse(raw);

      // Skip leader_only tasks for non-leader instances
      if (data.leader_only === true && instanceRole !== "leader") continue;

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
      return data;
    }

    return null;
  }

  async complete(
    instanceId: string,
    taskId: string,
    result: string
  ): Promise<Task> {
    const raw = await this.zk.getClaimedTask(instanceId, taskId);
    if (!raw || (typeof raw === "object" && Object.keys(raw).length === 0)) {
      throw new Error(`Task ${taskId} is not claimed by ${instanceId}`);
    }

    const claimedData = TaskSchema.parse(raw);
    const claimedAt = claimedData.claimed_at;
    const durationSeconds = claimedAt
      ? Math.round((Date.now() - new Date(claimedAt).getTime()) / 1000)
      : null;

    const now = utcNow();
    const data = {
      id: taskId,
      title: claimedData.title,
      description: claimedData.description ?? "",
      priority: claimedData.priority,
      status: "completed" as const,
      created_by: claimedData.created_by,
      created_at: claimedData.created_at ?? now,
      assigned_to: claimedData.assigned_to,
      claimed_by: instanceId,
      claimed_at: claimedAt ?? now,
      completed_at: now,
      completed_by_name: claimedData.completed_by_name ?? "",
      result,
      link: claimedData.link,
      chain_id: claimedData.chain_id,
      retry_count: claimedData.retry_count,
      duration_seconds: durationSeconds,
      created_by_name: claimedData.created_by_name,
      assigned_to_name: claimedData.assigned_to_name,
      blocked_reason: null,
      fail_reason: null,
    };
    await this.zk.saveCompletedTask(taskId, data);
    await this.zk.deleteClaimedTask(instanceId, taskId);
    return TaskSchema.parse(data);
  }

  async block(instanceId: string, taskId: string, reason: string): Promise<Task> {
    const raw = await this.zk.getClaimedTask(instanceId, taskId);
    if (!raw || (typeof raw === "object" && Object.keys(raw).length === 0)) {
      throw new Error(`Task ${taskId} is not claimed by ${instanceId}`);
    }
    const claimedData = TaskSchema.parse(raw);
    claimedData.status = "blocked";
    claimedData.blocked_reason = reason;
    await this.zk.updateClaimedTask(instanceId, taskId, claimedData);
    return claimedData;
  }

  async fail(instanceId: string, taskId: string, reason: string): Promise<Task> {
    const raw = await this.zk.getClaimedTask(instanceId, taskId);
    if (!raw || (typeof raw === "object" && Object.keys(raw).length === 0)) {
      throw new Error(`Task ${taskId} is not claimed by ${instanceId}`);
    }
    const claimedData = TaskSchema.parse(raw);
    await this.zk.deleteClaimedTask(instanceId, taskId);

    const now = utcNow();
    const data = {
      ...claimedData,
      status: "failed" as const,
      completed_at: now,
      fail_reason: reason,
      result: `Failed: ${reason}`,
    };
    await this.zk.saveCompletedTask(taskId, data);
    return TaskSchema.parse(data);
  }

  async retry(taskId: string): Promise<Task> {
    const raw = await this.zk.getCompletedTask(taskId);
    if (!raw) {
      throw new Error(`Task ${taskId} not found in completed tasks`);
    }

    const completedData = TaskSchema.parse(raw);
    const retryCount = (completedData.retry_count ?? 0) + 1;
    const taskData = {
      title: completedData.title ?? "",
      description: completedData.description ?? "",
      priority: completedData.priority ?? 1,
      created_by: completedData.created_by ?? "",
      assigned_to: completedData.assigned_to,
      assigned_to_name: completedData.assigned_to_name,
      created_by_name: completedData.created_by_name ?? "",
      created_at: utcNow(),
      link: completedData.link,
      chain_id: completedData.chain_id,
      retry_count: retryCount,
      status: "pending" as const,
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
      for (const [tid, raw] of await this.zk.listPendingTasks()) {
        const data = TaskSchema.parse(raw);
        data.id = tid;
        data.status = "pending";
        tasks.push(data);
      }
    }
    if (!status || status === "claimed" || status === "in_progress" || status === "blocked") {
      for (const [insId, taskId, raw] of await this.zk.listClaimedTasks()) {
        const data = TaskSchema.parse(raw);
        data.id = taskId;
        data.claimed_by = insId;
        if (status && data.status !== status) continue;
        tasks.push(data);
      }
    }
    if (!status || status === "completed" || status === "failed") {
      for (const raw of await this.zk.listCompletedTasks()) {
        const data = TaskSchema.parse(raw);
        if (status && data.status !== status) continue;
        tasks.push(data);
      }
    }

    return tasks;
  }
}
