import * as fs from "node:fs";
import { ZkClient } from "../zk/client.js";
import * as paths from "../zk/paths.js";
import { MessageSchema } from "../models/schemas.js";
import { HookEngine } from "../hooks/engine.js";
import { Logger } from "../utils/logger.js";
import { TemplateEngine, LINK_TEMPLATES } from "../executor/template.js";
import { ClaudeRunner } from "../executor/runner.js";
import { SelfEvaluator, CHAIN_LINKS } from "./evaluator.js";
import { CommitChecker, type CommitResult } from "./commit-checker.js";

export class WorkerWatcher {
  private inFlight = new Set<string>();
  private instanceName = "";
  private instanceRole = "";
  private logger = new Logger("WorkerWatcher");
  stopped = false;

  constructor(
    private zk: ZkClient,
    private instanceId: string,
    private leaderInstanceId: string,
    private hooks: HookEngine,
    private templateEngine: TemplateEngine,
    private runner: ClaudeRunner,
    private evaluator: SelfEvaluator,
    private commitChecker: CommitChecker | null = null,
    private worktreePath = "",
    private worktreeBranch = "",
  ) {}

  async start(): Promise<void> {
    const instData = await this.zk.getInstance(this.instanceId);
    this.instanceName = (instData?.name as string) ?? this.instanceId.slice(0, 8);
    this.instanceRole = (instData?.role as string) ?? "builder";

    await this.templateEngine.loadAll();

    await this.zk.mkdirp(paths.messageDirPath(this.instanceId));
    this.logger.info(`Watching for messages on instance ${this.instanceId.slice(0, 8)}...`);
    this.logger.info("Press Ctrl+C to stop.");
    this.watchLoop();
  }

  private async watchLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      const children = await this.zk.watchMessageDir(
        this.instanceId,
        (newChildren) => {
          for (const cid of newChildren) this.processMessage(cid);
          this.watchLoop();
        }
      );
      for (const cid of children) await this.processMessage(cid);
    } catch {
      if (!this.stopped) setTimeout(() => this.watchLoop(), 1000);
    }
  }

  private async processMessage(msgId: string): Promise<void> {
    if (this.inFlight.has(msgId) || this.stopped) return;
    const data = await this.zk.getMessage(this.instanceId, msgId);
    if (!data) return;
    const msg = MessageSchema.parse({ ...data, id: msgId });
    if (msg.read) return;

    this.inFlight.add(msgId);
    const fromLabel = msg.from_name || msg.from_instance?.slice(0, 8) || "unknown";
    const link = (msg.link as string) ?? "_generic";
    const taskId = (msg as Record<string, unknown>).task_id as string | undefined;
    const uniqueKey = taskId || `task-${msgId}-${Date.now().toString(36)}`;

    const logPath = this.runner.logPath(uniqueKey);
    const resultPath = this.runner.resultPath(uniqueKey);

    const template = this.templateEngine.get(link);
    const prompt = template
      ? this.templateEngine.render(template, {
          name: this.instanceName,
          preset_role: this.instanceRole,
          task_title: (msg.task_title as string) ?? "",
          task_description: (msg.task_description as string) ?? msg.content,
          task_criteria: (msg.task_criteria as string) ?? "",
          task_doc_path: (msg.task_doc_path as string) ?? "",
          result_path: resultPath,
          work_dir: this.worktreePath,
          time: new Date().toISOString(),
          content: msg.content,
          worktree_path: this.worktreePath,
          worktree_branch: this.worktreeBranch,
          instance_id: this.instanceId,
        })
      : msg.content;

    this.logger.info(`Message from ${fromLabel} (${msg.type}): ${msg.content.slice(0, 200)}`);
    if (link !== "_generic") this.logger.info(`  Link: ${link}`);
    this.logger.info("Processing...");

    const hookCtx = {
      instanceId: this.instanceId,
      instanceName: this.instanceName,
      instanceRole: this.instanceRole,
      messageId: msgId,
      messageType: msg.type,
      messageContent: msg.content,
      fromInstance: msg.from_instance,
      fromName: msg.from_name,
      toInstance: msg.to_instance ?? "",
      workDir: "",
      link: link !== "_generic" ? link : null,
    };

    this.hooks.fire("worker_message_start", hookCtx);
    const result = await this.runner.run(prompt, logPath);
    this.hooks.fire("worker_message_end", { ...hookCtx, logPath, exitCode: result.code });

    // Auto-commit changes for chain-link tasks
    let commitResult: CommitResult | null = null;
    if (link !== "_generic" && this.commitChecker) {
      commitResult = await this.commitChecker.check({
        link,
        taskTitle: (msg.task_title as string) ?? link,
        taskDescription: (msg.task_description as string) ?? msg.content,
      });
    }

    if (link !== "_generic") {
      await this.sendCompletionReport(link, msg, resultPath, uniqueKey, commitResult);
    }

    try {
      msg.read = true;
      await this.zk.updateMessage(this.instanceId, msgId, msg as unknown as Record<string, unknown>);
    } catch {
      // best effort
    }

    this.inFlight.delete(msgId);
    this.logger.info(`Done. Log: ${logPath}`);
  }

  private async sendCompletionReport(
    link: string,
    msg: Record<string, unknown>,
    resultPath: string,
    uniqueKey: string,
    commitResult: CommitResult | null = null,
  ): Promise<void> {
    try {
      let reportContent: string;
      let reportLink = link;

      if (link === "decompose") {
        try {
          reportContent = await fs.promises.readFile(resultPath, "utf-8");
          reportLink = "task_defs";
        } catch {
          reportContent = `Link: ${link}\nStatus: completed\nResult Path: ${resultPath}`;
        }
      } else if (CHAIN_LINKS.includes(link)) {
        const msgVars: Record<string, string> = {
          task_title: (msg.task_title as string) ?? "",
          task_description: (msg.task_description as string) ?? "",
          task_criteria: (msg.task_criteria as string) ?? "",
          task_doc_path: (msg.task_doc_path as string) ?? "",
          content: msg.content as string,
        };
        reportContent = await this.evaluator.evaluate(link, msgVars, resultPath, uniqueKey);
      } else {
        reportContent = `Link: ${link}\nStatus: completed\nResult Path: ${resultPath}\nTask completed.`;
      }

      // Inject commit info into report content if available
      if (commitResult) {
        try {
          const reportJson = JSON.parse(reportContent);
          reportJson.commit = {
            sha: commitResult.sha,
            message: commitResult.message,
            branch: this.worktreeBranch,
            changed_files: commitResult.changedFiles,
            untracked_files: commitResult.untrackedFiles,
          };
          reportContent = JSON.stringify(reportJson);
        } catch {
          // Content is not JSON, append commit info
          reportContent += `\nCommit: ${commitResult.sha.slice(0, 7)} - ${commitResult.message}`;
        }
      }

      await this.zk.createMessage(this.leaderInstanceId, {
        type: "direct",
        from_instance: this.instanceId,
        from_name: this.instanceName,
        from_role: this.instanceRole,
        to_instance: this.instanceId,
        content: reportContent,
        created_at: new Date().toISOString(),
        read: false,
        result_path: resultPath,
        link: reportLink,
        chain_id: msg.chain_id as string ?? null,
      });
      this.logger.info("Completion report sent.");
    } catch (err) {
      this.logger.error("Failed to send completion report", err);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
