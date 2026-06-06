import type {
  IMessageRouter,
  ILogger,
  InstanceId,
  TaskId,
  TaskLink,
  WorkerAction,
  WorkerActivityPayload,
  WorkerPhase,
} from "@co/contracts";

export interface WorkerActivityReporterIdentity {
  instance_id: InstanceId;
  worker_name: string;
  worker_role: string;
  leader_id: InstanceId;
}

export interface WorkerActivityReporterOptions {
  router: IMessageRouter;
  identity: WorkerActivityReporterIdentity;
  logger: ILogger;
  flush_ms?: number;
  max_batch?: number;
  now?: () => Date;
}

export interface ReportInput {
  phase: WorkerPhase;
  action: WorkerAction;
  detail: string;
  next?: string | null;
  link?: TaskLink | null;
  task_id?: TaskId | null;
}

// Batches worker pipeline events and forwards them to the Leader via
// the existing message_router channel. Throttles to (flush_ms /
// max_batch) — whichever fires first — so high-frequency actions
// (tool_use/text) cannot saturate the message queue.
export class WorkerActivityReporter {
  private buffer: WorkerActivityPayload[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly now: () => Date;

  constructor(private readonly opts: WorkerActivityReporterOptions) {
    this.flushMs = opts.flush_ms ?? 200;
    this.maxBatch = opts.max_batch ?? 10;
    this.now = opts.now ?? (() => new Date());
  }

  report(input: ReportInput): void {
    if (this.stopped) return;
    this.buffer.push({
      phase: input.phase,
      action: input.action,
      detail: input.detail,
      next: input.next ?? null,
      link: input.link ?? null,
      task_id: input.task_id ?? null,
      timestamp: this.now().toISOString(),
    });
    if (this.buffer.length >= this.maxBatch) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const last = batch[batch.length - 1];
    try {
      await this.opts.router.send({
        type: "worker_activity",
        from_instance: this.opts.identity.instance_id,
        from_name: this.opts.identity.worker_name,
        from_role: this.opts.identity.worker_role,
        to_instance: this.opts.identity.leader_id,
        content: JSON.stringify({ batch }),
        link: last.link ?? null,
        task_id: last.task_id ?? null,
        chain_id: null,
      });
    } catch (err) {
      this.opts.logger.warn("worker_activity send failed", {
        error: String(err),
        batch_size: batch.length,
      });
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
  }
}
