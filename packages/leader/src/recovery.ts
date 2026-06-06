import {
  OrphanRetryExhaustedError,
  type ChainId,
  type ClaimRecord,
  type IEventBus,
  type IInstanceRegistry,
  type ITaskQueue,
  type ILogger,
  type LeaderEvent,
} from "@co/contracts";
import type { ChainAudit } from "./chain-audit.js";

const MAX_RETRIES = 3;

export class TaskRecovery {
  constructor(
    private readonly queue: ITaskQueue,
    private readonly registry: IInstanceRegistry,
    private readonly bus: IEventBus<LeaderEvent>,
    private readonly logger: ILogger,
    private readonly chain_audit?: ChainAudit,
  ) {}

  start(): void {
    this.bus.on("worker_left", (event) => {
      void this.recoverFor(event.instance_id);
    });
  }

  async scanOrphans(): Promise<void> {
    const instances = await this.registry.list();
    const online = new Set(instances.map((i) => i.id));
    const claimed = await this.queue.listClaimed();
    for (const record of claimed) {
      if (!online.has(record.instance_id)) {
        await this.recoverOrphan(record);
      }
    }
  }

  private async recoverFor(workerId: string): Promise<void> {
    const claimed = await this.queue.listClaimed();
    for (const record of claimed) {
      if (record.instance_id === workerId) {
        await this.recoverOrphan(record);
      }
    }
  }

  private async recoverOrphan(record: ClaimRecord): Promise<void> {
    const snapshot = record.task_snapshot;
    const chainId = (snapshot?.chain_id ?? null) as ChainId | null;
    const link = snapshot?.link ?? null;
    const retryCount = (snapshot?.retry_count ?? 0) + 1;
    // FR-23 — the previously-claiming worker has gone offline; record
    // `worker_left` in the affected chain's audit so the trail explains
    // why we re-queued / failed the task. Bus emits worker_left elsewhere
    // (WorkerMonitor) for TUI; this audit is the per-chain record.
    if (chainId && this.chain_audit) {
      void this.chain_audit
        .record(chainId, {
          event: "worker_left",
          link,
          task_id: record.task_id,
          worker_id: record.instance_id,
          payload: { phase: "orphan_recovery" },
        })
        .catch((err) => this.logger.debug("chain audit record failed", { event: "worker_left", task_id: record.task_id, error: String(err) }));
    }
    if (retryCount > MAX_RETRIES) {
      this.logger.warn("orphan retry exhausted", {
        task_id: record.task_id,
        retry_count: retryCount,
      });
      try {
        await this.queue.fail(
          record.task_id,
          `Max retries (${MAX_RETRIES}) exceeded after worker disconnect`,
        );
      } catch (err) {
        this.logger.error("failed to archive orphan", {
          task_id: record.task_id,
          error: String(err),
        });
      }
      this.bus.emit({
        type: "task_failed",
        task_id: record.task_id,
        reason: "max retries exceeded",
      });
      if (chainId && this.chain_audit) {
        void this.chain_audit
          .record(chainId, {
            event: "task_failed",
            link,
            task_id: record.task_id,
            worker_id: record.instance_id,
            payload: { reason: "max retries exceeded", retry_count: retryCount },
          })
          .catch((err) => this.logger.debug("chain audit record failed", { event: "task_failed", task_id: record.task_id, error: String(err) }));
      }
      throw new OrphanRetryExhaustedError(record.task_id, MAX_RETRIES);
    }
    try {
      const newTask = await this.queue.retry(record.task_id, snapshot);
      this.bus.emit({
        type: "task_recovered",
        task_id: newTask.id,
        retry_count: retryCount,
      });
      if (chainId && this.chain_audit) {
        void this.chain_audit
          .record(chainId, {
            event: "task_recovered",
            link,
            task_id: newTask.id,
            worker_id: record.instance_id,
            payload: { retry_count: retryCount },
          })
          .catch((err) => this.logger.debug("chain audit record failed", { event: "task_recovered", task_id: newTask.id, error: String(err) }));
      }
    } catch (err) {
      this.logger.error("orphan retry failed", {
        task_id: record.task_id,
        error: String(err),
      });
    }
  }
}
