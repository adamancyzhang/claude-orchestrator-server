import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { Logger } from "../utils/logger.js";
import { extractJson } from "../utils/json.js";
import type { ClaudeRunner } from "../executor/runner.js";
import type { LeaderEventBus } from "./event-bus.js";

export interface MergeDecision {
  decision: "merge" | "skip" | "review_first";
  reason: string;
}

export class MergeValidator {
  private logger = new Logger("MergeValidator");

  constructor(
    private projectRoot: string,
    private runner: ClaudeRunner,
    private eventBus: LeaderEventBus,
    private mergeDecisionTemplate?: string,
  ) {}

  async validate(commitInfo: {
    sha: string;
    message: string;
    branch: string;
    taskTitle: string;
    taskLink: string;
  }): Promise<MergeDecision> {
    const mainBranch = this.getMainBranch();
    const merged = this.isCommitMerged(commitInfo.sha, mainBranch);
    if (merged) return { decision: "skip", reason: "Already merged" };

    try {
      const decision = await this.askMergeDecision(commitInfo, mainBranch);

      if (decision.decision === "merge") {
        try {
          const currentBranch = this.execGit("rev-parse --abbrev-ref HEAD");
          this.execGit(`checkout ${mainBranch}`);
          this.execGit(
            `merge ${commitInfo.branch} --no-ff -m "Merge ${commitInfo.branch}: ${commitInfo.message}"`,
          );
          this.eventBus.emit({
            type: "debug_info",
            message: `Merged: ${commitInfo.branch} -> ${mainBranch}`,
          });
          // Switch back
          try { this.execGit(`checkout ${currentBranch}`); } catch { /* ok */ }
        } catch {
          try { this.execGit("merge --abort"); } catch { /* ok */ }
          return { decision: "review_first", reason: "Merge conflict, manual review needed" };
        }
      }

      return decision;
    } catch {
      return { decision: "review_first", reason: "Merge decision failed, manual review needed" };
    }
  }

  private getMainBranch(): string {
    try {
      return this.execGit("rev-parse --abbrev-ref HEAD");
    } catch {
      return "main";
    }
  }

  private isCommitMerged(sha: string, _mainBranch: string): boolean {
    try {
      const result = this.execGit(`branch --contains ${sha}`);
      return result.length > 0;
    } catch {
      return false;
    }
  }

  private async askMergeDecision(
    commit: { sha: string; message: string; branch: string; taskTitle: string; taskLink: string },
    mainBranch: string,
  ): Promise<MergeDecision> {
    const template = this.mergeDecisionTemplate ?? "";
    const prompt = template
      .replace(/\{\{branch\}\}/g, commit.branch)
      .replace(/\{\{sha\}\}/g, commit.sha)
      .replace(/\{\{message\}\}/g, commit.message)
      .replace(/\{\{task_title\}\}/g, commit.taskTitle)
      .replace(/\{\{task_link\}\}/g, commit.taskLink)
      .replace(/\{\{main_branch\}\}/g, mainBranch);

    const uniqueKey = `merge-decision-${Date.now().toString(36)}`;
    const logPath = this.runner.logPath(uniqueKey);
    await this.runner.run(prompt, logPath);

    try {
      const output = await fs.promises.readFile(logPath, "utf-8");
      return JSON.parse(extractJson(output));
    } catch {
      // Fallback: merge if no conflict expected
      return { decision: "merge", reason: "Auto-merge (no decision available)" };
    }
  }

  private execGit(args: string): string {
    try {
      return execSync(`git ${args}`, {
        cwd: this.projectRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`git ${args} failed: ${msg}`);
    }
  }
}
