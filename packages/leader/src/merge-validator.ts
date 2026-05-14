import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { extractJson } from "@co/runtime";
import {
  MergeConflictError,
  MergeDecisionSchema,
  ValidationError,
  type IClaudeRunner,
  type IEventBus,
  type ILogger,
  type ITemplateEngine,
  type LeaderEvent,
  type MergeDecision,
} from "@co/contracts";

export interface CommitInfo {
  sha: string;
  message: string;
  branch: string;
  task_title: string;
  task_link: string;
}

export interface MergeValidatorOptions {
  project_root: string;
  runner: IClaudeRunner;
  template_engine: ITemplateEngine;
  template_name: string;
  bus: IEventBus<LeaderEvent>;
  logger: ILogger;
  log_path_for: (key: string) => string;
}

export class MergeValidator {
  constructor(private readonly opts: MergeValidatorOptions) {}

  async validate(commit: CommitInfo): Promise<MergeDecision> {
    const mainBranch = this.execGit("rev-parse --abbrev-ref HEAD");
    if (this.isCommitMerged(commit.sha)) {
      return MergeDecisionSchema.parse({
        decision: "skip",
        reason: "Already merged",
      });
    }

    const decision = await this.askDecision(commit, mainBranch);

    if (decision.decision === "merge") {
      const currentBranch = this.execGit("rev-parse --abbrev-ref HEAD");
      try {
        this.execGit(`checkout ${mainBranch}`);
        this.execGit(
          `merge ${commit.branch} --no-ff -m "Merge ${commit.branch}: ${commit.message}"`,
        );
        this.opts.bus.emit({
          type: "debug_info",
          message: `merged: ${commit.branch} -> ${mainBranch}`,
        });
      } catch (err) {
        // Abort and downgrade decision to review_first on conflict.
        try {
          this.execGit("merge --abort");
        } catch {
          // ignore abort failure
        }
        this.opts.logger.warn("merge conflict — abort and downgrade to review_first", {
          branch: commit.branch,
          error: String(err),
        });
        const conflicts = this.detectConflicts();
        this.execGit(`checkout ${currentBranch}`);
        throw new MergeConflictError(
          `merge ${commit.branch} conflicted`,
          conflicts,
        );
      }
      this.execGit(`checkout ${currentBranch}`);
    }

    return decision;
  }

  private async askDecision(
    commit: CommitInfo,
    mainBranch: string,
  ): Promise<MergeDecision> {
    const prompt = this.opts.template_engine.render(this.opts.template_name, {
      branch: commit.branch,
      sha: commit.sha,
      message: commit.message,
      task_title: commit.task_title,
      task_link: commit.task_link,
      main_branch: mainBranch,
    });
    const logPath = this.opts.log_path_for(`merge-${Date.now().toString(36)}`);
    await this.opts.runner.run({ prompt, log_path: logPath });
    const output = await fs.promises.readFile(logPath, "utf-8");
    const parsed = MergeDecisionSchema.safeParse(JSON.parse(extractJson(output)));
    if (!parsed.success) {
      throw new ValidationError("merge decision JSON invalid", parsed.error);
    }
    return parsed.data;
  }

  private isCommitMerged(sha: string): boolean {
    return this.execGit(`branch --contains ${sha}`).length > 0;
  }

  private detectConflicts(): string[] {
    try {
      const out = this.execGit("diff --name-only --diff-filter=U");
      return out.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  private execGit(args: string): string {
    return execSync(`git ${args}`, {
      cwd: this.opts.project_root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }
}
