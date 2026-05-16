import * as fs from "node:fs";
import * as path from "node:path";
import { extractJson } from "@co/runtime";
import {
  ChainConflictError,
  ChainDefSchema,
  EvalDecisionSchema,
  ValidationError,
  type ChainDef,
  type ChainId,
  type EvalDecision,
  type IClaudeRunner,
  type IEventBus,
  type IInstanceRegistry,
  type ILogger,
  type IMessageRouter,
  type ITaskQueue,
  type ITemplateEngine,
  type InstanceId,
  type LeaderEvent,
  type Message,
  type MergeDecision,
  type Task,
  type TaskId,
  type TaskLink,
  asTaskId,
  cachePaths,
  asChainId,
} from "@co/contracts";
import type { CommitInfo } from "./merge-validator.js";
import type { ChainAudit } from "./chain-audit.js";
import type { MemoryBootstrap } from "./memory-bootstrap.js";

export interface IMergeValidator {
  validate(commit: CommitInfo): Promise<MergeDecision>;
}

const NEXT_LINKS: Record<TaskLink, TaskLink | null> = {
  plan: "build",
  build: "verify",
  verify: "review",
  review: "accept",
  accept: null,
};

const PREV_LINKS: Record<TaskLink, TaskLink | null> = {
  plan: null,
  build: "plan",
  verify: "build",
  review: "verify",
  accept: "review",
};

const LINK_TO_ROLE: Record<TaskLink | "decompose", string> = {
  plan: "planner",
  build: "builder",
  verify: "verifier",
  review: "reviewer",
  accept: "accepter",
  decompose: "planner",
};

export interface ChainRouterOptions {
  task_queue: ITaskQueue;
  message_router: IMessageRouter;
  registry: IInstanceRegistry;
  bus: IEventBus<LeaderEvent>;
  runner: IClaudeRunner;
  template_engine: ITemplateEngine;
  logger: ILogger;
  leader_id: InstanceId;
  leader_name: string;
  cache_paths: cachePaths.CachePathOptions;
  /**
   * Hard ceiling on the total number of feedback-driven retries a chain
   * may accumulate before ChainRouter forcibly aborts it. Passed to
   * `chain_audit.openChain` so it is persisted per-chain (survives leader
   * restarts) and exposed to `dispatchFeedbackAsRetry` via the manifest.
   * When omitted, ChainAudit uses `DEFAULT_MAX_TOTAL_RETRIES`.
   */
  max_chain_retries?: number;
  /**
   * Optional. When provided, ChainRouter calls `validate` for every
   * commit it has collected on `close_chain`, in plan→build→verify→
   * review→accept order. Omitted in tests and CLI flows that do not
   * want to touch git.
   */
  merge_validator?: IMergeValidator;
  /**
   * Optional. When provided, ChainRouter persists per-chain audit state
   * (manifest.json + audit.jsonl + requirement.md) under
   * `<co_root>/chains/<chain_id>/`. Omitted in unit tests that don't
   * need on-disk audit trails.
   */
  chain_audit?: ChainAudit;
  /**
   * Optional. When provided, ChainRouter handles incoming
   * `memory_refresh` messages by invoking
   * `MemoryBootstrap.refreshFiles(changed_files)` so the workspace
   * memory tree catches up with the Worker's commit. Omitted in unit
   * tests that don't exercise the memory refresh path.
   */
  memory_bootstrap?: MemoryBootstrap;
}

export class ChainRouter {
  /**
   * Per-chain commit log accumulated from completion_report messages.
   * Insertion order is the link order in which reports arrive — used
   * to drive MergeValidator on chain close in P→B→V→R→A sequence.
   */
  private readonly chainCommits = new Map<ChainId, CommitInfo[]>();

  constructor(private readonly opts: ChainRouterOptions) {}

  private recordCommit(
    chainId: ChainId,
    link: TaskLink,
    title: string | null,
    commit: {
      sha: string;
      message: string;
      branch?: string;
    },
  ): void {
    let log = this.chainCommits.get(chainId);
    if (!log) {
      log = [];
      this.chainCommits.set(chainId, log);
    }
    log.push({
      sha: commit.sha,
      message: commit.message,
      branch: commit.branch ?? "",
      task_title: title ?? "",
      task_link: link,
    });
  }

  /**
   * Record the link → worker mapping persistently in the chain manifest
   * (`link_workers`). Survives leader restarts, and is the sole source of
   * truth `resolveFeedbackTarget` consults when no explicit target is
   * provided by the evaluator.
   */
  private async rememberDispatch(
    chainId: ChainId,
    link: TaskLink,
    workerId: InstanceId,
  ): Promise<void> {
    if (this.opts.chain_audit) {
      await this.opts.chain_audit.setLinkWorker(chainId, link, workerId);
    }
  }

  private forgetChain(chainId: ChainId): void {
    this.chainCommits.delete(chainId);
  }

  async route(msg: Message): Promise<void> {
    if (msg.type === "memory_refresh") {
      await this.handleMemoryRefresh(msg);
      return;
    }
    if (!msg.link) {
      await this.handleRequirement(msg);
      return;
    }
    if (msg.link === "plan" && msg.type === "completion_report") {
      await this.handleCompletionReport(msg);
      return;
    }
    if (this.looksLikeChainDef(msg.content)) {
      await this.handleTaskDefinitions(msg, msg.content);
      return;
    }
    await this.handleCompletionReport(msg);
  }

  /**
   * Dispatch a user-typed slash command. Returns `true` if the command
   * was recognised (regardless of whether the underlying action succeeded)
   * so the caller can stop further requirement processing. Returns
   * `false` for unknown commands so a leading `/` in a regular prompt
   * (e.g. a path that starts with `/`) falls through to the decompose
   * flow without surprise.
   *
   * The actual work is fire-and-forget — slash commands like `/init`
   * can run for many minutes against claude-cli, and blocking the
   * message handler would freeze the Leader's incoming-message loop.
   */
  private async handleSlashCommand(text: string): Promise<boolean> {
    const [head, ...args] = text.slice(1).split(/\s+/);
    const cmd = head.toLowerCase();
    switch (cmd) {
      case "init":
        this.runInitCommand(args);
        return true;
      default:
        this.opts.logger.warn("unknown slash command", { command: cmd });
        return false;
    }
  }

  /**
   * `/init` — populate the workspace memory tree, then sweep stale
   * entries. Idempotent: when the root marker already exists `run()`
   * returns immediately and the sweep only touches entries whose
   * source_hash drifted. Detached from the message handler with `void`.
   */
  private runInitCommand(_args: string[]): void {
    if (!this.opts.memory_bootstrap) {
      this.opts.logger.warn("/init: no memory_bootstrap wired");
      return;
    }
    const bootstrap = this.opts.memory_bootstrap;
    this.opts.logger.info("/init: starting workspace memory bootstrap");
    void (async () => {
      const stats = await bootstrap.run();
      this.opts.logger.info("/init: bootstrap done", {
        files_generated: stats.files_generated,
        files_skipped: stats.files_skipped,
        files_failed: stats.files_failed,
        dirs_generated: stats.dirs_generated,
        dirs_failed: stats.dirs_failed,
      });
      const stale = await bootstrap.refreshStale();
      if (stale.stale_found > 0) {
        this.opts.logger.info("/init: stale entries refreshed", {
          stale_found: stale.stale_found,
          generated: stale.generated,
          failed: stale.failed,
          filtered_out: stale.filtered_out,
        });
      }
    })().catch((err) => {
      this.opts.logger.warn("/init: bootstrap/refresh failed", {
        error: String(err),
      });
    });
  }

  /**
   * Parse a `memory_refresh` payload and forward the changed-files list
   * to MemoryBootstrap. Payload shape:
   *
   *   {"changed_files": ["packages/worker/src/watcher.ts", ...]}
   *
   * Non-JSON or malformed payloads are logged and dropped — refresh is a
   * best-effort hint, not a critical path. When no `memory_bootstrap` is
   * wired (unit tests, ad-hoc CLI flows) the message is acknowledged via
   * the event bus and ignored.
   */
  private async handleMemoryRefresh(msg: Message): Promise<void> {
    if (!this.opts.memory_bootstrap) {
      this.opts.logger.debug("memory_refresh received but no bootstrap wired", {
        from: msg.from_name,
      });
      return;
    }
    let changed: string[] = [];
    try {
      const payload = JSON.parse(extractJson(msg.content)) as {
        changed_files?: unknown;
      };
      if (Array.isArray(payload.changed_files)) {
        changed = payload.changed_files.filter(
          (s): s is string => typeof s === "string",
        );
      }
    } catch {
      this.opts.logger.warn("memory_refresh payload not parseable", {
        from: msg.from_name,
      });
      return;
    }
    if (changed.length === 0) {
      this.opts.logger.debug("memory_refresh with empty file list", {
        from: msg.from_name,
      });
      return;
    }
    try {
      const stats = await this.opts.memory_bootstrap.refreshFiles(changed);
      this.opts.logger.info("memory refresh complete", {
        from: msg.from_name,
        ...stats,
      });
    } catch (err) {
      this.opts.logger.warn("memory refresh threw", {
        from: msg.from_name,
        error: String(err),
      });
    }
  }

  private looksLikeChainDef(content: string): boolean {
    try {
      const json = JSON.parse(extractJson(content)) as Record<string, unknown>;
      return Boolean(json && typeof json === "object" && "chain_id" in json && "tasks" in json);
    } catch {
      return false;
    }
  }

  private async handleRequirement(msg: Message): Promise<void> {
    // Capture the user's raw requirement text BEFORE decompose overwrites
    // msg.content. handleTaskDefinitions persists this verbatim to
    // chains/<chain_id>/requirement.md and propagates the path to every
    // worker dispatched in the chain.
    const originalRequirement = msg.content;
    const trimmed = originalRequirement.trim();

    // Slash commands are user-driven control inputs typed in the TUI.
    // They take priority over decompose because they target the Leader
    // itself (memory init, future diagnostics) rather than a chain that
    // needs planning. Unknown commands log a warning and fall through to
    // the normal requirement flow so a leading `/` in a regular prompt
    // is not silently lost.
    if (trimmed.startsWith("/")) {
      const handled = await this.handleSlashCommand(trimmed);
      if (handled) return;
    }

    if (this.opts.template_engine.has("worker-decompose.md")) {
      const logPath = cachePaths.messageLogPath(this.opts.cache_paths, msg.id);
      const resultPath = cachePaths.decomposeResultPath(
        this.opts.cache_paths,
        msg.id,
      );
      await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });

      const prompt = this.opts.template_engine.render("worker-decompose.md", {
        name: this.opts.leader_name,
        role: "leader",
        task_title: msg.task_title ?? "",
        task_description: msg.task_description ?? msg.content,
        task_criteria: msg.task_criteria ?? "",
        result_path: resultPath,
        work_dir: process.cwd(),
        time: new Date().toISOString(),
        content: msg.content,
      });
      await this.opts.runner.run({ prompt, log_path: logPath });
      const resultContent = await fs.promises.readFile(resultPath, "utf-8");
      const cleaned = extractJson(resultContent);
      await this.handleTaskDefinitions(
        { ...msg, content: cleaned },
        originalRequirement,
      );
      return;
    }

    const planner = await this.findIdleWorkerByRole("planner");
    if (!planner) {
      this.opts.logger.warn("no planner available — requirement dropped");
      return;
    }
    await this.opts.message_router.send({
      type: "task_dispatch",
      from_instance: this.opts.leader_id,
      from_name: this.opts.leader_name,
      from_role: "leader",
      to_instance: planner.id,
      content: msg.content,
      link: "plan",
      task_description: msg.content,
    });
  }

  private async handleTaskDefinitions(
    msg: Message,
    originalRequirement?: string,
  ): Promise<void> {
    const parsed = ChainDefSchema.safeParse(JSON.parse(extractJson(msg.content)));
    if (!parsed.success) {
      throw new ValidationError("invalid ChainDef in message", parsed.error);
    }
    const chainDef: ChainDef = parsed.data;
    const linkOrder: Array<TaskLink> = ["plan", "build", "verify", "review", "accept"];

    // Persist requirement.md and open audit before any dispatch fires —
    // downstream workers read manifest.json to resolve upstream task ids,
    // and dispatched messages carry the requirement_path verbatim.
    const requirementPath = cachePaths.chainRequirementPath(
      this.opts.cache_paths,
      chainDef.chain_id,
    );
    await fs.promises.mkdir(path.dirname(requirementPath), { recursive: true });
    await fs.promises.writeFile(
      requirementPath,
      originalRequirement ?? msg.content,
      "utf-8",
    );
    if (this.opts.chain_audit) {
      try {
        await this.opts.chain_audit.openChain(chainDef.chain_id, {
          created_at: new Date().toISOString(),
          leader_id: this.opts.leader_id,
          leader_name: this.opts.leader_name,
          requirement_path: requirementPath,
          max_total_retries: this.opts.max_chain_retries,
        });
      } catch (err) {
        if (err instanceof ChainConflictError) {
          this.opts.logger.error("chain_id conflict — refusing to reopen", {
            chain_id: chainDef.chain_id,
            existing_status: err.existing_status,
            existing_completed_at: err.existing_completed_at,
          });
          this.opts.bus.emit({
            type: "debug_info",
            message: `chain ${chainDef.chain_id} already ${err.existing_status}; new requirement dropped`,
          });
          await this.opts.chain_audit.record(chainDef.chain_id, {
            event: "chain_id_conflict",
            payload: {
              existing_status: err.existing_status,
              existing_completed_at: err.existing_completed_at,
              requirement_path: requirementPath,
            },
          });
          return;
        }
        throw err;
      }
      await this.opts.chain_audit.record(chainDef.chain_id, {
        event: "requirement_received",
        payload: { requirement_path: requirementPath },
      });
    }

    // Pre-resolve the first link's worker so we can stamp the pending
    // task with assigned_to at push time — the Leader is the sole
    // dispatcher; subsequent links are pinned later via task_queue.assign()
    // in handleCompletionReport (activate_next).
    let firstLink: TaskLink | null = null;
    for (const link of linkOrder) {
      if (chainDef.tasks[link]) {
        firstLink = link;
        break;
      }
    }
    const firstWorker = firstLink
      ? await this.findIdleWorkerByRole(LINK_TO_ROLE[firstLink])
      : null;

    let firstTaskId: string | null = null;
    let firstTitle = "";
    let firstDef: ChainDef["tasks"][TaskLink] | null = null;
    for (const link of linkOrder) {
      const def = chainDef.tasks[link];
      if (!def) continue;
      const isFirst = link === firstLink;
      const task = await this.opts.task_queue.push({
        title: def.title,
        description: def.description,
        criteria: def.criteria,
        priority: def.priority,
        link,
        chain_id: chainDef.chain_id,
        created_by: this.opts.leader_id,
        created_by_name: this.opts.leader_name,
        assigned_to: isFirst && firstWorker ? firstWorker.id : null,
        assigned_to_name: isFirst && firstWorker ? firstWorker.name : null,
      });
      if (isFirst) {
        firstTaskId = task.id;
        firstTitle = def.title;
        firstDef = def;
      }
    }

    this.opts.bus.emit({ type: "chain_activated", chain_id: chainDef.chain_id });

    if (firstLink && firstTaskId && firstDef) {
      if (firstWorker) {
        if (this.opts.chain_audit) {
          await this.opts.chain_audit.setLinkTask(
            chainDef.chain_id,
            firstLink,
            asTaskId(firstTaskId),
          );
          await this.opts.chain_audit.record(chainDef.chain_id, {
            event: "task_dispatch",
            link: firstLink,
            worker_id: firstWorker.id,
            worker_name: firstWorker.name,
            task_id: asTaskId(firstTaskId),
          });
        }
        await this.opts.message_router.send({
          type: "task_dispatch",
          from_instance: this.opts.leader_id,
          from_name: this.opts.leader_name,
          from_role: "leader",
          to_instance: firstWorker.id,
          content: firstTitle,
          link: firstLink,
          chain_id: chainDef.chain_id,
          task_id: firstTaskId as never,
          task_title: firstTitle,
          task_description: firstDef.description,
          task_criteria: firstDef.criteria,
          original_requirement_path: requirementPath,
        });
        await this.rememberDispatch(chainDef.chain_id, firstLink, firstWorker.id);
      } else {
        this.opts.logger.warn(`no ${LINK_TO_ROLE[firstLink]} available — task queued`);
      }
    }
  }

  private async handleCompletionReport(msg: Message): Promise<void> {
    const raw = JSON.parse(extractJson(msg.content)) as Record<string, unknown>;
    const parsed = EvalDecisionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("invalid EvalDecision", parsed.error);
    }
    const decision: EvalDecision = parsed.data;

    // Capture the optional `commit` envelope the Worker may attach
    // alongside the EvalDecision (see worker/watcher.ts sendCompletionReport).
    // Recorded per (chain_id, link) for MergeValidator to consume on
    // chain_closed.
    if (msg.chain_id && msg.link && raw.commit && typeof raw.commit === "object") {
      const c = raw.commit as Record<string, unknown>;
      if (typeof c.sha === "string" && typeof c.message === "string") {
        this.recordCommit(msg.chain_id, msg.link, msg.task_title ?? null, {
          sha: c.sha,
          message: c.message,
          branch: typeof c.branch === "string" ? c.branch : undefined,
        });
      }
    }

    if (this.opts.chain_audit && msg.chain_id) {
      await this.opts.chain_audit.record(msg.chain_id, {
        event: "completion_report",
        link: msg.link ?? null,
        worker_id: msg.from_instance,
        worker_name: msg.from_name,
        task_id: (msg.task_id as TaskId | null) ?? null,
        payload: { decision: decision.decision },
      });
    }

    const requirementPath = await this.resolveRequirementPath(msg.chain_id ?? null);

    switch (decision.decision) {
      case "activate_next": {
        if (!msg.chain_id) break;
        const nextLink = decision.next_link;
        const nextTask = await this.findOrCreatePendingTask(
          msg.chain_id,
          nextLink,
        );
        const worker = await this.findIdleWorkerByRole(LINK_TO_ROLE[nextLink]);
        if (worker) {
          // Pin the pending task to this worker before sending the
          // dispatch — the Worker's watcher validates assigned_to == self
          // before claiming, so without this assign() the dispatched
          // worker would refuse the task.
          await this.opts.task_queue.assign(nextTask.id, worker.id, worker.name);
          if (this.opts.chain_audit) {
            await this.opts.chain_audit.setLinkTask(
              msg.chain_id,
              nextLink,
              nextTask.id,
            );
            await this.opts.chain_audit.record(msg.chain_id, {
              event: "task_dispatch",
              link: nextLink,
              worker_id: worker.id,
              worker_name: worker.name,
              task_id: nextTask.id,
            });
          }
          await this.opts.message_router.send({
            type: "task_dispatch",
            from_instance: this.opts.leader_id,
            from_name: this.opts.leader_name,
            from_role: "leader",
            to_instance: worker.id,
            content: nextTask.title,
            link: nextLink,
            chain_id: msg.chain_id,
            task_id: nextTask.id,
            task_title: nextTask.title,
            task_description: nextTask.description,
            task_criteria: nextTask.criteria,
            original_requirement_path: requirementPath,
          });
          await this.rememberDispatch(msg.chain_id, nextLink, worker.id);
        }
        break;
      }
      case "feedback": {
        const targetId = await this.resolveFeedbackTarget(
          msg,
          decision.feedback_target ?? null,
        );
        if (!targetId) {
          // Neither an explicit target nor a manifest-recorded prev-link
          // worker is available. Self-routing to msg.from_instance was the
          // previous fallback; it created death loops where a worker kept
          // receiving its own feedback. Drop the dispatch and leave an
          // audit trail so the operator can investigate.
          this.opts.logger.error(
            "feedback target unresolved — dropping retry dispatch",
            {
              chain_id: msg.chain_id ?? null,
              link: msg.link ?? null,
              from_instance: msg.from_instance,
              explicit_target: decision.feedback_target ?? null,
            },
          );
          this.opts.bus.emit({
            type: "debug_info",
            message: `feedback for chain ${msg.chain_id ?? "(none)"}/${msg.link ?? "(none)"} dropped: no resolvable target`,
          });
          if (this.opts.chain_audit && msg.chain_id) {
            await this.opts.chain_audit.record(msg.chain_id, {
              event: "feedback_unresolved",
              link: msg.link ?? null,
              worker_id: msg.from_instance,
              worker_name: msg.from_name,
              task_id: (msg.task_id as TaskId | null) ?? null,
              payload: {
                feedback_to_worker: decision.feedback_to_worker,
                explicit_target: decision.feedback_target ?? null,
              },
            });
          }
          break;
        }
        await this.dispatchFeedbackAsRetry({
          msg,
          targetId,
          feedback: decision.feedback_to_worker,
          requirementPath,
        });
        break;
      }
      case "close_chain": {
        if (msg.chain_id) {
          const failures = await this.runMergeValidation(msg.chain_id);
          if (failures.length > 0) {
            // At least one commit could not be merged to main. Do NOT
            // mark the chain "completed" — that would silently leave
            // the deliverable half-merged. Record the failures, abort
            // chain status as "merge_failed", and push a retry task to
            // each link's worker so they can fix the conflict.
            this.opts.logger.error("close_chain blocked: merge failures", {
              chain_id: msg.chain_id,
              count: failures.length,
            });
            if (this.opts.chain_audit) {
              for (const f of failures) {
                await this.opts.chain_audit.record(msg.chain_id, {
                  event: "merge_failure",
                  link: f.link,
                  task_id: null,
                  payload: {
                    sha: f.sha,
                    branch: f.branch,
                    message: f.message,
                    error: f.error,
                  },
                });
              }
              await this.opts.chain_audit.closeChain(
                msg.chain_id,
                "merge_failed",
                { failures: failures as unknown as Record<string, unknown> },
              );
            }
            this.opts.bus.emit({
              type: "chain_merge_failed",
              chain_id: msg.chain_id,
              failures,
            });
            await this.pushMergeConflictRetries(msg, failures, requirementPath);
            this.emitChainClosed(msg.chain_id);
            this.forgetChain(msg.chain_id);
            break;
          }
          if (this.opts.chain_audit) {
            await this.opts.chain_audit.closeChain(msg.chain_id, "completed");
          }
          this.emitChainClosed(msg.chain_id);
          this.forgetChain(msg.chain_id);
        }
        break;
      }
      case "reject": {
        if (msg.chain_id) {
          if (this.opts.chain_audit) {
            await this.opts.chain_audit.closeChain(msg.chain_id, "aborted", {
              reason: "evaluator_reject",
            });
          }
          this.emitChainClosed(msg.chain_id);
          this.forgetChain(msg.chain_id);
        }
        break;
      }
    }
  }

  private async resolveRequirementPath(
    chainId: ChainId | null,
  ): Promise<string | null> {
    if (!chainId || !this.opts.chain_audit) return null;
    const manifest = await this.opts.chain_audit.readManifest(chainId);
    return manifest?.requirement_path ?? null;
  }

  /**
   * Walk the per-chain commit log in P→B→V→R→A order, asking the
   * MergeValidator for a merge / skip / review_first decision per
   * commit. Continues past a single-commit failure so other commits
   * still get evaluated, but collects each failure and returns the
   * list to the caller. Returns an empty array when no validator is
   * configured (validation is opt-in) or when no commits were recorded.
   * The caller (close_chain branch) uses a non-empty return value to
   * route the chain to "merge_failed" status instead of "completed".
   */
  private async runMergeValidation(
    chainId: ChainId,
  ): Promise<
    Array<{
      link: TaskLink;
      sha: string;
      branch: string;
      message: string;
      error: string;
    }>
  > {
    const failures: Array<{
      link: TaskLink;
      sha: string;
      branch: string;
      message: string;
      error: string;
    }> = [];
    if (!this.opts.merge_validator) return failures;
    const commits = this.chainCommits.get(chainId);
    if (!commits || commits.length === 0) return failures;
    for (const commit of commits) {
      try {
        await this.opts.merge_validator.validate(commit);
      } catch (err) {
        this.opts.logger.warn("merge validation failed", {
          chain_id: chainId,
          branch: commit.branch,
          sha: commit.sha,
          error: String(err),
        });
        failures.push({
          link: commit.task_link as TaskLink,
          sha: commit.sha,
          branch: commit.branch,
          message: commit.message,
          error: String(err),
        });
      }
    }
    return failures;
  }

  /**
   * Create one retry task per failed merge, addressed to the worker
   * that owned that link in the chain manifest (link_workers). Each
   * retry carries a description naming the failed sha / branch /
   * conflict so the worker can rebase, fix conflicts, and re-commit.
   * Skips silently when chain_audit is not configured (manifest
   * lookups would have no source).
   */
  private async pushMergeConflictRetries(
    msg: Message,
    failures: ReadonlyArray<{
      link: TaskLink;
      sha: string;
      branch: string;
      message: string;
      error: string;
    }>,
    requirementPath: string | null,
  ): Promise<void> {
    if (!msg.chain_id || !this.opts.chain_audit) return;
    const manifest = await this.opts.chain_audit.readManifest(msg.chain_id);
    if (!manifest) return;
    for (const f of failures) {
      const targetId = manifest.link_workers?.[f.link];
      if (!targetId) {
        this.opts.logger.warn(
          "merge retry skipped: no worker recorded for link",
          { chain_id: msg.chain_id, link: f.link },
        );
        continue;
      }
      const target = await this.opts.registry.get(targetId);
      const targetName = target?.name ?? "";
      const description =
        `Merge conflict on branch ${f.branch} at ${f.sha.slice(0, 8)}: ${f.message}.\n` +
        `Error: ${f.error}.\n` +
        `Pull main, resolve conflicts in your worktree, re-commit, and re-run this link.`;
      const newTask = await this.opts.task_queue.push({
        title: `[${msg.chain_id}] ${f.link} merge-conflict-fix`,
        description,
        criteria: "",
        priority: 0,
        link: f.link,
        chain_id: msg.chain_id,
        retry_count: 0,
        created_by: this.opts.leader_id,
        created_by_name: this.opts.leader_name,
        assigned_to: targetId,
        assigned_to_name: targetName,
      });
      await this.opts.chain_audit.setLinkTask(
        msg.chain_id,
        f.link,
        newTask.id,
      );
      await this.opts.chain_audit.record(msg.chain_id, {
        event: "feedback_sent",
        link: f.link,
        worker_id: targetId,
        worker_name: targetName,
        task_id: newTask.id,
        payload: {
          reason: "merge_conflict",
          sha: f.sha,
          branch: f.branch,
        },
      });
      await this.opts.message_router.send({
        type: "task_dispatch",
        from_instance: this.opts.leader_id,
        from_name: this.opts.leader_name,
        from_role: "leader",
        to_instance: targetId,
        content: newTask.title,
        link: f.link,
        chain_id: msg.chain_id,
        task_id: newTask.id,
        task_title: newTask.title,
        task_description: description,
        task_criteria: "",
        original_requirement_path: requirementPath,
      });
    }
  }

  /**
   * Decide who receives a feedback message.
   *
   * Priority:
   *   1. Explicit `feedback_target` from the EvalDecision (Worker-asserted).
   *   2. The worker that handled the previous link in this chain (e.g.
   *      Verifier feedback → Builder), looked up via the persisted chain
   *      manifest (`link_workers`). Survives leader restarts.
   *
   * Returns null when neither source is available. The caller MUST treat
   * null as "drop the dispatch + audit" rather than fall back to the
   * report sender — self-routing creates death loops and silently loses
   * the operator's chance to intervene.
   */
  private async resolveFeedbackTarget(
    msg: Message,
    explicit: InstanceId | null,
  ): Promise<InstanceId | null> {
    if (explicit) return explicit;
    if (msg.chain_id && msg.link && this.opts.chain_audit) {
      const prevLink = PREV_LINKS[msg.link];
      if (prevLink) {
        const manifest = await this.opts.chain_audit.readManifest(msg.chain_id);
        const prev = manifest?.link_workers?.[prevLink];
        if (prev) return prev;
      }
    }
    return null;
  }

  /**
   * Materialize a feedback decision as a brand-new pending task for the
   * target link, with `retry_count` incremented relative to the most
   * recent completed/pending task of (chain_id, link). The previously
   * completed task and its on-disk artifacts (`tasks/<old_id>/...`)
   * remain untouched for forensics. The new task is dispatched as a
   * regular `task_dispatch` — the receiving Worker's claimById path
   * runs the standard claim → run → evaluate cycle, with `retry_hint`
   * carrying the feedback text in `task_description`.
   */
  private async dispatchFeedbackAsRetry(args: {
    msg: Message;
    targetId: InstanceId;
    feedback: string;
    requirementPath: string | null;
  }): Promise<void> {
    const { msg, targetId, feedback, requirementPath } = args;
    if (!msg.chain_id || !msg.link) {
      this.opts.logger.warn("feedback decision lacks chain_id/link", {
        chain_id: msg.chain_id ?? null,
        link: msg.link ?? null,
      });
      return;
    }
    // Enforce the per-chain feedback-retry ceiling before pushing a new
    // task. The ceiling lives in the chain manifest (see ChainAudit
    // openChain), survives leader restarts, and protects against runaway
    // feedback loops (A→B→A→B…). incrementRetry returns null only when
    // the manifest itself is missing, in which case we proceed without
    // ceiling enforcement — the fallback degrades to the pre-A5 behavior
    // rather than blocking ad-hoc flows.
    if (this.opts.chain_audit) {
      const counters = await this.opts.chain_audit.incrementRetry(msg.chain_id);
      if (counters && counters.total_retry_count > counters.max_total_retries) {
        this.opts.logger.error("chain retry ceiling exceeded — aborting chain", {
          chain_id: msg.chain_id,
          total_retry_count: counters.total_retry_count,
          max_total_retries: counters.max_total_retries,
        });
        await this.opts.chain_audit.record(msg.chain_id, {
          event: "retry_ceiling_exceeded",
          link: msg.link,
          worker_id: msg.from_instance,
          worker_name: msg.from_name,
          task_id: (msg.task_id as TaskId | null) ?? null,
          payload: {
            total_retry_count: counters.total_retry_count,
            max_total_retries: counters.max_total_retries,
            feedback_to_worker: feedback,
          },
        });
        await this.opts.chain_audit.closeChain(msg.chain_id, "aborted", {
          reason: "retry_ceiling_exceeded",
          total_retry_count: counters.total_retry_count,
          max_total_retries: counters.max_total_retries,
        });
        this.opts.bus.emit({
          type: "debug_info",
          message: `chain ${msg.chain_id} aborted: retry ceiling ${counters.max_total_retries} exceeded`,
        });
        this.emitChainClosed(msg.chain_id);
        this.forgetChain(msg.chain_id);
        return;
      }
    }
    const prevLink = PREV_LINKS[msg.link] ?? msg.link;
    const priorRetry = await this.lookupPriorRetry(
      msg.chain_id,
      prevLink,
      msg.task_id ?? null,
    );
    const target = await this.opts.registry.get(targetId);
    const targetName = target?.name ?? "";
    const newTask = await this.opts.task_queue.push({
      title: `[${msg.chain_id}] ${prevLink} (retry ${priorRetry + 1})`,
      description: feedback,
      criteria: "",
      priority: 1,
      link: prevLink,
      chain_id: msg.chain_id,
      retry_count: priorRetry + 1,
      created_by: this.opts.leader_id,
      created_by_name: this.opts.leader_name,
      assigned_to: targetId,
      assigned_to_name: targetName,
    });
    if (this.opts.chain_audit) {
      await this.opts.chain_audit.setLinkTask(msg.chain_id, prevLink, newTask.id);
      await this.opts.chain_audit.setLinkWorker(msg.chain_id, prevLink, targetId);
      await this.opts.chain_audit.record(msg.chain_id, {
        event: "feedback_sent",
        link: msg.link,
        worker_id: targetId,
        worker_name: targetName,
        task_id: newTask.id,
        payload: {
          feedback_to_worker: feedback,
          retry_count: priorRetry + 1,
          target_link: prevLink,
        },
      });
    }
    await this.opts.message_router.send({
      type: "task_dispatch",
      from_instance: this.opts.leader_id,
      from_name: this.opts.leader_name,
      from_role: "leader",
      to_instance: targetId,
      content: newTask.title,
      link: prevLink,
      chain_id: msg.chain_id,
      task_id: newTask.id,
      task_title: newTask.title,
      task_description: feedback,
      task_criteria: "",
      original_requirement_path: requirementPath,
    });
  }

  /**
   * Best-effort retry-count lookup for the link we're about to retry.
   *
   * Tries, in order:
   *   1. The completed task whose id the reporter cited (most accurate
   *      when feedback bounces back to the same link the reporter ran).
   *   2. The link's currently recorded task in the manifest's
   *      `link_tasks` map — works for feedback that crosses links
   *      (e.g. verifier → builder) and survives leader restarts.
   *   3. Any pending task for (chain_id, link) still in the queue.
   * Falls back to 0 if no prior record exists.
   */
  private async lookupPriorRetry(
    chainId: ChainId,
    link: TaskLink,
    msgTaskId: TaskId | null,
  ): Promise<number> {
    if (msgTaskId) {
      const completed = await this.opts.task_queue.getCompleted(msgTaskId);
      if (completed && completed.link === link) {
        return completed.retry_count ?? 0;
      }
    }
    if (this.opts.chain_audit) {
      const manifest = await this.opts.chain_audit.readManifest(chainId);
      const priorId = manifest?.link_tasks?.[link] ?? null;
      if (priorId) {
        const prior = await this.opts.task_queue.getCompleted(priorId);
        if (prior) return prior.retry_count ?? 0;
      }
    }
    const pending = await this.opts.task_queue.listPending();
    let max = 0;
    for (const t of pending) {
      if (t.chain_id === chainId && t.link === link) {
        max = Math.max(max, t.retry_count ?? 0);
      }
    }
    return max;
  }

  private emitChainClosed(chainId: ChainId): void {
    this.opts.bus.emit({ type: "chain_closed", chain_id: asChainId(chainId) });
  }

  /**
   * Find the pending task already created for (chain_id, link) by
   * handleTaskDefinitions. Falls back to pushing a fresh task when the
   * chain's initial set was never populated (e.g. ad-hoc / decompose-skipped
   * activations or recovery after the original pending task was deleted).
   */
  private async findOrCreatePendingTask(
    chainId: ChainId,
    link: TaskLink,
  ): Promise<Task> {
    const pending = await this.opts.task_queue.listPending();
    const existing = pending.find(
      (t) => t.chain_id === chainId && t.link === link,
    );
    if (existing) return existing;
    return this.opts.task_queue.push({
      title: `[${chainId}] ${link}`,
      link,
      chain_id: chainId,
      priority: 1,
      created_by: this.opts.leader_id,
      created_by_name: this.opts.leader_name,
    });
  }

  private async findIdleWorkerByRole(
    role: string,
  ): Promise<{ id: InstanceId; name: string } | null> {
    const instances = await this.opts.registry.list();
    for (const inst of instances) {
      if (inst.role === role && inst.status === "idle") {
        return { id: inst.id, name: inst.name };
      }
    }
    return null;
  }
}
