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
  type UpstreamCommits,
} from "@co/contracts";

export type ChainStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "merge_failed";

/**
 * Per-link commit record persisted alongside link_tasks / link_workers.
 * `worktree` references the per-Worker branch commit in the shared
 * project repo; `docs` references the CO root commit (may be null when
 * the Worker had no docs change). `branch` is the Worker's worktree
 * branch — needed by close_chain so MergeValidator knows which branch
 * to merge into mainBranch.
 */
export interface LinkCommitRecord {
  worktree: string | null;
  docs: string | null;
  branch: string;
}

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
  link_commits?: Partial<Record<TaskLink, LinkCommitRecord>>;
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

  /**
   * Record the dual commit hashes the Worker produced for this link
   * (project worktree commit + CO root docs commit + branch name).
   * Persisted in manifest.link_commits[link] so downstream link
   * dispatches can read it back via `collectUpstreamCommits()` to
   * populate Message.upstream_commits, and close_chain can resolve
   * the accept-link branch for MergeValidator. Idempotent: calling
   * twice with the same (chainId, link) overwrites.
   */
  async recordLinkCommit(
    chainId: ChainId,
    link: TaskLink,
    commits: LinkCommitRecord,
  ): Promise<void> {
    const manifestPath = cachePaths.chainManifestPath(
      this.opts.cache_paths,
      chainId,
    );
    const manifest = await this.readManifest(chainId);
    if (!manifest) {
      this.opts.logger.warn("recordLinkCommit: manifest missing", {
        chain_id: chainId,
        link,
      });
      return;
    }
    manifest.link_commits ??= {};
    manifest.link_commits[link] = commits;
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
  }

  /**
   * Build the UpstreamCommits map to inject into the next link's
   * task_dispatch message. Returns only links with non-null worktree
   * shas — null entries are omitted so Worker code can `if (h)` cleanly.
   */
  async collectUpstreamCommits(
    chainId: ChainId,
  ): Promise<UpstreamCommits> {
    const manifest = await this.readManifest(chainId);
    const out: UpstreamCommits = {};
    if (!manifest?.link_commits) return out;
    for (const link of ["plan", "build", "verify", "review"] as const) {
      const rec = manifest.link_commits[link];
      if (rec?.worktree) out[link] = rec.worktree;
    }
    return out;
  }

  /**
   * Wipe link commit records for the rejected link and all downstream
   * links. Called when a Worker emits a `feedback` decision so the
   * retried task starts from a clean upstream slate (no stale hashes
   * pointing at superseded work).
   */
  async clearLinkCommitsFrom(
    chainId: ChainId,
    fromLink: TaskLink,
  ): Promise<void> {
    const manifestPath = cachePaths.chainManifestPath(
      this.opts.cache_paths,
      chainId,
    );
    const manifest = await this.readManifest(chainId);
    if (!manifest?.link_commits) return;
    const order: TaskLink[] = ["plan", "build", "verify", "review", "accept"];
    const idx = order.indexOf(fromLink);
    if (idx < 0) return;
    let mutated = false;
    for (let i = idx; i < order.length; i++) {
      if (manifest.link_commits[order[i]] !== undefined) {
        delete manifest.link_commits[order[i]];
        mutated = true;
      }
    }
    if (mutated) {
      await fs.promises.writeFile(
        manifestPath,
        JSON.stringify(manifest, null, 2),
        "utf-8",
      );
    }
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
