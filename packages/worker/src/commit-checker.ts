import * as fs from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import {
  cachePaths,
  CommitFailedError,
  type IClaudeRunner,
  type ILogger,
  type ITemplateEngine,
  type SessionId,
  type TaskId,
  type TaskLink,
} from "@co/contracts";

export interface CommitResult {
  sha: string;
  message: string;
  changed_files: string[];
  untracked_files: string[];
}

export interface CommitContext {
  link: TaskLink;
  task_id: TaskId;
  task_title: string;
  task_description: string;
}

export interface CommitCheckerOptions {
  worktree_path: string;
  runner: IClaudeRunner;
  template_engine: ITemplateEngine;
  logger: ILogger;
  cache_paths: cachePaths.CachePathOptions;
  worker_name: string;
}

export class CommitChecker {
  constructor(private readonly opts: CommitCheckerOptions) {}

  async check(
    ctx: CommitContext,
    resumeSessionId?: SessionId,
  ): Promise<CommitResult | null> {
    const status = execSync("git status --porcelain", {
      cwd: this.opts.worktree_path,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!status.trim()) {
      this.opts.logger.info("no changes to commit");
      return null;
    }

    const { changed, untracked } = parseStatus(status);
    const message = await this.generateMessage(ctx, changed, untracked, resumeSessionId);

    try {
      execFileSync("git", ["add", "-A"], {
        cwd: this.opts.worktree_path,
        stdio: "pipe",
      });
      execFileSync("git", ["commit", "-m", message], {
        cwd: this.opts.worktree_path,
        stdio: "pipe",
      });
    } catch (err) {
      // Surface as a typed error rather than silently swallowing — the
      // pre-A1 implementation returned null here, which caused the task
      // to complete with no commit envelope so close_chain's
      // MergeValidator skipped the link entirely. Callers (worker
      // watcher) catch CommitFailedError and emit a feedback decision
      // back to the Leader instead.
      const stderr = extractStderr(err);
      this.opts.logger.error("git commit failed", {
        error: String(err),
        stderr,
      });
      throw new CommitFailedError(
        `git commit failed in ${this.opts.worktree_path}`,
        stderr,
        err,
      );
    }

    const sha = execSync("git rev-parse HEAD", {
      cwd: this.opts.worktree_path,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return {
      sha,
      message,
      changed_files: changed,
      untracked_files: untracked,
    };
  }

  private async generateMessage(
    ctx: CommitContext,
    changed: string[],
    untracked: string[],
    resumeSessionId?: SessionId,
  ): Promise<string> {
    const fallback = `chore: auto-commit from ${this.opts.worker_name}`;
    if (!this.opts.template_engine.has("worker-commit-message.md")) {
      return fallback;
    }
    const prompt = this.opts.template_engine.render("worker-commit-message.md", {
      changed_files: changed.map((f) => `  ${f}`).join("\n"),
      untracked_files: untracked.map((f) => `  ${f}`).join("\n"),
      task_title: ctx.task_title,
      link: ctx.link,
    });
    const logPath = cachePaths.commitLogPath(this.opts.cache_paths, ctx.task_id);
    try {
      await this.opts.runner.run({
        prompt,
        log_path: logPath,
        resume_session_id: resumeSessionId,
        quiet: true,
      });
      const output = await fs.promises.readFile(logPath, "utf-8");
      const firstLine = output.trim().split("\n")[0].slice(0, 72);
      return firstLine || fallback;
    } catch (err) {
      this.opts.logger.warn("commit message generation failed", {
        error: String(err),
      });
      return fallback;
    }
  }
}

function extractStderr(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const e = err as { stderr?: Buffer | string };
    return Buffer.isBuffer(e.stderr)
      ? e.stderr.toString("utf-8")
      : String(e.stderr ?? "");
  }
  return "";
}

function parseStatus(status: string): {
  changed: string[];
  untracked: string[];
} {
  const changed: string[] = [];
  const untracked: string[] = [];
  for (const line of status.trim().split("\n")) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === "??") untracked.push(file);
    else changed.push(`${code.trim()} ${file}`);
  }
  return { changed, untracked };
}
