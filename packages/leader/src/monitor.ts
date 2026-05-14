import type {
  IEventBus,
  IInstanceRegistry,
  Instance,
  InstanceId,
  LeaderEvent,
} from "@co/contracts";

export class WorkerMonitor {
  private known = new Map<InstanceId, Instance>();
  private stopped = false;

  constructor(
    private readonly registry: IInstanceRegistry,
    private readonly bus: IEventBus<LeaderEvent>,
  ) {}

  async start(): Promise<void> {
    const initial = await this.registry.watch((list) =>
      this.onChange(list),
    );
    this.onChange(initial);
  }

  stop(): void {
    this.stopped = true;
  }

  private onChange(instances: readonly Instance[]): void {
    if (this.stopped) return;
    const current = new Map<InstanceId, Instance>();
    for (const inst of instances) {
      current.set(inst.id, inst);
      if (!this.known.has(inst.id) && inst.role !== "leader") {
        this.bus.emit({ type: "worker_joined", instance: inst });
      } else {
        const prev = this.known.get(inst.id);
        if (prev && prev.status !== inst.status) {
          this.bus.emit({
            type: "worker_status_changed",
            instance_id: inst.id,
            status: inst.status,
            current_task_id: inst.current_task_id,
          });
        }
      }
    }
    for (const [id, prev] of this.known) {
      if (!current.has(id) && prev.role !== "leader") {
        this.bus.emit({ type: "worker_left", instance_id: id, name: prev.name });
      }
    }
    this.known = current;
  }
}
