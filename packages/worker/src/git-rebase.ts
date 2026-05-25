import { execFileSync } from "node:child_process";
import { RebaseConflictError, type ILogger } from "@co/contracts";

export interface PreTaskRebaseArgs {
  /** Worktree directory where the rebase runs. */
  worktree_path: string;
  /** Target sha to rebase onto. */
  target_sha: string;
  /**
   * Optional git remote name. When set, the function attempts a
   * best-effort `git fetch <remote> <sha>` before rebasing — useful
   * when the worker operates against an out-of-process remote (rare).
   * Failure to fetch is non-fatal: the sha is usually already in the
   * shared `.git`.
   */
  git_remote: string | null;
  logger: ILogger;
}

/**
 * Rebase the Worker's own branch onto the immediate predecessor
 * link's commit so the in-progress task sees the upstream artifacts
 * in git.
 *
 * Behavior:
 * - If targetSha is already an ancestor of HEAD, skip (no rebase).
 * - If git_remote is set, best-effort fetch the target sha; failure
 *   to fetch is non-fatal.
 * - Run `git rebase <targetSha>`. On success: log info, return.
 * - On rebase failure: gather unmerged paths via
 *   `git diff --name-only --diff-filter=U`, then `git rebase --abort`
 *   to leave the worktree clean.
 *     - If unmerged paths were found, throw `RebaseConflictError`.
 *     - Otherwise throw the original git error (wrapped if it wasn't
 *       an Error subclass) so the caller can log and proceed without
 *       rebase rather than block the chain.
 */
export async function preTaskRebase(args: PreTaskRebaseArgs): Promise<void> {
  const { worktree_path, target_sha, git_remote, logger } = args;

  // Skip when the worker branch already contains targetSha. Avoids
  // the "rebase noop" that still touches the worktree.
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", target_sha, "HEAD"], {
      cwd: worktree_path,
      stdio: ["pipe", "pipe", "pipe"],
    });
    logger.debug("pre-task rebase skipped (ancestor)", {
      target: target_sha.slice(0, 8),
    });
    return;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 1) {
      // unexpected; fall through and attempt rebase anyway
      logger.debug("merge-base --is-ancestor probe failed", {
        error: String(err),
      });
    }
  }

  // Optional fetch when remote is configured. Failure to fetch is
  // non-fatal — the sha is usually already in shared .git.
  if (git_remote) {
    try {
      execFileSync("git", ["fetch", git_remote, target_sha], {
        cwd: worktree_path,
        stdio: "pipe",
      });
    } catch (err) {
      logger.debug("pre-task fetch failed (non-fatal)", {
        error: String(err),
      });
    }
  }

  try {
    execFileSync("git", ["rebase", target_sha], {
      cwd: worktree_path,
      stdio: "pipe",
    });
    logger.info("pre-task rebase succeeded", {
      target: target_sha.slice(0, 8),
    });
  } catch (err) {
    // Check whether rebase is mid-conflict — diagnosed via non-empty
    // unmerged paths.
    let conflicts: string[] = [];
    try {
      const out = execFileSync(
        "git",
        ["diff", "--name-only", "--diff-filter=U"],
        {
          cwd: worktree_path,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      conflicts = out.split("\n").filter(Boolean);
    } catch {
      // ignore
    }
    try {
      execFileSync("git", ["rebase", "--abort"], {
        cwd: worktree_path,
        stdio: "pipe",
      });
    } catch {
      // ignore: state may already be clean
    }
    if (conflicts.length > 0) {
      throw new RebaseConflictError(
        `rebase onto ${target_sha.slice(0, 8)} conflicted`,
        conflicts,
        err,
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
