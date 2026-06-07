import * as fs from "node:fs";
import {
  asTaskId,
  cachePaths,
  CommitFailedError,
  RebaseConflictError,
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
  type UpstreamCommits,
  TemplateNotFoundError,
} from "@co/contracts";
import { ClaudeRunner } from "@co/runtime";
import type { SelfEvaluator } from "./evaluator.js";
import { chainLinksFor } from "./evaluator.js";
import type { CommitChecker, CommitResult } from "./commit-checker.js";
import type { WorkerDocsCommitter } from "./docs-committer.js";
import type { WorkerActivityReporter } from "./activity-reporter.js";
import {
  collectChainArtifacts,
  LINK_TO_LOCAL_PREFIX,
  pickImmediatePredecessor,
} from "./chain-artifacts.js";
import {
  buildCompletionBody,
  sendCompletionReport as sendCompletionReportFn,
  sendDecomposeReport as sendDecomposeReportFn,
  sendForcedFeedbackReport as sendForcedFeedbackReportFn,
  type WorkerIdentity,
} from "./report-messages.js";
import { buildWorkerTaskPrompt } from "./prompt-render.js";
import {
  classifyWorkerOutput,
  MAX_GENERATION_RETRIES,
  type GenerationFailure,
} from "./output-validator.js";
import { preTaskRebase } from "./git-rebase.js";

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
  docs_committer: WorkerDocsCommitter;
  cache_paths: cachePaths.CachePathOptions;
  identity_system_prompt: string;
  logger: ILogger;
  /**
   * Optional remote name for pre-task rebase fetches. `null` = purely
   * local rebase onto upstream commit shas (no fetch). Sourced from
   * ResolvedConfig.git.remote via child-boot.
   */
  git_remote: string | null;
  /**
   * Whether the cluster was launched with `--magic`. Drives the set of
   * links the Worker accepts as chain links (default mode excludes
   * `explore`). Sourced from the leader's CLI flags via child-boot.
   */
  magic_mode: boolean;
  /**
   * Optional pipeline-step reporter. When provided, the Worker surfaces
   * phase transitions (claim/rebase/generate/commit/...) to the Leader
   * for live display in the TUI. Absence keeps the Worker silent — used
   * by tests that do not care about activity.
   */
  activity_reporter?: WorkerActivityReporter;
  /**
   * Interval in milliseconds between periodic heartbeats. Defaults to 10 seconds.
   */
  heartbeat_interval_ms?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds

export class WorkerWatcher {
  private stopped = false;
  private readonly inFlight = new Set<string>();
  private readonly chainLinks: readonly TaskLink[];
  private heartbeat_timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: WorkerWatcherOptions) {
    this.chainLinks = chainLinksFor(opts.magic_mode);
  }

  async start(): Promise<void> {
    // Start periodic heartbeat
    const interval = this.opts.heartbeat_interval_ms ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeat_timer = setInterval(() => {
      void this.sendHeartbeat();
    }, interval);

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
    if (this.heartbeat_timer) {
      clearInterval(this.heartbeat_timer);
      this.heartbeat_timer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.opts.registry.heartbeat(this.opts.instance_id, {
        status: this.inFlight.size > 0 ? "busy" : "idle",
      });
    } catch (err) {
      this.opts.logger.warn("periodic heartbeat failed", {
        error: String(err),
      });
    }
  }

  private async processMessage(msg: Message): Promise<void> {
    const link = (msg.link ?? null) as TaskLink | "decompose" | null;
    const taskId =
      (msg.task_id as TaskId | null) ??
      asTaskId(`adhoc-${msg.id || Date.now().toString(36)}`);
    const isChainLink = link !== null && this.chainLinks.includes(link as TaskLink);
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

    this.opts.activity_reporter?.report({
      phase: "claim",
      action: "phase_start",
      detail: `task ${realTaskId ?? taskId}`,
      link: link as TaskLink | null,
      task_id: taskId,
    });

    try {
      await this.processTask({ msg, link, taskId, realTaskId, isChainLink });
    } finally {
      this.opts.activity_reporter?.report({
        phase: "report",
        action: "phase_end",
        detail: "task message processed",
        link: link as TaskLink | null,
        task_id: taskId,
      });
      // Force-flush so the final frame reaches the Leader before the
      // worker goes idle in the TUI.
      await this.opts.activity_reporter?.flush();
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
    const chainArtifacts = await collectChainArtifacts(
      this.opts.cache_paths,
      msg.chain_id,
      link,
    );
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
            CO_WORKER_ROLE: this.opts.worker_role,
            CO_LEADER_ID: this.opts.leader_id,
            CO_MESSAGE_ID: (msg.id as never) ?? "",
            CO_TASK_ID: realTaskId,
            CO_LINK: (link as TaskLink) ?? "",
            CO_CHAIN_ID: (msg.chain_id as ChainId) ?? "",
          },
        });
      }
    }

    this.opts.activity_reporter?.report({
      phase: "claim",
      action: "phase_end",
      detail: realTaskId ? `claimed ${realTaskId}` : "ad-hoc message",
      link: link as TaskLink | null,
      task_id: taskId,
    });

    // Pre-task rebase onto the immediate predecessor link's commit
    // hash so this Worker's branch contains all upstream artifacts
    // before work starts. Skipped for decompose tasks and the plan
    // link (no upstream). On rebase conflict we abort and feed back
    // to Leader so a human can investigate — silently auto-resolving
    // could clobber upstream changes.
    if (
      isChainLink &&
      link !== null &&
      link !== "decompose"
    ) {
      const predecessor = pickImmediatePredecessor(
        link as TaskLink,
        msg.upstream_commits,
      );
      if (predecessor) {
        this.opts.activity_reporter?.report({
          phase: "rebase",
          action: "phase_start",
          detail: `onto ${predecessor.slice(0, 8)}`,
          link: link as TaskLink | null,
          task_id: taskId,
        });
        try {
          await preTaskRebase({
            worktree_path: this.opts.worktree_path,
            target_sha: predecessor,
            git_remote: this.opts.git_remote,
            logger: this.opts.logger,
          });
          this.opts.activity_reporter?.report({
            phase: "rebase",
            action: "phase_end",
            detail: `onto ${predecessor.slice(0, 8)}`,
            link: link as TaskLink | null,
            task_id: taskId,
          });
        } catch (err) {
          if (err instanceof RebaseConflictError) {
            this.opts.activity_reporter?.report({
              phase: "rebase",
              action: "error",
              detail: `conflict on ${err.conflict_files.join(", ").slice(0, 80)}`,
              link: link as TaskLink | null,
              task_id: taskId,
            });
            this.opts.logger.error(
              "pre-task rebase conflicted — reporting as feedback",
              {
                task_id: taskId,
                link,
                predecessor: predecessor.slice(0, 8),
                conflicts: err.conflict_files,
              },
            );
            await this.sendForcedFeedbackReport({
              link: link as TaskLink,
              msg,
              resultPath: cachePaths.taskResultPath(
                this.opts.cache_paths,
                taskId,
              ),
              taskId,
              stderr: `rebase onto ${predecessor.slice(0, 8)} conflicted: ${err.conflict_files.join(", ")}`,
            });
            await this.opts.message_router.dismiss(
              this.opts.instance_id,
              msg.id,
            );
            return;
          }
          this.opts.logger.warn(
            "pre-task rebase failed (non-conflict) — proceeding without rebase",
            { error: String(err), predecessor: predecessor.slice(0, 8) },
          );
        }
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
        CO_WORKER_ROLE: this.opts.worker_role,
        CO_LEADER_ID: this.opts.leader_id,
        CO_MESSAGE_ID: (msg.id as never) ?? "",
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
    const coRoot = cachePaths.coRootDir(this.opts.cache_paths);
    const renderPrompt = (retryHint: string): string =>
      buildWorkerTaskPrompt({
        template_engine: this.opts.template_engine,
        link,
        msg,
        worker_name: this.opts.worker_name,
        worker_role: this.opts.worker_role,
        worktree_path: this.opts.worktree_path,
        result_path: resultPath,
        local_doc_path: localDocPath,
        unique_key: uniqueKey,
        date: dateStamp,
        retry_hint: retryHint,
        chain_artifacts: chainArtifacts,
        co_root: coRoot,
        workspace_memory_path: workspaceMemoryPath,
      });

    const validateOutput = (
      runResult: { exit_code: number },
    ): Promise<GenerationFailure | null> =>
      classifyWorkerOutput({
        exit_code: runResult.exit_code,
        is_chain_link: isChainLink,
        result_path: resultPath,
      });

    let result: { exit_code: number; session_id: SessionId | null; log_path: string } = {
      exit_code: -1,
      session_id: null,
      log_path: logPath,
    };
    let retryHint = "";
    let failure: GenerationFailure | null = null;
    let assistantResponse = "";
    const maxAttempts = isChainLink ? MAX_GENERATION_RETRIES : 1;
    this.opts.activity_reporter?.report({
      phase: "generate",
      action: "phase_start",
      detail: `up to ${maxAttempts} attempt(s)`,
      link: link as TaskLink | null,
      task_id: taskId,
    });
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.opts.activity_reporter?.report({
        phase: "generate",
        action: "retry",
        detail: `attempt ${attempt}/${maxAttempts}`,
        link: link as TaskLink | null,
        task_id: taskId,
      });
      const prompt = renderPrompt(retryHint);
      let attemptText = "";
      // Use dynamic system_prompt from message if available, otherwise fall back to identity
      const systemPrompt = msg.system_prompt ?? this.opts.identity_system_prompt;
      result = await this.opts.runner.run({
        prompt,
        log_path: logPath,
        system_prompt: systemPrompt,
        cwd: this.opts.worktree_path,
        quiet: true,
        on_chunk: (chunk) => {
          if (chunk.text) {
            attemptText += chunk.text;
          }
          const e = chunk.event;
          if (!e) return;
          if (e.kind === "tool_use") {
            this.opts.activity_reporter?.report({
              phase: "generate",
              action: "tool_use",
              detail: `${e.tool}: ${e.summary}`.slice(0, 120),
              link: link as TaskLink | null,
              task_id: taskId,
            });
          } else if (e.kind === "text") {
            const first =
              e.text.split("\n").find((l) => l.trim().length > 0) ?? "";
            if (first.length > 0) {
              this.opts.activity_reporter?.report({
                phase: "generate",
                action: "text",
                detail: first.slice(0, 120),
                link: link as TaskLink | null,
                task_id: taskId,
              });
            }
          } else if (e.kind === "thinking") {
            this.opts.activity_reporter?.report({
              phase: "generate",
              action: "thinking",
              detail: "thinking…",
              link: link as TaskLink | null,
              task_id: taskId,
            });
          }
        },
      });
      failure = await validateOutput(result);
      if (!failure) {
        assistantResponse = attemptText;
        break;
      }
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
    this.opts.activity_reporter?.report({
      phase: "validate",
      action: failure ? "error" : "phase_end",
      detail: failure
        ? `${failure.kind}: ${failure.detail}`.slice(0, 120)
        : `${assistantResponse.length} chars`,
      link: link as TaskLink | null,
      task_id: taskId,
    });

    await this.opts.hooks.fire({
      type: "worker_message_end",
      env: {
        CO_WORKER_NAME: this.opts.worker_name,
        CO_WORKER_ID: this.opts.instance_id,
        CO_WORKER_ROLE: this.opts.worker_role,
        CO_LEADER_ID: this.opts.leader_id,
        CO_MESSAGE_ID: (msg.id as never) ?? "",
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

    // Send accumulated assistant response text to the leader so it
    // appears in the TUI worker-messages panel before the completion
    // report overwrites the current message.
    if (assistantResponse) {
      await this.opts.message_router.send({
        type: "direct",
        from_instance: this.opts.instance_id,
        from_name: this.opts.worker_name,
        from_role: this.opts.worker_role,
        to_instance: this.opts.leader_id,
        content: assistantResponse,
        link: (link as TaskLink) ?? null,
        chain_id: msg.chain_id ?? null,
        task_id: taskId,
      });
    }

    let commit: CommitResult | null = null;
    let commitFailure: CommitFailedError | null = null;
    let docsSha: string | null = null;
    if (link && this.chainLinks.includes(link as TaskLink)) {
      this.opts.activity_reporter?.report({
        phase: "commit",
        action: "phase_start",
        detail: `link ${link}`,
        link: link as TaskLink,
        task_id: taskId,
      });
      try {
        commit = await this.opts.commit_checker.check(
          {
            link: link as TaskLink,
            task_id: taskId,
            task_title: msg.task_title ?? link,
            task_description: msg.task_description ?? msg.content,
          },
          result.session_id ?? undefined,
        );
        this.opts.activity_reporter?.report({
          phase: "commit",
          action: "phase_end",
          detail: commit
            ? `sha ${commit.sha.slice(0, 8)} (${commit.changed_files.length} files)`
            : "no changes",
          link: link as TaskLink,
          task_id: taskId,
        });
      } catch (err) {
        if (err instanceof CommitFailedError) {
          // git commit raised a real error (not "no changes"). Capture
          // it so the completion report becomes a feedback decision the
          // Leader can retry instead of a silent activate_next that
          // would let close_chain proceed without our link's commit.
          commitFailure = err;
          this.opts.activity_reporter?.report({
            phase: "commit",
            action: "error",
            detail: err.stderr.slice(0, 120),
            link: link as TaskLink,
            task_id: taskId,
          });
          this.opts.logger.error(
            "commit failed — reporting as feedback retry to Leader",
            { task_id: taskId, link, stderr: err.stderr },
          );
        } else {
          throw err;
        }
      }
      // CO root docs commit — runs whether or not worktree commit
      // succeeded, so docs surface even when the chain ultimately
      // feeds back. The committer scopes itself to docs/<worker>/
      // and uses `git commit --only -- <paths>` so it is safe to run
      // concurrently with other workers sharing the CO root.
      if (!commitFailure) {
        this.opts.activity_reporter?.report({
          phase: "docs_commit",
          action: "phase_start",
          detail: `docs for ${this.opts.worker_name}`,
          link: link as TaskLink,
          task_id: taskId,
        });
        try {
          docsSha = await this.opts.docs_committer.commitIfChanged(
            {
              task_id: taskId,
              link: link as TaskLink,
              task_title: msg.task_title ?? link,
            },
            result.session_id ?? undefined,
          );
          this.opts.activity_reporter?.report({
            phase: "docs_commit",
            action: "phase_end",
            detail: docsSha ? `sha ${docsSha.slice(0, 8)}` : "no docs changes",
            link: link as TaskLink,
            task_id: taskId,
          });
        } catch (err) {
          this.opts.activity_reporter?.report({
            phase: "docs_commit",
            action: "error",
            detail: String(err).slice(0, 120),
            link: link as TaskLink,
            task_id: taskId,
          });
          this.opts.logger.warn("docs commit threw unexpectedly", {
            error: String(err),
          });
        }
      }
      // Best-effort workspace memory refresh: tell the Leader which
      // source files this commit touched so it can regenerate their
      // memory entries. Send only when there is at least one changed
      // file; failures here must not block task completion. Skipped
      // entirely when commit failed since there is no committed change
      // set to refresh against.
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

    if (link && this.chainLinks.includes(link as TaskLink)) {
      if (commitFailure) {
        // Skip self-evaluation entirely: the link's deliverable is broken
        // because the commit did not land. Force a feedback decision
        // targeted back to this worker so Leader requeues the same link.
        await this.sendForcedFeedbackReport({
          link: link as TaskLink,
          msg,
          resultPath,
          taskId,
          stderr: commitFailure.stderr,
        });
      } else {
        this.opts.activity_reporter?.report({
          phase: "evaluate",
          action: "phase_start",
          detail: `link ${link}`,
          link: link as TaskLink,
          task_id: taskId,
        });
        await this.sendCompletionReport(
          link as TaskLink,
          msg,
          resultPath,
          taskId,
          commit,
          docsSha,
          result.session_id ?? undefined,
        );
        this.opts.activity_reporter?.report({
          phase: "evaluate",
          action: "phase_end",
          detail: `link ${link}`,
          link: link as TaskLink,
          task_id: taskId,
        });
      }
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
            CO_WORKER_ROLE: this.opts.worker_role,
            CO_LEADER_ID: this.opts.leader_id,
            CO_MESSAGE_ID: (msg.id as never) ?? "",
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


  }

  private workerIdentity(): WorkerIdentity {
    return {
      instance_id: this.opts.instance_id,
      worker_name: this.opts.worker_name,
      worker_role: this.opts.worker_role,
      worktree_branch: this.opts.worktree_branch,
      leader_id: this.opts.leader_id,
    };
  }

  private async sendCompletionReport(
    link: TaskLink,
    msg: Message,
    resultPath: string,
    taskId: TaskId,
    commit: CommitResult | null,
    docsSha: string | null,
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

    const body = buildCompletionBody({
      evalContent,
      commit,
      docsSha,
      worktreeBranch: this.opts.worktree_branch,
    });

    await sendCompletionReportFn({
      router: this.opts.message_router,
      identity: this.workerIdentity(),
      link,
      msg,
      resultPath,
      taskId,
      body,
    });
  }

  private async sendForcedFeedbackReport(args: {
    link: TaskLink;
    msg: Message;
    resultPath: string;
    taskId: TaskId;
    stderr: string;
  }): Promise<void> {
    await sendForcedFeedbackReportFn({
      router: this.opts.message_router,
      identity: this.workerIdentity(),
      link: args.link,
      msg: args.msg,
      resultPath: args.resultPath,
      taskId: args.taskId,
      stderr: args.stderr,
    });
  }

  private async sendDecomposeReport(
    msg: Message,
    resultPath: string,
    taskId: TaskId,
  ): Promise<void> {
    await sendDecomposeReportFn({
      router: this.opts.message_router,
      identity: this.workerIdentity(),
      msg,
      resultPath,
      taskId,
    });
  }
}
