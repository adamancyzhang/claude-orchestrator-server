import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { Logger } from "../utils/logger.js";
import type { ClaudeRunner } from "../executor/runner.js";

export interface CommitResult {
  sha: string;
  message: string;
  changedFiles: string[];
  untrackedFiles: string[];
}

export class CommitChecker {
  private logger = new Logger("CommitChecker");

  constructor(
    private worktreePath: string,
    private runner: ClaudeRunner,
    private commitMsgTemplate?: string,
  ) {}

  async check(
    taskContext: {
      link: string;
      taskTitle: string;
      taskDescription: string;
    },
    resumeSessionId?: string,
  ): Promise<CommitResult | null> {
    try {
      const statusOutput = execSync("git status --porcelain", {
        cwd: this.worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (!statusOutput.trim()) {
        this.logger.info("No changes to commit");
        return null;
      }

      const { changed, untracked } = this.parseStatus(statusOutput);

      const commitMsg = await this.generateCommitMessage(changed, untracked, taskContext, resumeSessionId);

      execSync("git add -A", { cwd: this.worktreePath, stdio: "pipe" });
      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
        cwd: this.worktreePath,
        stdio: "pipe",
      });

      const sha = execSync("git rev-parse HEAD", {
        cwd: this.worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      this.logger.info(`Committed ${sha.slice(0, 7)}: ${commitMsg}`);
      return { sha, message: commitMsg, changedFiles: changed, untrackedFiles: untracked };
    } catch (err) {
      this.logger.error("Commit check failed", err);
      return null;
    }
  }

  private parseStatus(statusOutput: string): { changed: string[]; untracked: string[] } {
    const changed: string[] = [];
    const untracked: string[] = [];

    for (const line of statusOutput.trim().split("\n")) {
      if (!line) continue;
      const status = line.slice(0, 2);
      const file = line.slice(3);
      if (status === "??") {
        untracked.push(file);
      } else {
        changed.push(`${status.trim()} ${file}`);
      }
    }

    return { changed, untracked };
  }

  private async generateCommitMessage(
    changed: string[],
    untracked: string[],
    ctx: { link: string; taskTitle: string; taskDescription: string },
    resumeSessionId?: string,
  ): Promise<string> {
    const template = this.commitMsgTemplate ?? "";
    const prompt = template
      .replace(/\{\{changed_files\}\}/g, changed.map(f => `  ${f}`).join("\n"))
      .replace(/\{\{untracked_files\}\}/g, untracked.map(f => `  ${f}`).join("\n"))
      .replace(/\{\{task_title\}\}/g, ctx.taskTitle)
      .replace(/\{\{link\}\}/g, ctx.link);

    const uniqueKey = `commit-${Date.now().toString(36)}`;
    const logPath = this.runner.logPath(uniqueKey);
    await this.runner.run(prompt, logPath, { resumeSessionId });

    try {
      const output = await fs.promises.readFile(logPath, "utf-8");
      return output.trim().split("\n")[0].slice(0, 72);
    } catch (err) {
      this.logger.warn(`Failed to read commit message from log, using fallback: ${err instanceof Error ? err.message : String(err)}`);
      return `chore: auto-commit ${ctx.link} task`;
    }
  }
}
