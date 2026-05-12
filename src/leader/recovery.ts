import { ZkClient } from "../zk/client.js";
import { LeaderEventBus } from "./event-bus.js";

const MAX_RETRIES = 3;

export class TaskRecovery {
  constructor(
    private zk: ZkClient,
    private eventBus: LeaderEventBus,
  ) {}

  start(): void {
    this.eventBus.on("worker_left", (event) => {
      this.recoverOrphanedTasks(event.instanceId as string);
    });
  }

  async scanOrphans(): Promise<void> {
    if (!this.zk.connected) return;
    const instances = await this.zk.listInstances();
    const onlineIds = new Set(instances.map((i) => i.id as string));
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
    data: Record<string, unknown>,
  ): Promise<void> {
    const retryCount = (data.retry_count as number ?? 0) + 1;
    if (retryCount > MAX_RETRIES) {
      await this.zk.saveCompletedTask(taskId, {
        ...data,
        status: "failed",
        completed_at: new Date().toISOString(),
        retry_count: retryCount,
        fail_reason: `Max retries (${MAX_RETRIES}) exceeded after worker disconnect`,
      });
      await this.zk.deleteClaimedTask(workerId, taskId);
      this.eventBus.emit({ type: "task_failed", taskId, reason: "Max retries exceeded" });
    } else {
      const taskData = { ...data };
      taskData.retry_count = retryCount;
      taskData.status = "pending";
      delete taskData.claimed_by;
      delete taskData.claimed_at;
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
