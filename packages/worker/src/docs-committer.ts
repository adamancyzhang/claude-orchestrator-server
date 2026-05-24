import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  cachePaths,
  type IClaudeRunner,
  type ILogger,
  type ITemplateEngine,
  type SessionId,
  type TaskId,
  type TaskLink,
} from "@co/contracts";

/**
 * Mutex contract for serializing the git add → commit → rev-parse
 * critical section across concurrent Worker processes that share the
 * CO root. Production passes nothing (single-machine fork uses
 * `.git/index.lock` for cross-process exclusion); the in-process e2e
 * harness passes an async mutex to avoid `.git/index.lock` collisions
 * when 6 workers share one Node event loop and one git index.
 */
export interface DocsCommitMutex {
  acquire(): Promise<() => void>;
}

export interface WorkerDocsCommitterOptions {
  co_root: string;
  worker_name: string;
  runner: IClaudeRunner;
  template_engine: ITemplateEngine;
  cache_paths: cachePaths.CachePathOptions;
  logger: ILogger;
  /**
   * Optional cross-worker serialization for the git add → commit →
   * rev-parse window. See {@link DocsCommitMutex}.
   */
  docs_commit_mutex?: DocsCommitMutex;
}

export interface DocsCommitContext {
  task_id: TaskId;
  link: TaskLink | "decompose";
  task_title: string;
}

/**
 * Commits `docs/<worker_name>/...` under the CO root after a Worker
 * finishes a task. All Worker processes share the same CO root working
 * tree, so we cannot rely on the project-repo's per-Worker branch
 * isolation. Two protections combine to keep concurrent commits safe:
 *
 *   1. `git status --porcelain -- docs/<worker_name>/` and the
 *      subsequent `git add` are scoped to this Worker's own
 *      sub-directory, so we never stage another Worker's file.
 *   2. `git commit --only -- <paths>` builds the commit tree from
 *      HEAD + just these paths, ignoring whatever else may be staged
 *      by a concurrent Worker. `.git/index.lock` provides the
 *      cross-process barrier git itself relies on.
 *
 * Returns the resulting commit sha, or `null` when there were no docs
 * changes for this Worker.
 */
export class WorkerDocsCommitter {
  constructor(private readonly opts: WorkerDocsCommitterOptions) {}

  async commitIfChanged(
    ctx: DocsCommitContext,
    resumeSessionId?: SessionId,
  ): Promise<string | null> {
    const scope = `docs/${this.opts.worker_name}`;
    const scopeAbs = path.join(this.opts.co_root, scope);
    if (!fs.existsSync(scopeAbs)) {
      // Worker never wrote a doc this round — nothing to commit.
      return null;
    }

    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--", scope],
      {
        cwd: this.opts.co_root,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (!status.trim()) {
      this.opts.logger.info("no docs changes to commit", { scope });
      return null;
    }

    const paths = parseStatusPaths(status);
    if (paths.length === 0) {
      this.opts.logger.info("docs status non-empty but no parseable paths", {
        scope,
      });
      return null;
    }

    const message = await this.generateMessage(ctx, paths, resumeSessionId);
    const msgFile = path.join(
      cachePaths.taskDir(this.opts.cache_paths, ctx.task_id),
      "docs-commit.msg",
    );
    await fs.promises.mkdir(path.dirname(msgFile), { recursive: true });
    await fs.promises.writeFile(msgFile, message, "utf-8");

    const release = this.opts.docs_commit_mutex
      ? await this.opts.docs_commit_mutex.acquire()
      : null;
    let sha: string;
    try {
      try {
        execFileSync("git", ["add", "--", ...paths], {
          cwd: this.opts.co_root,
          stdio: "pipe",
        });
        // --only commits ONLY the listed paths, ignoring anything else
        // staged in the index. Combined with the scoped git-add above,
        // this keeps concurrent Worker commits free of cross-contamination
        // even though they share .git.
        execFileSync(
          "git",
          ["commit", "--only", "-F", msgFile, "--", ...paths],
          {
            cwd: this.opts.co_root,
            stdio: "pipe",
          },
        );
      } catch (err) {
        // Docs commit is best-effort: a failure here must NOT break the
        // worktree commit + completion report path. Log loudly and return
        // null so the caller treats it as "no docs commit produced".
        this.opts.logger.error("docs commit failed", {
          error: String(err),
          stderr: extractStderr(err),
          scope,
        });
        return null;
      }

      sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.opts.co_root,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } finally {
      release?.();
    }
    this.opts.logger.info("docs commit recorded", {
      sha: sha.slice(0, 8),
      scope,
      paths: paths.length,
    });
    return sha;
  }

  private async generateMessage(
    ctx: DocsCommitContext,
    paths: string[],
    resumeSessionId?: SessionId,
  ): Promise<string> {
    const fallback = `docs(${this.opts.worker_name}): auto-commit ${new Date()
      .toISOString()
      .slice(0, 10)}`;
    if (!this.opts.template_engine.has("worker-commit-message.md")) {
      return fallback;
    }
    const prompt = this.opts.template_engine.render("worker-commit-message.md", {
      changed_files: paths.map((f) => `  ${f}`).join("\n"),
      untracked_files: "",
      task_title: ctx.task_title,
      link: ctx.link,
    });
    const logPath = path.join(
      cachePaths.taskDir(this.opts.cache_paths, ctx.task_id),
      "docs-commit.log",
    );
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
      this.opts.logger.warn("docs commit message generation failed", {
        error: String(err),
      });
      return fallback;
    }
  }
}

function parseStatusPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.trim().split("\n")) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    if (code === "??") {
      paths.push(rest);
      continue;
    }
    if (rest.includes(" -> ")) {
      const [src, dst] = rest.split(" -> ");
      if (src) paths.push(src.trim());
      if (dst) paths.push(dst.trim());
    } else {
      paths.push(rest);
    }
  }
  return paths;
}

function extractStderr(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const e = err as { stderr?: Buffer | string };
    if (Buffer.isBuffer(e.stderr)) return e.stderr.toString("utf-8");
    if (typeof e.stderr === "string") return e.stderr;
  }
  return "";
}
