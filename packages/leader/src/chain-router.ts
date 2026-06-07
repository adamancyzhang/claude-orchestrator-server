import * as fs from "node:fs";
import * as path from "node:path";
import { extractJson, renderDecomposePrompt } from "@co/runtime";
import {
  ChainConflictError,
  ChainDefSchema,
  EvalDecisionSchema,
  GitNetworkError,
  GitPermissionError,
  MergeConflictError,
  ValidationError,
  WorktreeLockedError,
  type ChainDef,
  type ChainId,
  type LegacyChainDef,
  type QualityGate,
  type CompletionCommits,
  type EvalDecision,
  type IClaudeRunner,
  type IEventBus,
  type IHookEngine,
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
  type UpstreamCommits,
  asTaskId,
  cachePaths,
  asChainId,
  TemplateNotFoundError,
} from "@co/contracts";
import type { CommitInfo } from "./merge-validator.js";
import type { ChainAudit, LinkCommitRecord } from "./chain-audit.js";
import type { MemoryBootstrap } from "./memory-bootstrap.js";

export interface IMergeValidator {
  validate(
    commit: CommitInfo,
    chain_id: ChainId | null,
    mode?: "close" | "spawn",
  ): Promise<MergeDecision>;
}

export type MergeFailureCategory =
  | "conflict"
  | "worktree_locked"
  | "permission"
  | "network"
  | "other";

export interface MergeFailure {
  link: TaskLink;
  sha: string;
  branch: string;
  message: string;
  error: string;
  category: MergeFailureCategory;
}

// accept→explore is enabled only when magic_mode=true on the
// chain manifest. ChainRouter.handleCompletionReport explicitly checks
// magic_mode for the accept-link `activate_next` branch.
const NEXT_LINKS: Record<TaskLink, TaskLink | null> = {
  plan: "execute",
  execute: "verify",
  verify: "review",
  review: "accept",
  accept: "explore",
  explore: null,
};

const PREV_LINKS: Record<TaskLink, TaskLink | null> = {
  plan: null,
  execute: "plan",
  verify: "execute",
  review: "verify",
  accept: "review",
  explore: "accept",
};

const LINK_TO_ROLE: Record<TaskLink | "decompose", string> = {
  plan: "planner",
  execute: "executor",
  verify: "verifier",
  review: "reviewer",
  accept: "accepter",
  explore: "explorer",
  decompose: "planner",
};

/**
 * link × decision legality matrix (DD 02 §5.2).
 * `spawn_chain` is legal only at explore with magic_mode=true.
 * `activate_next` on accept is legal only with magic_mode=true (else
 * close_chain is expected at accept).
 * `feedback` on plan is illegal (no PREV) and silently dropped by
 * `resolveFeedbackTarget` returning null.
 */
export function isDecisionLegalForLink(
  decisionKind: EvalDecision["decision"],
  link: TaskLink,
  magicMode: boolean,
): boolean {
  if (decisionKind === "spawn_chain") {
    return link === "explore" && magicMode;
  }
  if (decisionKind === "activate_next") {
    if (link === "explore") return false; // explore has no NEXT_LINKS
    if (link === "accept") return magicMode;
    return true;
  }
  // feedback / reject / close_chain are accepted at every link (the
  // existing handlers further constrain them — e.g. feedback on plan
  // becomes feedback_unresolved).
  return true;
}

/**
 * True when `content` parses as JSON and structurally looks like a
 * `ChainDef` payload (carries `chain_id` and either `tasks` or `task_list`).
 * Parse failures and non-object payloads return false — this is a "looks like"
 * predicate, not a validator. ChainRouter uses it as a cheap gate before
 * the full ChainDefSchema.parse downstream.
 */
export function looksLikeChainDef(content: string): boolean {
  try {
    const json = JSON.parse(extractJson(content)) as Record<string, unknown>;
    return Boolean(
      json &&
        typeof json === "object" &&
        "chain_id" in json &&
        ("tasks" in json || "task_list" in json),
    );
  } catch {
    return false;
  }
}

/**
 * Best-effort human-readable string for a merge error. Lock / permission /
 * network classes preserve their stderr; conflict carries conflict files;
 * everything else falls back to `String(err)`. Mirror partner of
 * `categorizeMergeError`.
 */
export function formatMergeError(err: unknown): string {
  if (err instanceof MergeConflictError) {
    return `conflict: ${err.conflict_files.join(", ") || err.message}`;
  }
  if (err instanceof WorktreeLockedError) {
    return `worktree_locked: ${err.stderr || err.message}`;
  }
  if (err instanceof GitPermissionError) {
    return `permission: ${err.stderr || err.message}`;
  }
  if (err instanceof GitNetworkError) {
    return `network: ${err.stderr || err.message}`;
  }
  return String(err);
}

export function categorizeMergeError(err: unknown): MergeFailureCategory {
  if (err instanceof MergeConflictError) return "conflict";
  if (err instanceof WorktreeLockedError) return "worktree_locked";
  if (err instanceof GitPermissionError) return "permission";
  if (err instanceof GitNetworkError) return "network";
  return "other";
}

export interface ChainRouterOptions {
  task_queue: ITaskQueue;
  message_router: IMessageRouter;
  registry: IInstanceRegistry;
  bus: IEventBus<LeaderEvent>;
  runner: IClaudeRunner;
  template_engine: ITemplateEngine;
  /**
   * Optional lifecycle-hook engine. When provided, ChainRouter fires
   * `leader_message_start` / `leader_message_end` around the decompose
   * claude-cli run and `chain_activated` once a new ChainDef opens.
   */
  hooks?: IHookEngine;
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
  /**
   * when true, ChainRouter enables the magic loop:
   *   - decompose template is rendered with magic_mode=true
   *   - new ChainDefs MUST include an `explore` task
   *   - accept-link `activate_next` is legal (→ explore)
   *   - spawn_chain decisions at explore are honored
   * Sourced from `--magic` CLI flag (orchestrator/run.ts).
   */
  magic_mode?: boolean;
  /**
   * hard cap on chain_forest depth. When set, spawn_chain
   * decisions whose `chain_depth + 1 >= magic_max_chains` are demoted
   * to close_chain (with audit `magic_depth_exhausted`). null /
   * undefined disables the cap. Sourced from `--magic-max-chains M`
   * CLI flag (orchestrator/run.ts) or env `CO_MAGIC_MAX_CHAINS`.
   */
  magic_max_chains?: number | null;
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

  private async collectUpstreamCommits(
    chainId: ChainId,
  ): Promise<UpstreamCommits> {
    if (!this.opts.chain_audit) return {};
    // Tolerate older chain-audit shapes / test mocks that predate the
    // collectUpstreamCommits API.
    if (typeof this.opts.chain_audit.collectUpstreamCommits !== "function") {
      return {};
    }
    try {
      return await this.opts.chain_audit.collectUpstreamCommits(chainId);
    } catch (err) {
      this.opts.logger.warn("collectUpstreamCommits failed", {
        chain_id: chainId,
        error: String(err),
      });
      return {};
    }
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
    if (looksLikeChainDef(msg.content)) {
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

    if (!this.opts.template_engine.has("workflow/decompose.md")) {
      throw new TemplateNotFoundError("workflow/decompose.md");
    }

    const logPath = cachePaths.messageLogPath(this.opts.cache_paths, msg.id);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const resultPath = cachePaths.decomposeResultPath(
      this.opts.cache_paths,
      msg.id,
      today,
    );
    await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });

    const prompt = renderDecomposePrompt(this.opts.template_engine, {
      name: this.opts.leader_name,
      role: "leader",
      task_title: msg.task_title ?? "",
      task_description: msg.task_description ?? msg.content,
      task_criteria: msg.task_criteria ?? "",
      result_path: resultPath,
      work_dir: process.cwd(),
      time: new Date().toISOString(),
      content: msg.content,
      co_root: cachePaths.coRootDir(this.opts.cache_paths),
      magic_mode: this.opts.magic_mode ? "true" : "false",
      magic_max_chains:
        this.opts.magic_max_chains == null
          ? "unlimited"
          : String(this.opts.magic_max_chains),
    });
    if (this.opts.hooks) {
      await this.opts.hooks.fire({
        type: "leader_message_start",
        env: {
          CO_LEADER_ID: this.opts.leader_id,
          CO_MESSAGE_ID: msg.id as never,
          CO_LINK: "",
          CO_LOG_PATH: logPath,
        },
      });
    }
    const runResult = await this.opts.runner.run({
      prompt,
      log_path: logPath,
      on_chunk: (chunk) => {
        this.opts.bus.emit({
          type: "stream_chunk",
          instance_id: this.opts.leader_id,
          chunk: chunk.text ?? chunk.raw,
        });
      },
    });
    if (this.opts.hooks) {
      await this.opts.hooks.fire({
        type: "leader_message_end",
        env: {
          CO_LEADER_ID: this.opts.leader_id,
          CO_MESSAGE_ID: msg.id as never,
          CO_LINK: "",
          CO_LOG_PATH: logPath,
          exit_code: runResult.exit_code,
        },
      });
    }

    // Try to read from resultPath first (if Claude wrote to file),
    // otherwise fall back to reading from logPath (inbound.log)
    let resultContent: string;
    try {
      resultContent = await fs.promises.readFile(resultPath, "utf-8");
    } catch {
      // resultPath doesn't exist, read from logPath instead
      resultContent = await fs.promises.readFile(logPath, "utf-8");
    }

    const cleaned = extractJson(resultContent);
    await this.handleTaskDefinitions(
      { ...msg, content: cleaned },
      originalRequirement,
    );
  }

  private async handleTaskDefinitions(
    msg: Message,
    originalRequirement?: string,
  ): Promise<void> {
    let jsonData: unknown;
    try {
      const extracted = extractJson(msg.content);
      jsonData = JSON.parse(extracted);
    } catch (err) {
      const preview = msg.content.slice(0, 200);
      throw new ValidationError(
        `Failed to parse JSON from decompose output. The model may have returned markdown instead of JSON. ` +
        `Response preview: "${preview}..."`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    // Normalize the response to handle model non-compliance:
    // 1. If response has `task_list` → use as-is (correct format)
    // 2. If response has `tasks` as array → convert to `task_list` (model non-compliance)
    // 3. If response has `tasks` as object → legacy format, convert accordingly
    const normalized = this.normalizeChainDef(jsonData);

    const parsed = ChainDefSchema.safeParse(normalized);
    if (!parsed.success) {
      throw new ValidationError("invalid ChainDef in message", parsed.error);
    }
    const chainDef: ChainDef = parsed.data;
    const linkOrder: Array<TaskLink> = [
      "plan",
      "execute",
      "verify",
      "review",
      "accept",
      "explore",
    ];

    const magicMode = this.opts.magic_mode === true;

    // Detect format: new (task_list array) or legacy (tasks object).
    const isNewFormat = "task_list" in chainDef && Array.isArray(chainDef.task_list);

    if (isNewFormat) {
      // New format: validate and dispatch task_list.
      const taskList = chainDef.task_list;
      await this.handleNewFormatTasks(chainDef, taskList, msg, originalRequirement);
    } else {
      // Legacy format: validate magic_mode / explore presence, then dispatch.
      const legacyDef = chainDef as LegacyChainDef;
      const hasExplore = legacyDef.tasks.explore != null;
      if (magicMode && !hasExplore) {
        this.opts.logger.error(
          "ChainDef missing `explore` task under --magic; requirement dropped",
          { chain_id: chainDef.chain_id },
        );
        this.opts.bus.emit({
          type: "debug_info",
          message: `chain ${chainDef.chain_id}: ChainDef missing explore task under --magic — dropped`,
        });
        if (this.opts.chain_audit) {
          await this.opts.chain_audit.record(chainDef.chain_id, {
            event: "validation_failure",
            payload: { reason: "magic_mode_requires_explore_task" },
          });
        }
        return;
      }
      if (!magicMode && hasExplore) {
        this.opts.logger.error(
          "ChainDef carries `explore` task without --magic; requirement dropped",
          { chain_id: chainDef.chain_id },
        );
        this.opts.bus.emit({
          type: "debug_info",
          message: `chain ${chainDef.chain_id}: ChainDef has explore task without --magic — dropped`,
        });
        if (this.opts.chain_audit) {
          await this.opts.chain_audit.record(chainDef.chain_id, {
            event: "validation_failure",
            payload: { reason: "explore_task_without_magic_mode" },
          });
        }
        return;
      }
      await this.handleLegacyFormatTasks(legacyDef, linkOrder, msg, originalRequirement);
    }
  }

  // ── New format handler ──────────────────────────────────────────────

  private async handleNewFormatTasks(
    chainDef: Extract<ChainDef, { task_list: unknown[] }>,
    taskList: Array<{
      task_id: string;
      title: string;
      description?: string;
      system_prompt: string;
      depends_on?: string[];
      priority?: number;
      criteria?: string;
      quality_gate?: QualityGate | null;
    }>,
    msg: Message,
    originalRequirement?: string,
  ): Promise<void> {
    // Persist requirement.md and open audit.
    const requirementPath = await this.openChainAudit(
      chainDef.chain_id,
      msg,
      originalRequirement,
    );
    if (requirementPath === null) return; // Chain conflict — abort.

    // Push all tasks to the queue, tracking the first for immediate dispatch.
    let firstTaskId: TaskId | null = null;
    let firstTask = taskList[0];

    for (let i = 0; i < taskList.length; i++) {
      const t = taskList[i];
      const task = await this.opts.task_queue.push({
        title: t.title,
        description: t.description ?? "",
        criteria: t.criteria ?? "",
        priority: t.priority ?? 1,
        link: null, // New format uses task_id for identification, not TaskLink
        chain_id: chainDef.chain_id,
        created_by: this.opts.leader_id,
        created_by_name: this.opts.leader_name,
      });
      if (i === 0) {
        firstTaskId = task.id;
      }
    }

    this.opts.bus.emit({ type: "chain_activated", chain_id: chainDef.chain_id });
    if (this.opts.hooks) {
      void this.opts.hooks.fire({
        type: "chain_activated",
        env: { CO_CHAIN_ID: chainDef.chain_id },
      });
    }

    // Dispatch the first task to an available worker.
    // New format tasks don't have a specific role requirement,
    // so we look for any available idle worker.
    if (firstTask && firstTaskId) {
      const worker = await this.findIdleWorker();
      if (worker) {
        if (this.opts.chain_audit) {
          await this.opts.chain_audit.setLinkTask(
            chainDef.chain_id,
            "execute" as TaskLink, // New format uses task_id, but chain_audit expects TaskLink
            firstTaskId,
          );
          await this.opts.chain_audit.record(chainDef.chain_id, {
            event: "task_dispatch",
            link: "execute" as TaskLink,
            worker_id: worker.id,
            worker_name: worker.name,
            task_id: firstTaskId,
          });
        }
        const initialUpstream = await this.collectUpstreamCommits(
          chainDef.chain_id,
        );
        await this.opts.message_router.send({
          type: "task_dispatch",
          from_instance: this.opts.leader_id,
          from_name: this.opts.leader_name,
          from_role: "leader",
          to_instance: worker.id,
          content: firstTask.title,
          link: null,
          chain_id: chainDef.chain_id,
          task_id: firstTaskId,
          task_title: firstTask.title,
          task_description: firstTask.description ?? "",
          task_criteria: firstTask.criteria ?? "",
          system_prompt: firstTask.system_prompt,
          quality_gate: firstTask.quality_gate ?? null,
          original_requirement_path: requirementPath,
          upstream_commits: initialUpstream,
        });
        await this.rememberDispatch(
          chainDef.chain_id,
          "execute" as TaskLink,
          worker.id,
        );
      } else {
        this.opts.logger.warn("no executor available — new format task queued");
      }
    }
  }

  // ── Legacy format handler ───────────────────────────────────────────

  private async handleLegacyFormatTasks(
    chainDef: Extract<ChainDef, { tasks: Record<string, unknown> }>,
    linkOrder: Array<TaskLink>,
    msg: Message,
    originalRequirement?: string,
  ): Promise<void> {
    // Persist requirement.md and open audit.
    const requirementPath = await this.openChainAudit(
      chainDef.chain_id,
      msg,
      originalRequirement,
    );
    if (requirementPath === null) return; // Chain conflict — abort.

    // Find the first non-null link and push all tasks to the queue.
    let firstLink: TaskLink | null = null;
    let firstTaskId: string | null = null;
    let firstTitle = "";
    let firstDef: { title: string; description: string; criteria: string; priority: number } | null = null;

    for (const link of linkOrder) {
      if (chainDef.tasks[link]) {
        firstLink = link;
        break;
      }
    }
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
      });
      if (isFirst) {
        firstTaskId = task.id;
        firstTitle = def.title;
        firstDef = def;
      }
    }

    this.opts.bus.emit({ type: "chain_activated", chain_id: chainDef.chain_id });
    if (this.opts.hooks) {
      void this.opts.hooks.fire({
        type: "chain_activated",
        env: { CO_CHAIN_ID: chainDef.chain_id },
      });
    }

    if (firstLink && firstDef) {
      const worker = firstLink
        ? await this.findIdleWorkerByRole(LINK_TO_ROLE[firstLink] ?? "executor")
        : null;

      if (worker) {
        if (this.opts.chain_audit) {
          await this.opts.chain_audit.setLinkTask(
            chainDef.chain_id,
            firstLink,
            asTaskId(firstTaskId ?? ""),
          );
          await this.opts.chain_audit.record(chainDef.chain_id, {
            event: "task_dispatch",
            link: firstLink,
            worker_id: worker.id,
            worker_name: worker.name,
            task_id: asTaskId(firstTaskId ?? ""),
          });
        }
        const initialUpstream = await this.collectUpstreamCommits(
          chainDef.chain_id,
        );
        await this.opts.message_router.send({
          type: "task_dispatch",
          from_instance: this.opts.leader_id,
          from_name: this.opts.leader_name,
          from_role: "leader",
          to_instance: worker.id,
          content: firstTitle,
          link: firstLink,
          chain_id: chainDef.chain_id,
          task_id: firstTaskId as never,
          task_title: firstTitle,
          task_description: firstDef.description,
          task_criteria: firstDef.criteria,
          original_requirement_path: requirementPath,
          upstream_commits: initialUpstream,
        });
        await this.rememberDispatch(chainDef.chain_id, firstLink, worker.id);
      } else {
        this.opts.logger.warn(`no ${LINK_TO_ROLE[firstLink] ?? "executor"} available — task queued`);
      }
    }
  }

  // ── Shared audit helpers ────────────────────────────────────────────

  private async openChainAudit(
    chainId: ChainId,
    msg: Message,
    originalRequirement?: string,
  ): Promise<string | null> {
    const requirementPath = cachePaths.chainRequirementPath(
      this.opts.cache_paths,
      chainId,
    );
    await fs.promises.mkdir(path.dirname(requirementPath), { recursive: true });
    await fs.promises.writeFile(
      requirementPath,
      originalRequirement ?? msg.content,
      "utf-8",
    );

    const parentChainId = msg.spawned_from ?? null;
    let chainDepth = 0;
    let parentManifest:
      | Awaited<ReturnType<NonNullable<typeof this.opts.chain_audit>["readManifest"]>>
      | null = null;
    if (parentChainId && this.opts.chain_audit) {
      parentManifest = await this.opts.chain_audit.readManifest(parentChainId);
      if (parentManifest) {
        chainDepth = parentManifest.chain_depth + 1;
      }
    }

    if (this.opts.chain_audit) {
      try {
        await this.opts.chain_audit.openChain(chainId, {
          created_at: new Date().toISOString(),
          leader_id: this.opts.leader_id,
          leader_name: this.opts.leader_name,
          requirement_path: requirementPath,
          max_total_retries: this.opts.max_chain_retries,
          parent_chain_id: parentChainId,
          chain_depth: chainDepth,
          magic_mode: this.opts.magic_mode === true,
        });
      } catch (err) {
        if (err instanceof ChainConflictError) {
          this.opts.logger.error("chain_id conflict — refusing to reopen", {
            chain_id: chainId,
            existing_status: err.existing_status,
            existing_completed_at: err.existing_completed_at,
          });
          this.opts.bus.emit({
            type: "debug_info",
            message: `chain ${chainId} already ${err.existing_status}; new requirement dropped`,
          });
          await this.opts.chain_audit.record(chainId, {
            event: "chain_id_conflict",
            payload: {
              existing_status: err.existing_status,
              existing_completed_at: err.existing_completed_at,
              requirement_path: requirementPath,
            },
          });
          return null; // Abort dispatch — chain_id conflict.
        }
        throw err;
      }
      await this.opts.chain_audit.record(chainId, {
        event: "requirement_received",
        payload: { requirement_path: requirementPath },
      });

      if (parentChainId) {
        await this.opts.chain_audit.appendChildChain(
          parentChainId,
          chainId,
        );
        await this.opts.chain_audit.record(parentChainId, {
          event: "chain_spawned",
          payload: {
            child_chain_id: chainId,
            chain_depth: chainDepth,
          },
        });
        await this.opts.chain_audit.record(chainId, {
          event: "chain_spawned_from",
          payload: {
            parent_chain_id: parentChainId,
            chain_depth: chainDepth,
          },
        });
        this.opts.bus.emit({
          type: "chain_spawned",
          parent_chain_id: parentChainId,
          child_chain_id: chainId,
          chain_depth: chainDepth,
        });
      }
    }

    return requirementPath;
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

    // New per-link commit envelope (project worktree + CO root docs).
    // Stored in chain manifest so:
    //   1. next-link dispatch can populate Message.upstream_commits
    //   2. close_chain can resolve the accept-link branch to merge
    // The legacy `commit` field above is kept for backward-compat with
    // older Workers; either path feeds recordCommit() for MergeValidator
    // to consume.
    const commitsField = decision.commits as CompletionCommits | undefined;
    if (
      this.opts.chain_audit &&
      msg.chain_id &&
      msg.link &&
      commitsField &&
      (commitsField.worktree || commitsField.docs) &&
      typeof this.opts.chain_audit.recordLinkCommit === "function"
    ) {
      const record: LinkCommitRecord = {
        worktree: commitsField.worktree,
        docs: commitsField.docs,
        branch: commitsField.branch,
      };
      await this.opts.chain_audit
        .recordLinkCommit(msg.chain_id, msg.link, record)
        .catch((err) =>
          this.opts.logger.warn("recordLinkCommit failed", {
            chain_id: msg.chain_id,
            link: msg.link,
            error: String(err),
          }),
        );
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

    // defensive legality check. The Worker's SelfEvaluator
    // is the primary gate; ChainRouter records `invalid_decision` and
    // aborts the chain if anything slips through (e.g. spawn_chain on
    // the accept link, or activate_next on explore).
    if (msg.chain_id && msg.link) {
      const chainManifest = this.opts.chain_audit
        ? await this.opts.chain_audit.readManifest(msg.chain_id)
        : null;
      const manifestMagic = chainManifest?.magic_mode ?? this.opts.magic_mode === true;
      if (!isDecisionLegalForLink(decision.decision, msg.link, manifestMagic)) {
        this.opts.logger.error("invalid decision for link — aborting chain", {
          chain_id: msg.chain_id,
          link: msg.link,
          decision: decision.decision,
          magic_mode: manifestMagic,
        });
        if (this.opts.chain_audit) {
          await this.opts.chain_audit.record(msg.chain_id, {
            event: "invalid_decision",
            link: msg.link,
            worker_id: msg.from_instance,
            worker_name: msg.from_name,
            task_id: (msg.task_id as TaskId | null) ?? null,
            payload: {
              decision: decision.decision,
              magic_mode: manifestMagic,
            },
          });
          await this.opts.chain_audit.closeChain(msg.chain_id, "aborted", {
            reason: "invalid_decision",
          });
        }
        this.emitChainClosed(msg.chain_id);
        this.forgetChain(msg.chain_id);
        return;
      }
    }

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
          // Snapshot of every upstream link's worktree commit so the
          // next Worker's pre-task rebase can target the immediate
          // predecessor. Empty {} when no upstream commits exist yet
          // (e.g. dispatching the planner).
          const upstreamCommits = await this.collectUpstreamCommits(
            msg.chain_id,
          );
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
            upstream_commits: upstreamCommits,
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
          await this.runMergeAndCloseChain(
            msg,
            requirementPath,
            "close",
          );
        }
        break;
      }
      // spawn_chain: Explorer requests parent close + child
      // chain bootstrap with `next_requirement` as the new requirement.
      case "spawn_chain": {
        if (msg.chain_id) {
          await this.handleSpawnChain(msg, decision, requirementPath);
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

  /**
   * Shared close-and-merge path used by both `close_chain` and
   * `spawn_chain` decisions. Runs MergeValidator over the chain's
   * accumulated commits, then either:
   *   - closes the chain as `completed` (returns {merged: true}), or
   *   - records the failures, closes as `merge_failed`, and pushes
   *     merge-retry tasks (returns {merged: false}).
   *
   * the `mode` argument is forwarded to
   * `IMergeValidator.validate` so the audit trail distinguishes a
   * close-driven merge from a spawn-driven one.
   */
  private async runMergeAndCloseChain(
    msg: Message,
    requirementPath: string | null,
    mode: "close" | "spawn",
  ): Promise<{ merged: boolean }> {
    if (!msg.chain_id) return { merged: false };
    const failures = await this.runCloseChainMerge(msg.chain_id, mode);
    if (failures.length > 0) {
      this.opts.logger.error(`${mode}_chain blocked: merge failures`, {
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
              mode,
            },
          });
        }
        await this.opts.chain_audit.closeChain(
          msg.chain_id,
          "merge_failed",
          {
            failures: failures as unknown as Record<string, unknown>,
            mode,
          },
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
      return { merged: false };
    }
    if (this.opts.chain_audit) {
      await this.opts.chain_audit.closeChain(msg.chain_id, "completed");
    }
    this.emitChainClosed(msg.chain_id);
    this.forgetChain(msg.chain_id);
    return { merged: true };
  }

  /**
   * handle the spawn_chain Explorer decision. Steps:
   *   1. Read parent manifest; reject if magic_mode mismatches the
   *      decision (defense-in-depth, after isDecisionLegalForLink).
   *   2. Enforce --magic-max-chains. When the new depth would meet or
   *      exceed the cap, audit `magic_depth_exhausted` and demote to
   *      a regular close_chain (the next_requirement is dropped).
   *   3. Merge + close the parent chain (mode='spawn'). On merge
   *      failure, the chain enters merge_failed and no child is
   *      spawned (PRD §6.5).
   *   4. On merge success, inject a synthetic user_input message
   *      bearing `spawned_from = parent_chain_id` and
   *      `next_requirement`. The LeaderWatcher → ChainRouter route()
   *      path picks it up, opens the child chain via openChain (which
   *      reads spawned_from to compute chain_depth+1 and link to the
   *      parent).
   */
  private async handleSpawnChain(
    msg: Message,
    decision: Extract<EvalDecision, { decision: "spawn_chain" }>,
    requirementPath: string | null,
  ): Promise<void> {
    const parentChainId = msg.chain_id;
    if (!parentChainId) return;

    const manifest = this.opts.chain_audit
      ? await this.opts.chain_audit.readManifest(parentChainId)
      : null;
    const parentDepth = manifest?.chain_depth ?? 0;
    const maxChains = this.opts.magic_max_chains ?? null;

    // FR-34 — depth ceiling. >= because the new chain would be at
    // depth `parentDepth + 1`, so when `parentDepth + 1 >= maxChains`
    // the cap is hit. Demote to close_chain.
    if (maxChains != null && parentDepth + 1 >= maxChains) {
      this.opts.logger.warn(
        "magic chain depth cap reached — demoting spawn_chain to close_chain",
        {
          chain_id: parentChainId,
          chain_depth: parentDepth,
          max_chains: maxChains,
        },
      );
      if (this.opts.chain_audit) {
        await this.opts.chain_audit.record(parentChainId, {
          event: "magic_depth_exhausted",
          payload: { chain_depth: parentDepth, max_chains: maxChains },
        });
      }
      this.opts.bus.emit({
        type: "magic_depth_exhausted",
        chain_id: parentChainId,
        chain_depth: parentDepth,
        max_chains: maxChains,
      });
      await this.runMergeAndCloseChain(msg, requirementPath, "close");
      return;
    }

    const { merged } = await this.runMergeAndCloseChain(
      msg,
      requirementPath,
      "spawn",
    );
    if (!merged) {
      // PRD §6.5 — merge_failed blocks child spawn. The parent is
      // already in merge_failed state with retry tasks pushed.
      this.opts.bus.emit({
        type: "debug_info",
        message: `spawn_chain blocked by merge_failed on chain ${parentChainId}`,
      });
      return;
    }

    // Inject the synthetic user_input message. The LeaderWatcher
    // re-routes it through ChainRouter.route → handleRequirement,
    // which reads spawned_from to open the child chain with the
    // proper forest linkage.
    await this.opts.message_router.send({
      type: "user_input",
      from_instance: this.opts.leader_id,
      from_name: this.opts.leader_name,
      from_role: "leader",
      to_instance: this.opts.leader_id,
      content: decision.next_requirement,
      spawned_from: parentChainId,
      next_requirement: decision.next_requirement,
    });
  }

  private async resolveRequirementPath(
    chainId: ChainId | null,
  ): Promise<string | null> {
    if (!chainId || !this.opts.chain_audit) return null;
    const manifest = await this.opts.chain_audit.readManifest(chainId);
    return manifest?.requirement_path ?? null;
  }

  /**
   * v0.6 close-chain merge strategy. The accept-link branch is the
   * tip of the linear pre-task-rebase chain (M0 ← plan ← build ←
   * verify ← review ← accept), so a single merge of that branch
   * brings the entire chain's worktree changes into main with one
   * merge commit. Falls back to the legacy per-link iteration when
   * the chain manifest has no link_commits (Workers older than this
   * change). Returns the list of failed merges; empty = success.
   */
  private async runCloseChainMerge(
    chainId: ChainId,
    mode: "close" | "spawn" = "close",
  ): Promise<MergeFailure[]> {
    const failures: MergeFailure[] = [];
    if (!this.opts.merge_validator) return failures;
    if (this.opts.chain_audit) {
      const manifest = await this.opts.chain_audit.readManifest(chainId);
      const acceptRecord = manifest?.link_commits?.accept;
      if (acceptRecord?.worktree && acceptRecord.branch) {
        try {
          await this.opts.merge_validator.validate({
            sha: acceptRecord.worktree,
            branch: acceptRecord.branch,
            message: `chain ${chainId} accept`,
            task_title: `[${chainId}] accept`,
            task_link: "accept",
          }, chainId, mode);
          return failures;
        } catch (err) {
          failures.push({
            link: "accept",
            sha: acceptRecord.worktree,
            branch: acceptRecord.branch,
            message: `chain ${chainId} accept`,
            error: formatMergeError(err),
            category: categorizeMergeError(err),
          });
          return failures;
        }
      }
      // Fall through to legacy path when no accept-link commit was
      // recorded (e.g. a Worker that doesn't emit `commits` finished
      // the accept link, or accept produced docs-only changes).
    }
    return this.runMergeValidation(chainId, mode);
  }

  /**
   * Legacy fallback: walk the per-chain in-memory commit log in
   * P→B→V→R→A order, asking the MergeValidator for a decision per
   * commit. Continues past a single failure so other commits still
   * get evaluated. Used only when `runCloseChainMerge` could not find
   * an accept-link record (manifest absent / older Workers).
   */
  private async runMergeValidation(
    chainId: ChainId,
    mode: "close" | "spawn" = "close",
  ): Promise<MergeFailure[]> {
    const failures: Array<{
      link: TaskLink;
      sha: string;
      branch: string;
      message: string;
      error: string;
      category: MergeFailureCategory;
    }> = [];
    if (!this.opts.merge_validator) return failures;
    const commits = this.chainCommits.get(chainId);
    if (!commits || commits.length === 0) return failures;
    for (const commit of commits) {
      try {
        await this.opts.merge_validator.validate(commit, chainId, mode);
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
          error: formatMergeError(err),
          category: categorizeMergeError(err),
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
    failures: ReadonlyArray<MergeFailure>,
    requirementPath: string | null,
  ): Promise<void> {
    if (!msg.chain_id || !this.opts.chain_audit) return;
    const manifest = await this.opts.chain_audit.readManifest(msg.chain_id);
    if (!manifest) return;
    for (const f of failures) {
      // Lock/permission/network failures are not solved by re-dispatching
      // the same task to the same worker. They need human intervention
      // and are already recorded in chain-audit's merge_failure events.
      // Unknown ("other") falls through to a retry because legacy paths
      // and pre-classification errors should keep their pre-existing
      // recovery behavior.
      if (
        f.category === "worktree_locked" ||
        f.category === "permission" ||
        f.category === "network"
      ) {
        this.opts.logger.warn(
          `merge ${f.category} for ${f.link} — no auto retry`,
          { chain_id: msg.chain_id, sha: f.sha, error: f.error },
        );
        continue;
      }
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
      // Wipe the rejected link's commit record and everything
      // downstream so the retried task sees a clean upstream slate.
      // Without this the retried Worker would still rebase onto the
      // superseded predecessor's hash. Tolerated when the mock /
      // older chain-audit lacks the API.
      if (
        typeof this.opts.chain_audit.clearLinkCommitsFrom === "function"
      ) {
        await this.opts.chain_audit
          .clearLinkCommitsFrom(msg.chain_id, prevLink)
          .catch((err) =>
            this.opts.logger.warn("clearLinkCommitsFrom failed", {
              chain_id: msg.chain_id,
              error: String(err),
            }),
          );
      }
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
    const upstreamCommits = await this.collectUpstreamCommits(msg.chain_id);
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
      upstream_commits: upstreamCommits,
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

  /**
   * Find any available idle worker regardless of role.
   * Used by new format tasks that don't have a specific role requirement.
   */
  private async findIdleWorker(): Promise<{ id: InstanceId; name: string } | null> {
    const instances = await this.opts.registry.list();
    for (const inst of instances) {
      if (inst.status === "idle") {
        return { id: inst.id, name: inst.name };
      }
    }
    return null;
  }

  /**
   * Normalize ChainDef response to handle model non-compliance.
   * Models may output `tasks` as an array instead of `task_list`.
   * This function converts such responses to the expected format.
   *
   * Normalization rules:
   * 1. If response has `task_list` → use as-is (correct format)
   * 2. If response has `tasks` as array → convert to `task_list`
   * 3. If response has `tasks` as object → legacy format, convert accordingly
   */
  private normalizeChainDef(data: unknown): unknown {
    if (typeof data !== "object" || data === null) {
      return data;
    }

    const obj = data as Record<string, unknown>;

    // Case 1: Already has task_list → use as-is
    if ("task_list" in obj && Array.isArray(obj.task_list)) {
      return obj;
    }

    // Case 2: Has tasks as array → convert to task_list
    if ("tasks" in obj && Array.isArray(obj.tasks)) {
      this.opts.logger.debug("normalizing ChainDef: converting tasks array to task_list");
      return {
        ...obj,
        task_list: obj.tasks,
        tasks: undefined,
      };
    }

    // Case 3: Has tasks as object → legacy format, use as-is
    if ("tasks" in obj && typeof obj.tasks === "object" && obj.tasks !== null) {
      return obj;
    }

    // No normalization needed
    return obj;
  }
}
