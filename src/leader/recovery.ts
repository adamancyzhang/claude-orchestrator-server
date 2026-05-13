import { ZkClient } from "../zk/client.js";
import { LeaderEventBus } from "./event-bus.js";
import { InstanceSchema, TaskSchema } from "../models/schemas.js";

const MAX_RETRIES = 3;

export class TaskRecovery {
  constructor(
    private zk: ZkClient,
    private eventBus: LeaderEventBus,
  ) {}

  start(): void {
    this.eventBus.on("worker_left", (event) => {
      if (event.type !== "worker_left") return;
      this.recoverOrphanedTasks(event.instanceId);
    });
  }

  async scanOrphans(): Promise<void> {
    if (!this.zk.connected) return;
    const rawInstances = await this.zk.listInstances();
    const onlineIds = new Set(rawInstances.map((r) => InstanceSchema.parse(r).id));
    const claimed = await this.zk.listClaimedTasks();
    for (const [insId, taskId, data] of claimed) {
      if (!onlineIds.has(insId)) {
        await this.recoverOrphan(insId, taskId, data);
      }
    }
  }

  private async recoverOrphan(
    workerId: string,
    taskId: string,
    data: unknown,
  ): Promise<void> {
    const task = TaskSchema.parse(data);
    const retryCount = (task.retry_count ?? 0) + 1;
    if (retryCount > MAX_RETRIES) {
      await this.zk.saveCompletedTask(taskId, {
        ...task,
        status: "failed",
        completed_at: new Date().toISOString(),
        retry_count: retryCount,
        fail_reason: `Max retries (${MAX_RETRIES}) exceeded after worker disconnect`,
      });
      await this.zk.deleteClaimedTask(workerId, taskId);
      this.eventBus.emit({ type: "task_failed", taskId, reason: "Max retries exceeded" });
    } else {
      const { claimed_by: _cb, claimed_at: _ca, ...taskRest } = task;
      const taskData = {
        ...taskRest,
        retry_count: retryCount,
        status: "pending" as const,
      };
      const newTaskId = await this.zk.createPendingTask(taskData);
      await this.zk.deleteClaimedTask(workerId, taskId);
      this.eventBus.emit({ type: "task_recovered", taskId, newTaskId, retryCount });
    }
  }

  private async recoverOrphanedTasks(workerId: string): Promise<void> {
    if (!this.zk.connected) return;
    const claimed = await this.zk.listClaimedTasks();
    for (const [insId, taskId, data] of claimed) {
      if (insId !== workerId) continue;
      await this.recoverOrphan(insId, taskId, data);
    }
  }
}
