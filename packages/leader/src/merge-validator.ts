import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { extractJson } from "@co/runtime";
import {
  GitNetworkError,
  GitPermissionError,
  MergeConflictError,
  MergeDecisionSchema,
  ValidationError,
  WorktreeLockedError,
  type ChainId,
  type IClaudeRunner,
  type IEventBus,
  type IHookEngine,
  type ILogger,
  type ITemplateEngine,
  type LeaderEvent,
  type MergeDecision,
  type TaskLink,
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
  /**
   * Optional lifecycle-hook engine. When provided, MergeValidator fires
   * `merge_decision_made` after each MergeDecision is parsed so operators
   * can subscribe to merge outcomes via global config `hooks.*`.
   */
  hooks?: IHookEngine;
  /**
   * Optional ChainAudit. When set, MergeValidator records
   * `merge_validation_started` / `merge_validation_completed` /
   * `merge_failure` events per (chain, link) so audit.jsonl carries
   * the full merge timeline (DD 09 §4.2).
   */
  chain_audit?: import("./chain-audit.js").ChainAudit;
  logger: ILogger;
  /**
   * Builds the on-disk log path for each validate() invocation. Receives
   * the chain id, the link being merged, a timestamp, and a `kind`
   * discriminator (`merge` for per-link askDecision logs, `final` for
   * aggregate close-chain logs). DD 09 §5.3 specifies the layout
   * `merges/chain-<chain_id>/merge-<link>-<ts>.log` and
   * `merges/chain-<chain_id>/final-<ts>.log`.
   */
  log_path_for: (args: {
    chain_id: ChainId | null;
    link: TaskLink | null;
    ts: string;
    kind: "merge" | "final";
  }) => string;
  /**
   * Explicit branch to merge into. When unset, falls back to leader
   * HEAD captured at validate() time. Set this from
   * `ResolvedConfig.git.merge_target_branch` so a feature-branch
   * orchestrator session can still merge to `main`.
   */
  merge_target_branch?: string | null;
  /**
   * Remote name to fetch before merging. `null` (or unset) skips the
   * fetch entirely. Defaults to "origin" via config-loader.
   */
  remote?: string | null;
}

export class MergeValidator {
  constructor(private readonly opts: MergeValidatorOptions) {}

  async validate(
    commit: CommitInfo,
    chainId: ChainId | null,
    mode: "close" | "spawn" = "close",
  ): Promise<MergeDecision> {
    if (chainId && this.opts.chain_audit) {
      void this.opts.chain_audit
        .record(chainId, {
          event: "merge_validation_started",
          link: (commit.task_link as TaskLink) || null,
          payload: { sha: commit.sha, branch: commit.branch, mode },
        })
        .catch(() => undefined);
    }
    const mainBranch =
      this.opts.merge_target_branch ??
      this.execGit(["rev-parse", "--abbrev-ref", "HEAD"]);

    // Optional fetch so `isCommitMerged` and the actual merge see the
    // freshest main. When remote is unset we stay purely local — same
    // behavior as pre-fix code.
    if (this.opts.remote) {
      try {
        this.execGit(["fetch", this.opts.remote, mainBranch]);
      } catch (err) {
        // Treat network failures as fatal for this validation attempt.
        // pushMergeConflictRetries will surface the failure for human
        // intervention.
        throw classifyGitError(err, "fetch failed");
      }
    }

    if (this.isCommitMerged(commit.sha, mainBranch)) {
      return MergeDecisionSchema.parse({
        decision: "skip",
        reason: "Already merged",
      });
    }

    const decision = await this.askDecision(commit, mainBranch, chainId);

    if (this.opts.hooks) {
      void this.opts.hooks.fire({
        type: "merge_decision_made",
        env: {
          CO_DECISION: decision.decision,
          CO_BRANCH: commit.branch,
          CO_REASON: decision.reason,
        },
      });
    }

    if (decision.decision === "merge") {
      const currentBranch = this.execGit([
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      try {
        this.execGit(["checkout", mainBranch]);
        const mergeMsg = `Merge ${commit.branch}: ${commit.message}`;
        this.execGit(["merge", commit.branch, "--no-ff", "-m", mergeMsg]);
        this.opts.bus.emit({
          type: "debug_info",
          message: `merged: ${commit.branch} -> ${mainBranch} (mode=${mode})`,
        });
      } catch (err) {
        // Abort and classify. Conflict path produces MergeConflictError
        // which chain-router routes to pushMergeConflictRetries. Other
        // classes (lock / permission / network) skip retry and go to
        // chain-audit's merge_failed_other path.
        try {
          this.execGit(["merge", "--abort"]);
        } catch {
          // ignore abort failure — the merge state may already be clean
        }
        const conflicts = this.detectConflicts();
        try {
          this.execGit(["checkout", currentBranch]);
        } catch {
          // ignore: checkout failure is recoverable at the next attempt
        }
        if (conflicts.length > 0) {
          this.opts.logger.warn("merge conflict — aborted", {
            branch: commit.branch,
            conflicts,
          });
          throw new MergeConflictError(
            `merge ${commit.branch} conflicted`,
            conflicts,
          );
        }
        const classified = classifyGitError(err, `merge ${commit.branch} failed`);
        this.opts.logger.warn("merge failed (non-conflict)", {
          branch: commit.branch,
          error_class: classified.constructor.name,
          stderr: extractStderr(err),
        });
        throw classified;
      }
      this.execGit(["checkout", currentBranch]);
    }

    if (chainId && this.opts.chain_audit) {
      void this.opts.chain_audit
        .record(chainId, {
          event: "merge_validation_completed",
          link: (commit.task_link as TaskLink) || null,
          payload: {
            sha: commit.sha,
            branch: commit.branch,
            decision: decision.decision,
            mode,
          },
        })
        .catch(() => undefined);
    }

    return decision;
  }

  private async askDecision(
    commit: CommitInfo,
    mainBranch: string,
    chainId: ChainId | null,
  ): Promise<MergeDecision> {
    const prompt = this.opts.template_engine.render(this.opts.template_name, {
      branch: commit.branch,
      sha: commit.sha,
      message: commit.message,
      task_title: commit.task_title,
      task_link: commit.task_link,
      main_branch: mainBranch,
    });
    const logPath = this.opts.log_path_for({
      chain_id: chainId,
      link: (commit.task_link as TaskLink) || null,
      ts: Date.now().toString(36),
      kind: "merge",
    });
    await this.opts.runner.run({ prompt, log_path: logPath });
    const output = await fs.promises.readFile(logPath, "utf-8");
    const parsed = MergeDecisionSchema.safeParse(JSON.parse(extractJson(output)));
    if (!parsed.success) {
      throw new ValidationError("merge decision JSON invalid", parsed.error);
    }
    return parsed.data;
  }

  /**
   * True iff `sha` is an ancestor of `mainBranch`. Uses `git merge-base
   * --is-ancestor` which returns exit 0 on yes, 1 on no, other codes on
   * error. The previous implementation `git branch --contains <sha>`
   * was broken: with shared `.git`, every Worker's per-name branch
   * always lists the sha, so the function returned true unconditionally
   * and silently skipped every merge.
   */
  private isCommitMerged(sha: string, mainBranch: string): boolean {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, mainBranch], {
        cwd: this.opts.project_root,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 1) return false;
      // Unknown errors (sha missing, mainBranch missing, repo broken)
      // bubble up so the caller surfaces a real validation failure
      // instead of silently treating "couldn't determine" as merged.
      throw classifyGitError(err, "merge-base failed");
    }
  }

  private detectConflicts(): string[] {
    try {
      const out = this.execGit(["diff", "--name-only", "--diff-filter=U"]);
      return out.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  private execGit(args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.opts.project_root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }
}

/**
 * Map a raw exec error to one of the typed git error classes so
 * chain-router can branch on type (conflict → retry, lock → wait,
 * permission/network → halt with operator alert).
 */
function classifyGitError(err: unknown, fallback: string): Error {
  const stderr = extractStderr(err);
  const lower = stderr.toLowerCase();
  if (/cannot lock ref|index\.lock|unable to create.*\.lock/.test(lower)) {
    return new WorktreeLockedError(fallback, stderr, err);
  }
  if (/permission denied|read-only file system/.test(lower)) {
    return new GitPermissionError(fallback, stderr, err);
  }
  if (
    /could not resolve host|connection (refused|timed out)|cannot access|network is unreachable/
      .test(lower)
  ) {
    return new GitNetworkError(fallback, stderr, err);
  }
  // Fallback: surface as generic Error preserving stderr for the caller
  // to log. Chain-router's catch-all path records it as
  // merge_failed_other in chain-audit.
  const wrapped = new Error(`${fallback}: ${stderr || String(err)}`);
  (wrapped as Error & { cause?: unknown }).cause = err;
  return wrapped;
}

function extractStderr(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const e = err as { stderr?: Buffer | string };
    if (Buffer.isBuffer(e.stderr)) return e.stderr.toString("utf-8");
    if (typeof e.stderr === "string") return e.stderr;
  }
  return "";
}
