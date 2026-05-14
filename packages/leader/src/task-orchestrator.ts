import { parseClaimedNodeName } from "@co/coordination";
import type {
  ClaimRecord,
  IEventBus,
  ITaskQueue,
  LeaderEvent,
  TaskId,
} from "@co/contracts";

export class TaskOrchestrator {
  private knownPending = new Set<TaskId>();
  private knownClaimed = new Map<string, ClaimRecord>();
  private stopped = false;

  constructor(
    private readonly queue: ITaskQueue,
    private readonly bus: IEventBus<LeaderEvent>,
  ) {}

  async start(): Promise<void> {
    const initialPending = await this.queue.watchPending((ids) =>
      this.onPending(ids),
    );
    this.onPending(initialPending);

    const initialClaimed = await this.queue.watchClaimed((records) =>
      this.onClaimed(records),
    );
    this.onClaimed(initialClaimed);
  }

  stop(): void {
    this.stopped = true;
  }

  private async onPending(ids: TaskId[]): Promise<void> {
    if (this.stopped) return;
    const seen = new Set(ids);
    for (const id of ids) {
      if (this.knownPending.has(id)) continue;
      const task = await this.queue.getPending(id);
      if (task) this.bus.emit({ type: "task_created", task });
    }
    this.knownPending = seen;
  }

  private onClaimed(records: ClaimRecord[]): void {
    if (this.stopped) return;
    const keys = new Set<string>();
    for (const r of records) {
      const key = `${r.instance_id}-${r.task_id}`;
      keys.add(key);
      if (!this.knownClaimed.has(key)) {
        this.bus.emit({
          type: "task_claimed",
          task_id: r.task_id,
          instance_id: r.instance_id,
        });
      }
    }
    for (const [key, prev] of this.knownClaimed) {
      if (!keys.has(key)) {
        this.bus.emit({
          type: "task_completed",
          task_id: prev.task_id,
          instance_id: prev.instance_id,
          duration_seconds: null,
        });
      }
    }
    this.knownClaimed = new Map(records.map((r) => [`${r.instance_id}-${r.task_id}`, r]));
  }
}

export { parseClaimedNodeName };
