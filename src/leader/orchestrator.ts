import { ZkClient } from "../zk/client.js";
import { LeaderEventBus } from "./event-bus.js";

export class TaskOrchestrator {
  private knownPending = new Set<string>();
  private knownClaimed = new Set<string>();

  constructor(
    private zk: ZkClient,
    private eventBus: LeaderEventBus,
  ) {}

  async start(): Promise<void> {
    await this.watchPending();
    await this.watchClaimed();
  }

  private async watchPending(): Promise<void> {
    const children = await this.zk.watchPendingTasks(async (newChildren) => {
      for (const id of newChildren) {
        if (!this.knownPending.has(id)) {
          const data = await this.zk.getPendingTask(id);
          if (data) {
            this.eventBus.emit({ type: "task_created", task: { ...data, id }, taskId: id });
          }
        }
      }
      this.knownPending = new Set(newChildren);
      this.watchPending();
    });
    for (const id of children) {
      const data = await this.zk.getPendingTask(id);
      if (data) {
        this.eventBus.emit({ type: "task_created", task: { ...data, id }, taskId: id });
      }
    }
    this.knownPending = new Set(children);
  }

  private async watchClaimed(): Promise<void> {
    const children = await this.zk.watchClaimedTasks(async (newChildren) => {
      for (const name of newChildren) {
        if (!this.knownClaimed.has(name)) {
          const idx = name.indexOf("-");
          if (idx === -1) continue;
          const insId = name.substring(0, idx);
          const taskId = name.substring(idx + 1);
          this.eventBus.emit({ type: "task_claimed", taskId, instanceId: insId });
        }
      }
      // Detect completed/released tasks
      for (const name of this.knownClaimed) {
        if (!newChildren.includes(name)) {
          const idx = name.indexOf("-");
          if (idx !== -1) {
            const taskId = name.substring(idx + 1);
            this.eventBus.emit({ type: "task_completed", taskId });
          }
        }
      }
      this.knownClaimed = new Set(newChildren);
      this.watchClaimed();
    });
    for (const name of children) {
      const idx = name.indexOf("-");
      if (idx === -1) continue;
      const insId = name.substring(0, idx);
      const taskId = name.substring(idx + 1);
      this.eventBus.emit({ type: "task_claimed", taskId, instanceId: insId });
    }
    this.knownClaimed = new Set(children);
  }
}
