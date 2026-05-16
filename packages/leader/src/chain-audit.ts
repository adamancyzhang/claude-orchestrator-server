import * as fs from "node:fs";
import * as path from "node:path";
import {
  cachePaths,
  ChainConflictError,
  type ChainId,
  type ILogger,
  type InstanceId,
  type TaskId,
  type TaskLink,
} from "@co/contracts";

export type ChainStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "merge_failed";

export interface ChainManifest {
  chain_id: ChainId;
  created_at: string;
  completed_at: string | null;
  status: ChainStatus;
  leader_id: InstanceId;
  leader_name: string;
  requirement_path: string;
  link_tasks: Record<TaskLink, TaskId | null>;
  link_workers: Record<TaskLink, InstanceId | null>;
  total_retry_count: number;
  max_total_retries: number;
}

export interface ChainOpenMeta {
  created_at: string;
  leader_id: InstanceId;
  leader_name: string;
  requirement_path: string;
  max_total_retries?: number;
}

export const DEFAULT_MAX_TOTAL_RETRIES = 9;

export type ChainAuditEventType =
  | "requirement_received"
  | "chain_opened"
  | "task_dispatch"
  | "completion_report"
  | "feedback_sent"
  | "feedback_unresolved"
  | "chain_id_conflict"
  | "merge_failure"
  | "retry_ceiling_exceeded"
  | "chain_closed"
  | "validation_failure";

export interface ChainAuditEventInput {
  event: ChainAuditEventType;
  link?: TaskLink | null;
  worker_id?: InstanceId | null;
  worker_name?: string | null;
  task_id?: TaskId | null;
  payload?: Record<string, unknown>;
}

export interface ChainAuditOptions {
  cache_paths: cachePaths.CachePathOptions;
  logger: ILogger;
}

/**
 * Persists per-chain audit state under `<co_root>/chains/<chain_id>/`:
 *   - manifest.json   — link-level metadata (created_at / completed_at /
 *                       status / leader_id / requirement_path / link_tasks)
 *   - audit.jsonl     — append-only timeline of events
 *
 * Per-task outputs (definition, exec logs, eval logs, result.md) live under
 * `<co_root>/tasks/<task_id>/`. Downstream link workers resolve upstream
 * outputs via `manifest.link_tasks[<link>] → tasks/<task_id>/result.md`.
 */
export class ChainAudit {
  constructor(private readonly opts: ChainAuditOptions) {}

  async openChain(chainId: ChainId, meta: ChainOpenMeta): Promise<void> {
    const manifestPath = cachePaths.chainManifestPath(
      this.opts.cache_paths,
      chainId,
    );
    // Conflict detection: refuse to overwrite a chain that has reached
    // any terminal state. Re-opening a still-running chain is allowed and
    // serves as a no-op upsert for replays.
    const existing = await this.readManifest(chainId);
    if (existing && existing.status !== "running") {
      throw new ChainConflictError(
        chainId,
        existing.status,
        existing.completed_at,
      );
    }
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    const manifest: ChainManifest = {
      chain_id: chainId,
      created_at: meta.created_at,
      completed_at: null,
      status: "running",
      leader_id: meta.leader_id,
      leader_name: meta.leader_name,
      requirement_path: meta.requirement_path,
      link_tasks: {
        plan: null,
        build: null,
        verify: null,
        review: null,
        accept: null,
      },
      link_workers: {
        plan: null,
        build: null,
        verify: null,
        review: null,
        accept: null,
      },
      total_retry_count: 0,
      max_total_retries: meta.max_total_retries ?? DEFAULT_MAX_TOTAL_RETRIES,
    };
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
    await this.record(chainId, {
      event: "chain_opened",
      payload: { ...meta },
    });
  }

  /**
   * Atomically bump `total_retry_count` and return the post-increment
   * value alongside the manifest's configured ceiling. Used by
   * ChainRouter to enforce a hard cap on feedback loops.
   */
  async incrementRetry(chainId: ChainId): Promise<{
    total_retry_count: number;
    max_total_retries: number;
  } | null> {
    const manifestPath = cachePaths.chainManifestPath(
      this.opts.cache_paths,
      chainId,
    );
    const manifest = await this.readManifest(chainId);
    if (!manifest) return null;
    manifest.total_retry_count =
      (manifest.total_retry_count ?? 0) + 1;
    if (manifest.max_total_retries == null) {
      manifest.max_total_retries = DEFAULT_MAX_TOTAL_RETRIES;
    }
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
    return {
      total_retry_count: manifest.total_retry_count,
      max_total_retries: manifest.max_total_retries,
    };
  }

  async setLinkTask(
    chainId: ChainId,
    link: TaskLink,
    taskId: TaskId,
  ): Promise<void> {
    const manifestPath = cachePaths.chainManifestPath(
      this.opts.cache_paths,
      chainId,
    );
    const manifest = await this.readManifest(chainId);
    if (!manifest) {
      this.opts.logger.warn("setLinkTask: manifest missing", {
        chain_id: chainId,
        link,
      });
      return;
    }
    manifest.link_tasks[link] = taskId;
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
  }

  async setLinkWorker(
    chainId: ChainId,
    link: TaskLink,
    workerId: InstanceId,
  ): Promise<void> {
    const manifestPath = cachePaths.chainManifestPath(
      this.opts.cache_paths,
      chainId,
    );
    const manifest = await this.readManifest(chainId);
    if (!manifest) {
      this.opts.logger.warn("setLinkWorker: manifest missing", {
        chain_id: chainId,
        link,
      });
      return;
    }
    manifest.link_workers ??= {
      plan: null,
      build: null,
      verify: null,
      review: null,
      accept: null,
    };
    manifest.link_workers[link] = workerId;
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
  }

  async record(
    chainId: ChainId,
    event: ChainAuditEventInput,
  ): Promise<void> {
    const auditPath = cachePaths.chainAuditPath(
      this.opts.cache_paths,
      chainId,
    );
    await fs.promises.mkdir(path.dirname(auditPath), { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        chain_id: chainId,
        event: event.event,
        link: event.link ?? null,
        worker_id: event.worker_id ?? null,
        worker_name: event.worker_name ?? null,
        task_id: event.task_id ?? null,
        payload: event.payload ?? null,
      }) + "\n";
    await fs.promises.appendFile(auditPath, line, "utf-8");
  }

  async closeChain(
    chainId: ChainId,
    status: Exclude<ChainStatus, "running">,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const manifestPath = cachePaths.chainManifestPath(
      this.opts.cache_paths,
      chainId,
    );
    const manifest = await this.readManifest(chainId);
    if (manifest) {
      manifest.status = status;
      manifest.completed_at = new Date().toISOString();
      await fs.promises.writeFile(
        manifestPath,
        JSON.stringify(manifest, null, 2),
        "utf-8",
      );
    }
    await this.record(chainId, {
      event: "chain_closed",
      payload: { status, ...(extra ?? {}) },
    });
  }

  async readManifest(chainId: ChainId): Promise<ChainManifest | null> {
    const manifestPath = cachePaths.chainManifestPath(
      this.opts.cache_paths,
      chainId,
    );
    try {
      const raw = await fs.promises.readFile(manifestPath, "utf-8");
      return JSON.parse(raw) as ChainManifest;
    } catch {
      return null;
    }
  }
}
