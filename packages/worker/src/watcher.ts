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

const LINK_TO_TEMPLATE: Record<TaskLink | "decompose", string> = {
  plan: "worker-plan.md",
  build: "worker-build.md",
  verify: "worker-verify.md",
  review: "worker-review.md",
  accept: "worker-accept.md",
  decompose: "worker-decompose.md",
};

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
    // For chain links with a chain_id, route the Worker's output to the
    // chain-shared cache location so downstream Workers (in different
    // worktrees) can read it. Ad-hoc / decompose tasks keep the per-task
    // result path.
    const isChainLink = link !== null && CHAIN_LINKS.includes(link as TaskLink);
    const chainArtifacts = this.collectChainArtifacts(msg, link);
    const resultPath =
      isChainLink && msg.chain_id
        ? cachePaths.chainArtifactPath(
            this.opts.cache_paths,
            msg.chain_id as ChainId,
            link as TaskLink,
          )
        : cachePaths.taskResultPath(this.opts.cache_paths, taskId);
    const logPath = cachePaths.taskLogPath(
      this.opts.cache_paths,
      taskId,
      new Date().toISOString(),
    );

    // Claim the task in ZK so the cluster sees this worker as its owner.
    // Skipped for ad-hoc / decompose messages (no real pending node) and
    // tolerated when the pending node is gone (e.g. resumed dispatch).
    const realTaskId =
      isChainLink && msg.task_id ? (msg.task_id as TaskId) : null;
    const taskStart = Date.now();
    if (realTaskId) {
      const claimed = await this.opts.task_queue.claimById(
        realTaskId,
        this.opts.instance_id,
      );
      if (!claimed) {
        this.opts.logger.warn(
          `task already claimed/completed, proceeding without ZK claim`,
          { task_id: realTaskId },
        );
      }
    }

    let prompt = msg.content;
    if (link) {
      const tplName = LINK_TO_TEMPLATE[link];
      if (this.opts.template_engine.has(tplName)) {
        prompt = this.opts.template_engine.render(tplName, {
          name: this.opts.worker_name,
          role: this.opts.worker_role,
          task_title: msg.task_title ?? "",
          task_description: msg.task_description ?? msg.content,
          task_criteria: msg.task_criteria ?? "",
          task_doc_path: msg.task_doc_path ?? "",
          result_path: resultPath,
          work_dir: this.opts.worktree_path,
          time: new Date().toISOString(),
          content: msg.content,
          // Cross-worktree artifact paths — Workers in other worktrees
          // wrote here; downstream link templates reference these vars.
          upstream_plan_artifact: chainArtifacts.plan,
          upstream_build_artifact: chainArtifacts.build,
          upstream_verify_artifact: chainArtifacts.verify,
          upstream_review_artifact: chainArtifacts.review,
        });
      }
    }

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

    const result = await this.opts.runner.run({
      prompt,
      log_path: logPath,
      system_prompt: this.opts.identity_system_prompt,
      cwd: this.opts.worktree_path,
      quiet: true,
    });

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
   * Compute the cache_dir-shared chain artifact paths for every link
   * upstream of the current one. Empty string when no chain_id is set
   * (ad-hoc / decompose flows) so template rendering remains stable.
   */
  private collectChainArtifacts(
    msg: Message,
    link: TaskLink | "decompose" | null,
  ): {
    plan: string;
    build: string;
    verify: string;
    review: string;
  } {
    const empty = { plan: "", build: "", verify: "", review: "" };
    if (!msg.chain_id || !link || link === "decompose") return empty;
    const chainId = msg.chain_id as ChainId;
    const plan = cachePaths.chainArtifactPath(
      this.opts.cache_paths,
      chainId,
      "plan",
    );
    const build = cachePaths.chainArtifactPath(
      this.opts.cache_paths,
      chainId,
      "build",
    );
    const verify = cachePaths.chainArtifactPath(
      this.opts.cache_paths,
      chainId,
      "verify",
    );
    const review = cachePaths.chainArtifactPath(
      this.opts.cache_paths,
      chainId,
      "review",
    );
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
        task_doc_path: msg.task_doc_path ?? "",
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
