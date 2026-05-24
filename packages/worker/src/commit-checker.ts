import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  cachePaths,
  CommitFailedError,
  type IClaudeRunner,
  type ILogger,
  type ITemplateEngine,
  type SessionId,
  type TaskId,
  type TaskLink,
  TemplateNotFoundError,
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
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: this.opts.worktree_path,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!status.trim()) {
      this.opts.logger.info("no changes to commit");
      return null;
    }

    const { changed, untracked, paths } = parseStatus(status);
    if (paths.length === 0) {
      // status was non-empty (e.g. only line endings whitespace) but
      // parser found no concrete paths. Bail out safely rather than
      // run `git add` with no targets.
      this.opts.logger.info("no commit-worthy paths after status parse");
      return null;
    }
    const message = await this.generateMessage(ctx, changed, untracked, resumeSessionId);

    try {
      // Add only the explicit paths git status reported. `-A` was too
      // broad: a stray .env or token.json that .gitignore failed to
      // catch would have been pulled in along with the real changes.
      execFileSync("git", ["add", "--", ...paths], {
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

    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
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
    if (!this.opts.template_engine.has("worker-commit-message.md")) {
      throw new TemplateNotFoundError("worker-commit-message.md");
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
      return firstLine || `chore: auto-commit from ${this.opts.worker_name}`;
    } catch (err) {
      this.opts.logger.warn("commit message generation failed", {
        error: String(err),
      });
      return `chore: auto-commit from ${this.opts.worker_name}`;
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

/**
 * Paths that `worktree-initializer.ts:seedWorktreeAssets` writes into
 * every worker's worktree as **untracked** stateless references
 * (agent templates, skills, team CLAUDE.md, personal-claude-<role>.md).
 * They're re-seeded on every orchestrator run, so committing them would
 * (1) pollute downstream merges, and (2) break `WorkerWatcher.preTaskRebase`
 * for the next link — its `git rebase <upstream_sha>` would abort with
 * "untracked working tree files would be overwritten by checkout" because
 * each worker's worktree has its own untracked copies of the same paths
 * that the upstream commit already tracks. See
 * `docs/evals/02-leader-worker-communication.md` §6.2 (D7).
 */
const SEEDED_STATE_PATH_PREFIXES: readonly string[] = [
  ".claude-orchestrator/agents/",
  ".claude/skills/",
];
const SEEDED_STATE_EXACT_PATHS: readonly string[] = [
  "CLAUDE.md",
];

function isSeededOrchestratorState(p: string): boolean {
  if (SEEDED_STATE_EXACT_PATHS.includes(p)) return true;
  return SEEDED_STATE_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function parseStatus(status: string): {
  changed: string[];
  untracked: string[];
  /**
   * Bare path list (no porcelain code prefix) — what `git add --
   * <paths>` actually takes. Renames are split into both src and dest
   * so the index update is complete; deletions are included so the
   * commit captures the removal.
   */
  paths: string[];
} {
  const changed: string[] = [];
  const untracked: string[] = [];
  const paths: string[] = [];
  for (const line of status.trim().split("\n")) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    if (code === "??") {
      if (isSeededOrchestratorState(rest)) continue;
      untracked.push(rest);
      paths.push(rest);
      continue;
    }
    changed.push(`${code.trim()} ${rest}`);
    if (rest.includes(" -> ")) {
      // Rename or copy: "old -> new"; add both for index completeness
      const [src, dst] = rest.split(" -> ");
      const srcPath = src?.trim();
      const dstPath = dst?.trim();
      if (srcPath && !isSeededOrchestratorState(srcPath)) paths.push(srcPath);
      if (dstPath && !isSeededOrchestratorState(dstPath)) paths.push(dstPath);
    } else {
      if (!isSeededOrchestratorState(rest)) paths.push(rest);
    }
  }
  return { changed, untracked, paths };
}
