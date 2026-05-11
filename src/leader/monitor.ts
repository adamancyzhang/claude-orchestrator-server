import { ZkClient } from "../zk/client.js";
import { LeaderEventBus } from "./event-bus.js";

export class WorkerMonitor {
  private knownInstances = new Set<string>();
  private instanceNames = new Map<string, string>();

  constructor(
    private zk: ZkClient,
    private eventBus: LeaderEventBus,
  ) {}

  async start(): Promise<void> {
    await this.watchLoop();
  }

  private async watchLoop(): Promise<void> {
    const children = await this.zk.watchInstances(async (newChildren) => {
      await this.onChildrenChanged(newChildren);
      this.watchLoop();
    });
    await this.onChildrenChanged(children);
  }

  private async onChildrenChanged(children: string[]): Promise<void> {
    const curr = new Set(children);

    for (const id of curr) {
      if (!this.knownInstances.has(id)) {
        const data = await this.zk.getInstance(id);
        if (data && data.role !== "leader") {
          const instName = data.name as string;
          this.eventBus.emit({
            type: "worker_joined",
            instance: data,
            instanceId: id,
            name: instName,
          });
          this.instanceNames.set(id, instName);
        }
      }
    }

    for (const id of this.knownInstances) {
      if (!curr.has(id)) {
        const name = this.instanceNames.get(id) ?? id.slice(0, 8);
        this.eventBus.emit({ type: "worker_left", instanceId: id, name });
        this.instanceNames.delete(id);
      }
    }

    this.knownInstances = curr;
  }
}
