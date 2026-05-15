import * as fs from "node:fs";
import * as path from "node:path";
import { extractJson } from "@co/runtime";
import {
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
}

export class ChainRouter {
  /**
   * In-memory chain → link → worker_id mapping. Populated whenever the
   * router dispatches a task to a worker, consulted by the `feedback`
   * decision branch to route feedback back to the previous-link worker
   * when the evaluator did not provide an explicit `feedback_target`.
   *
   * The map is process-local. If the leader restarts mid-chain, the
   * mapping is lost — feedback in that window falls back to the
   * `msg.from_instance` legacy behavior.
   */
  private readonly chainWorkers = new Map<ChainId, Map<TaskLink, InstanceId>>();

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

  private rememberDispatch(
    chainId: ChainId,
    link: TaskLink,
    workerId: InstanceId,
  ): void {
    let perChain = this.chainWorkers.get(chainId);
    if (!perChain) {
      perChain = new Map();
      this.chainWorkers.set(chainId, perChain);
    }
    perChain.set(link, workerId);
  }

  private forgetChain(chainId: ChainId): void {
    this.chainWorkers.delete(chainId);
    this.chainCommits.delete(chainId);
  }

  async route(msg: Message): Promise<void> {
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
        task_doc_path: msg.task_doc_path ?? "",
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
      await this.opts.chain_audit.openChain(chainDef.chain_id, {
        created_at: new Date().toISOString(),
        leader_id: this.opts.leader_id,
        leader_name: this.opts.leader_name,
        requirement_path: requirementPath,
      });
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
        this.rememberDispatch(chainDef.chain_id, firstLink, firstWorker.id);
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
            task_doc_path: nextTask.task_doc_path,
            original_requirement_path: requirementPath,
          });
          this.rememberDispatch(msg.chain_id, nextLink, worker.id);
        }
        break;
      }
      case "feedback": {
        const targetId = this.resolveFeedbackTarget(msg, decision.feedback_target ?? null);
        if (this.opts.chain_audit && msg.chain_id) {
          await this.opts.chain_audit.record(msg.chain_id, {
            event: "feedback_sent",
            link: msg.link ?? null,
            worker_id: targetId,
            payload: { feedback_to_worker: decision.feedback_to_worker },
          });
        }
        await this.opts.message_router.send({
          type: "direct",
          from_instance: this.opts.leader_id,
          from_name: this.opts.leader_name,
          from_role: "leader",
          to_instance: targetId,
          content: decision.feedback_to_worker,
          link: msg.link,
          chain_id: msg.chain_id,
          original_requirement_path: requirementPath,
        });
        break;
      }
      case "close_chain": {
        if (msg.chain_id) {
          await this.runMergeValidation(msg.chain_id);
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
   * commit. Errors from a single commit (e.g. merge conflict) are
   * logged and swallowed so subsequent commits still get a chance.
   * Skipped silently when no validator is configured.
   */
  private async runMergeValidation(chainId: ChainId): Promise<void> {
    if (!this.opts.merge_validator) return;
    const commits = this.chainCommits.get(chainId);
    if (!commits || commits.length === 0) return;
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
      }
    }
  }

  /**
   * Decide who receives a feedback message.
   *
   * Priority:
   *   1. Explicit `feedback_target` from the EvalDecision (Worker-asserted).
   *   2. The worker that handled the previous link in this chain (e.g.
   *      Verifier feedback → Builder), looked up via chainWorkers.
   *   3. The sender of the completion report (legacy fallback — keeps
   *      single-worker / ad-hoc flows unblocked).
   */
  private resolveFeedbackTarget(
    msg: Message,
    explicit: InstanceId | null,
  ): InstanceId {
    if (explicit) return explicit;
    if (msg.chain_id && msg.link) {
      const prevLink = PREV_LINKS[msg.link];
      if (prevLink) {
        const prev = this.chainWorkers.get(msg.chain_id)?.get(prevLink);
        if (prev) return prev;
      }
    }
    return msg.from_instance;
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
