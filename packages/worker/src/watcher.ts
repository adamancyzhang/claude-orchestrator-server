import * as fs from "node:fs";
import {
  asTaskId,
  cachePaths,
  type ChainId,
  type IClaudeRunner,
  type IHookEngine,
  type IInstanceRegistry,
  type ILogger,
  type IMessageRouter,
  type ITaskQueue,
  type ITemplateEngine,
  type InstanceId,
  type Message,
  type SessionId,
  type TaskId,
  type TaskLink,
} from "@co/contracts";
import { ClaudeRunner } from "@co/runtime";
import type { SelfEvaluator } from "./evaluator.js";
import { CHAIN_LINKS } from "./evaluator.js";
import type { CommitChecker, CommitResult } from "./commit-checker.js";

/**
 * Per-link user-message template. The system prompt (identity + standing
 * role description) is loaded once at boot in child-boot.ts; these
 * templates only carry the per-task body — task metadata, upstream
 * artifact paths, output contract, retry hint.
 */
const LINK_TO_TASK_TEMPLATE: Record<TaskLink | "decompose", string> = {
  plan: "worker-planner-task.md",
  build: "worker-builder-task.md",
  verify: "worker-verifier-task.md",
  review: "worker-reviewer-task.md",
  accept: "worker-accepter-task.md",
  decompose: "worker-decompose.md",
};

const LINK_TO_LOCAL_PREFIX: Record<TaskLink, string> = {
  plan: "plan",
  build: "build",
  verify: "verify",
  review: "review",
  accept: "accept",
};

const MAX_GENERATION_RETRIES = 3;

interface GenerationFailure {
  kind: "missing" | "empty" | "exit_code";
  detail: string;
}

export interface WorkerWatcherOptions {
  instance_id: InstanceId;
  leader_id: InstanceId;
  worker_name: string;
  worker_role: string;
  worktree_path: string;
  worktree_branch: string;
  registry: IInstanceRegistry;
  message_router: IMessageRouter;
  task_queue: ITaskQueue;
  runner: IClaudeRunner;
  template_engine: ITemplateEngine;
  hooks: IHookEngine;
  evaluator: SelfEvaluator;
  commit_checker: CommitChecker;
  cache_paths: cachePaths.CachePathOptions;
  identity_system_prompt: string;
  logger: ILogger;
}

export class WorkerWatcher {
  private stopped = false;
  private readonly inFlight = new Set<string>();

  constructor(private readonly opts: WorkerWatcherOptions) {}

  async start(): Promise<void> {
    await this.opts.message_router.waitForMessage(
      this.opts.instance_id,
      (msg) => {
        if (this.stopped) return;
        if (this.inFlight.has(msg.id)) return;
        this.inFlight.add(msg.id);
        void this.processMessage(msg).finally(() => this.inFlight.delete(msg.id));
      },
    );
  }

  stop(): void {
    this.stopped = true;
  }

  private async processMessage(msg: Message): Promise<void> {
    const link = (msg.link ?? null) as TaskLink | "decompose" | null;
    const taskId =
      (msg.task_id as TaskId | null) ??
      asTaskId(`adhoc-${msg.id || Date.now().toString(36)}`);
    const isChainLink = link !== null && CHAIN_LINKS.includes(link as TaskLink);
    const realTaskId =
      isChainLink && msg.task_id ? (msg.task_id as TaskId) : null;

    // Mark this worker busy in ZK before doing anything observable. The
    // idle restore lives in the outer finally block so it runs even on
    // early returns, exceptions, or dispatch dismissals. Errors are
    // swallowed — heartbeat updates must never crash the watch loop.
    await this.opts.registry
      .heartbeat(this.opts.instance_id, {
        status: "busy",
        current_task_id: realTaskId,
      })
      .catch((err) => {
        this.opts.logger.warn("heartbeat busy failed", { error: String(err) });
      });

    try {
      await this.processTask({ msg, link, taskId, realTaskId, isChainLink });
    } finally {
      await this.opts.registry
        .heartbeat(this.opts.instance_id, {
          status: "idle",
          current_task_id: null,
        })
        .catch((err) => {
          this.opts.logger.warn("heartbeat idle failed", { error: String(err) });
        });
    }
  }

  private async processTask(args: {
    msg: Message;
    link: TaskLink | "decompose" | null;
    taskId: TaskId;
    realTaskId: TaskId | null;
    isChainLink: boolean;
  }): Promise<void> {
    const { msg, link, taskId, realTaskId, isChainLink } = args;
    const chainArtifacts = await this.collectChainArtifacts(msg, link);
    const resultPath = cachePaths.taskResultPath(
      this.opts.cache_paths,
      taskId,
    );
    const logPath = cachePaths.taskLogPath(
      this.opts.cache_paths,
      taskId,
      new Date().toISOString().replace(/[:.]/g, "-"),
    );

    // Leader-directed dispatch: the task must be pinned to this worker
    // (assigned_to == self) before we claim it. If a different message
    // wakes us up for a task we are not assigned to, skip — the
    // legitimate assignee will pick it up.
    const taskStart = Date.now();
    if (realTaskId) {
      const pending = await this.opts.task_queue.getPending(realTaskId);
      if (pending && pending.assigned_to && pending.assigned_to !== this.opts.instance_id) {
        this.opts.logger.warn(
          `task assigned to another worker, dismissing dispatch`,
          {
            task_id: realTaskId,
            assigned_to: pending.assigned_to,
            self: this.opts.instance_id,
          },
        );
        await this.opts.message_router.dismiss(this.opts.instance_id, msg.id);
        return;
      }
      const claimed = await this.opts.task_queue.claimById(
        realTaskId,
        this.opts.instance_id,
      );
      if (!claimed) {
        this.opts.logger.warn(
          `task already claimed/completed, proceeding without ZK claim`,
          { task_id: realTaskId },
        );
      } else {
        await this.opts.hooks.fire({
          type: "task_claimed",
          env: {
            CO_WORKER_NAME: this.opts.worker_name,
            CO_WORKER_ID: this.opts.instance_id,
            CO_TASK_ID: realTaskId,
            CO_LINK: (link as TaskLink) ?? "",
            CO_CHAIN_ID: (msg.chain_id as ChainId) ?? "",
          },
        });
      }
    }

    // uniqueKey = chain_id when available, else the task id. Drives both
    // the user-message template variable and the in-worktree local copy
    // filename. Chain-shared cache path stays per-(chain,link) folder.
    const uniqueKey: string =
      (msg.chain_id as string | null) ?? (taskId as unknown as string);
    const dateStamp = new Date().toISOString().slice(0, 10);
    const localPrefix = isChainLink
      ? LINK_TO_LOCAL_PREFIX[link as TaskLink]
      : (link as string | null) ?? "result";
    const localDocPath = cachePaths.workerLocalDocPath(
      this.opts.cache_paths,
      this.opts.worker_name,
      dateStamp,
      localPrefix,
      uniqueKey,
    );

    await this.opts.hooks.fire({
      type: "worker_message_start",
      env: {
        CO_WORKER_NAME: this.opts.worker_name,
        CO_WORKER_ID: this.opts.instance_id,
        CO_TASK_ID: taskId,
        CO_LINK: (link as TaskLink) ?? "",
        CO_CHAIN_ID: (msg.chain_id as ChainId) ?? "",
        CO_LOG_PATH: logPath,
        CO_RESULT_PATH: resultPath,
      },
    });

    const workspaceMemoryPath = cachePaths.workspaceMemoryRoot(
      this.opts.cache_paths,
    );
    const renderPrompt = (retryHint: string): string => {
      if (!link) return msg.content;
      const tplName = LINK_TO_TASK_TEMPLATE[link];
      if (!this.opts.template_engine.has(tplName)) return msg.content;
      return this.opts.template_engine.render(tplName, {
        name: this.opts.worker_name,
        role: this.opts.worker_role,
        date: dateStamp,
        unique_key: uniqueKey,
        task_title: msg.task_title ?? "",
        task_description: msg.task_description ?? msg.content,
        task_criteria: msg.task_criteria ?? "",
        result_path: resultPath,
        local_doc_path: localDocPath,
        work_dir: this.opts.worktree_path,
        time: new Date().toISOString(),
        content: msg.content,
        original_requirement_path: msg.original_requirement_path ?? "",
        upstream_plan_artifact: chainArtifacts.plan,
        upstream_build_artifact: chainArtifacts.build,
        upstream_verify_artifact: chainArtifacts.verify,
        upstream_review_artifact: chainArtifacts.review,
        workspace_memory_path: workspaceMemoryPath,
        retry_hint: retryHint,
      });
    };

    const validateOutput = async (
      runResult: { exit_code: number },
    ): Promise<GenerationFailure | null> => {
      if (runResult.exit_code !== 0) {
        return { kind: "exit_code", detail: `exit_code=${runResult.exit_code}` };
      }
      if (!isChainLink) return null;
      try {
        const stat = await fs.promises.stat(resultPath);
        if (stat.size === 0) {
          return { kind: "empty", detail: `${resultPath} is 0 bytes` };
        }
        const content = await fs.promises.readFile(resultPath, "utf-8");
        if (!content.trim()) {
          return { kind: "empty", detail: `${resultPath} contains only whitespace` };
        }
        return null;
      } catch {
        return { kind: "missing", detail: `${resultPath} does not exist` };
      }
    };

    let result: { exit_code: number; session_id: SessionId | null; log_path: string } = {
      exit_code: -1,
      session_id: null,
      log_path: logPath,
    };
    let retryHint = "";
    let failure: GenerationFailure | null = null;
    const maxAttempts = isChainLink ? MAX_GENERATION_RETRIES : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt = renderPrompt(retryHint);
      result = await this.opts.runner.run({
        prompt,
        log_path: logPath,
        system_prompt: this.opts.identity_system_prompt,
        cwd: this.opts.worktree_path,
        quiet: true,
      });
      failure = await validateOutput(result);
      if (!failure) break;
      this.opts.logger.warn("worker output failed validation", {
        attempt,
        max: maxAttempts,
        kind: failure.kind,
        detail: failure.detail,
      });
      if (attempt < maxAttempts) {
        retryHint = `[RETRY ${attempt + 1}/${maxAttempts}] Previous attempt failed: ${failure.detail}. You MUST write your output to exactly: ${resultPath}. Use the Write tool, then immediately Read it back to confirm the file exists and is non-empty.`;
      }
    }

    await this.opts.hooks.fire({
      type: "worker_message_end",
      env: {
        CO_WORKER_NAME: this.opts.worker_name,
        CO_WORKER_ID: this.opts.instance_id,
        CO_TASK_ID: taskId,
        CO_LINK: (link as TaskLink) ?? "",
        CO_CHAIN_ID: (msg.chain_id as ChainId) ?? "",
        CO_LOG_PATH: logPath,
        CO_RESULT_PATH: resultPath,
        exit_code: result.exit_code,
      },
    });

    if (failure) {
      this.opts.logger.error(
        `worker output validation failed after ${maxAttempts} attempts — reporting to Leader`,
        { task_id: taskId, kind: failure.kind, detail: failure.detail },
      );
      await this.opts.message_router.send({
        type: "direct",
        from_instance: this.opts.instance_id,
        from_name: this.opts.worker_name,
        from_role: this.opts.worker_role,
        to_instance: this.opts.leader_id,
        content: `worker output validation failed after ${maxAttempts} attempts: ${failure.detail}`,
        link: (link as TaskLink) ?? null,
        chain_id: msg.chain_id ?? null,
        task_id: taskId,
        result_path: resultPath,
      });
      if (realTaskId) {
        try {
          await this.opts.task_queue.fail(realTaskId, failure.detail);
        } catch (err) {
          this.opts.logger.warn("task fail() marking errored", {
            task_id: realTaskId,
            error: String(err),
          });
        }
      }
      await this.opts.message_router.dismiss(this.opts.instance_id, msg.id);
      return;
    }

    let commit: CommitResult | null = null;
    if (link && CHAIN_LINKS.includes(link as TaskLink)) {
      commit = await this.opts.commit_checker.check(
        {
          link: link as TaskLink,
          task_id: taskId,
          task_title: msg.task_title ?? link,
          task_description: msg.task_description ?? msg.content,
        },
        result.session_id ?? undefined,
      );
      // Best-effort workspace memory refresh: tell the Leader which
      // source files this commit touched so it can regenerate their
      // memory entries. Send only when there is at least one changed
      // file; failures here must not block task completion.
      if (commit && commit.changed_files.length > 0) {
        this.opts.message_router
          .send({
            type: "memory_refresh",
            from_instance: this.opts.instance_id,
            from_name: this.opts.worker_name,
            from_role: this.opts.worker_role,
            to_instance: this.opts.leader_id,
            content: JSON.stringify({
              chain_id: msg.chain_id ?? null,
              task_id: taskId,
              commit_sha: commit.sha,
              changed_files: commit.changed_files,
            }),
            link: link as TaskLink,
            chain_id: msg.chain_id ?? null,
            task_id: taskId,
          })
          .catch((err) =>
            this.opts.logger.warn("memory_refresh send failed", {
              error: String(err),
            }),
          );
      }
    }

    if (link && CHAIN_LINKS.includes(link as TaskLink)) {
      await this.sendCompletionReport(
        link as TaskLink,
        msg,
        resultPath,
        taskId,
        commit,
        result.session_id ?? undefined,
      );
    } else if (link === "decompose") {
      await this.sendDecomposeReport(msg, resultPath, taskId);
    }

    // Transition the task from claimed → completed in ZK once the
    // self-evaluation report is on its way to the leader.
    if (realTaskId) {
      const durationSeconds = (Date.now() - taskStart) / 1000;
      try {
        await this.opts.task_queue.complete(
          realTaskId,
          resultPath,
          this.opts.instance_id,
          this.opts.worker_name,
          durationSeconds,
        );
        await this.opts.hooks.fire({
          type: "task_completed",
          env: {
            CO_WORKER_NAME: this.opts.worker_name,
            CO_WORKER_ID: this.opts.instance_id,
            CO_TASK_ID: realTaskId,
            CO_LINK: (link as TaskLink) ?? "",
            CO_CHAIN_ID: (msg.chain_id as ChainId) ?? "",
            duration_seconds: durationSeconds,
          },
        });
      } catch (err) {
        this.opts.logger.warn("task completion failed", {
          task_id: realTaskId,
          error: String(err),
        });
      }
    }

    await this.opts.message_router.dismiss(this.opts.instance_id, msg.id);
    this.opts.logger.info("message processed", { log_path: logPath });

    void ClaudeRunner.buildIdentityPrompt; // keep reference for runtime hint
  }

  /**
   * Resolve upstream artifact paths for the current link by reading the
   * chain manifest. Each upstream link's accepted task_id maps to
   * `tasks/<task_id>/result.md`. Empty string when no chain_id is set
   * (ad-hoc / decompose flows) or when the manifest is missing the entry
   * — template rendering remains stable.
   */
  private async collectChainArtifacts(
    msg: Message,
    link: TaskLink | "decompose" | null,
  ): Promise<{
    plan: string;
    build: string;
    verify: string;
    review: string;
  }> {
    const empty = { plan: "", build: "", verify: "", review: "" };
    if (!msg.chain_id || !link || link === "decompose") return empty;
    const chainId = msg.chain_id as ChainId;
    let manifest: { link_tasks?: Record<string, string | null> } | null = null;
    try {
      const manifestPath = cachePaths.chainManifestPath(
        this.opts.cache_paths,
        chainId,
      );
      manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8"));
    } catch {
      return empty;
    }
    const linkTasks = manifest?.link_tasks ?? {};
    const lookup = (k: TaskLink): string => {
      const tid = linkTasks[k];
      if (!tid) return "";
      return cachePaths.taskResultPath(
        this.opts.cache_paths,
        asTaskId(tid),
      );
    };
    const plan = lookup("plan");
    const build = lookup("build");
    const verify = lookup("verify");
    const review = lookup("review");
    switch (link as TaskLink) {
      case "plan":
        return empty;
      case "build":
        return { plan, build: "", verify: "", review: "" };
      case "verify":
        return { plan, build, verify: "", review: "" };
      case "review":
        return { plan, build, verify, review: "" };
      case "accept":
        return { plan, build, verify, review };
    }
  }

  private async sendCompletionReport(
    link: TaskLink,
    msg: Message,
    resultPath: string,
    taskId: TaskId,
    commit: CommitResult | null,
    resumeSessionId: SessionId | undefined,
  ): Promise<void> {
    const evalContent = await this.opts.evaluator.evaluate({
      link,
      task_id: taskId,
      task_result_path: resultPath,
      msg_vars: {
        task_title: msg.task_title ?? "",
        task_description: msg.task_description ?? "",
        task_criteria: msg.task_criteria ?? "",
        content: msg.content,
      },
      resume_session_id: resumeSessionId,
    });

    let body = evalContent;
    if (commit) {
      try {
        const json = JSON.parse(evalContent);
        json.commit = {
          sha: commit.sha,
          message: commit.message,
          branch: this.opts.worktree_branch,
          changed_files: commit.changed_files,
          untracked_files: commit.untracked_files,
        };
        body = JSON.stringify(json);
      } catch {
        body =
          evalContent +
          `\nCommit: ${commit.sha.slice(0, 7)} - ${commit.message}`;
      }
    }

    await this.opts.message_router.send({
      type: "completion_report",
      from_instance: this.opts.instance_id,
      from_name: this.opts.worker_name,
      from_role: this.opts.worker_role,
      to_instance: this.opts.leader_id,
      content: body,
      link,
      task_id: taskId,
      chain_id: msg.chain_id ?? null,
      result_path: resultPath,
    });
  }

  private async sendDecomposeReport(
    msg: Message,
    resultPath: string,
    taskId: TaskId,
  ): Promise<void> {
    const content = await fs.promises.readFile(resultPath, "utf-8");
    await this.opts.message_router.send({
      type: "completion_report",
      from_instance: this.opts.instance_id,
      from_name: this.opts.worker_name,
      from_role: this.opts.worker_role,
      to_instance: this.opts.leader_id,
      content,
      link: null,
      task_id: taskId,
      chain_id: msg.chain_id ?? null,
      result_path: resultPath,
    });
  }
}
