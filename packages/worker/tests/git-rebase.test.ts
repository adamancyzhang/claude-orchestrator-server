// CORE-RETENTION
// Locks in: preTaskRebase's behavior against real git:
//   - skips when target_sha is already an ancestor of HEAD (no rebase)
//   - succeeds when target_sha is on a divergent ancestor of HEAD's
//     base — leaving the worktree on top of target_sha
//   - throws RebaseConflictError with .conflict_files populated when
//     git rebase fails on overlapping edits
//   - throws a generic Error (NOT RebaseConflictError) when git
//     rebase fails for non-conflict reasons (e.g., unknown sha)
//   - missing/unreachable fetch is non-fatal — function proceeds to
//     rebase using the local object database
// Critical because: this is the one place where worker mutates its
// branch BEFORE Claude runs. A regression that misclassifies a
// non-conflict failure as RebaseConflictError feeds the leader's
// chain-router a fake feedback decision; a regression that misses a
// real conflict lets the worker proceed with a half-rebased worktree.
// Real git subprocess testing is mandatory here — the spawn protocol
// IS the SUT.
// Primary sources: packages/worker/src/git-rebase.ts

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RebaseConflictError, type ILogger } from "@co/contracts";
import { preTaskRebase } from "../src/git-rebase.js";

let repo: string;

// SILENT_LOGGER is a real test data structure (not a mock) — no
// TRUST-JUSTIFICATION needed. We could capture logs to assert on but
// the test asserts on git's observable state instead.
const SILENT_LOGGER: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT_LOGGER,
} as unknown as ILogger;

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function gitNoOut(args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    stdio: "pipe",
  });
}

function rev(ref: string): string {
  return git(["rev-parse", ref]).trim();
}

function writeFile(name: string, body: string): void {
  fs.writeFileSync(path.join(repo, name), body, "utf-8");
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "co-rebase-"));
  gitNoOut(["init", "-q"]);
  gitNoOut(["checkout", "-b", "main"]);
  gitNoOut(["config", "user.email", "test@example.com"]);
  gitNoOut(["config", "user.name", "Test"]);
  gitNoOut(["config", "commit.gpgsign", "false"]);
  writeFile("README.md", "# repo\n");
  gitNoOut(["add", "README.md"]);
  gitNoOut(["commit", "-q", "-m", "initial"]);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("preTaskRebase — ancestor skip", () => {
  it("skips when target_sha is already an ancestor of HEAD (no worktree change)", async () => {
    const baseSha = rev("HEAD");

    // Add another commit on top of base so we have a HEAD ≠ base.
    writeFile("a.txt", "a\n");
    gitNoOut(["add", "a.txt"]);
    gitNoOut(["commit", "-q", "-m", "add a"]);
    const headBefore = rev("HEAD");

    await preTaskRebase({
      worktree_path: repo,
      target_sha: baseSha,
      git_remote: null,
      logger: SILENT_LOGGER,
    });

    // HEAD unchanged.
    expect(rev("HEAD")).toBe(headBefore);
  });
});

describe("preTaskRebase — success path", () => {
  it("rebases HEAD onto a divergent target sha", async () => {
    // Create a divergence:
    //   main:  initial -> A (HEAD)
    //   side:  initial -> B (target_sha)
    // After rebase: HEAD ancestry includes B then A as the top.

    // commit A on main
    writeFile("a.txt", "a\n");
    gitNoOut(["add", "a.txt"]);
    gitNoOut(["commit", "-q", "-m", "A"]);

    // commit B on side (no overlap with A)
    gitNoOut(["checkout", "-q", "-b", "side", "HEAD~1"]);
    writeFile("b.txt", "b\n");
    gitNoOut(["add", "b.txt"]);
    gitNoOut(["commit", "-q", "-m", "B"]);
    const sideSha = rev("HEAD");

    gitNoOut(["checkout", "-q", "main"]);
    const headBefore = rev("HEAD");

    await preTaskRebase({
      worktree_path: repo,
      target_sha: sideSha,
      git_remote: null,
      logger: SILENT_LOGGER,
    });

    // HEAD must be a new commit (A rebased on top of B), with B in its history.
    expect(rev("HEAD")).not.toBe(headBefore);
    // sideSha must be reachable from HEAD now.
    expect(() =>
      git(["merge-base", "--is-ancestor", sideSha, "HEAD"]),
    ).not.toThrow();
    // a.txt and b.txt must both exist.
    expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(true);
  });
});

describe("preTaskRebase — conflict", () => {
  it("throws RebaseConflictError with conflict_files when rebase produces unmerged paths", async () => {
    // Both branches modify the same file in incompatible ways.
    writeFile("conflict.txt", "main version\n");
    gitNoOut(["add", "conflict.txt"]);
    gitNoOut(["commit", "-q", "-m", "main edits conflict.txt"]);

    gitNoOut(["checkout", "-q", "-b", "side", "HEAD~1"]);
    writeFile("conflict.txt", "side version\n");
    gitNoOut(["add", "conflict.txt"]);
    gitNoOut(["commit", "-q", "-m", "side edits conflict.txt"]);
    const sideSha = rev("HEAD");

    gitNoOut(["checkout", "-q", "main"]);

    await expect(
      preTaskRebase({
        worktree_path: repo,
        target_sha: sideSha,
        git_remote: null,
        logger: SILENT_LOGGER,
      }),
    ).rejects.toBeInstanceOf(RebaseConflictError);

    // After the throw, repo must NOT be left in mid-rebase state
    // (the helper calls `git rebase --abort`).
    expect(fs.existsSync(path.join(repo, ".git", "rebase-merge"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".git", "rebase-apply"))).toBe(false);

    // Re-run to capture the error and inspect conflict_files.
    try {
      await preTaskRebase({
        worktree_path: repo,
        target_sha: sideSha,
        git_remote: null,
        logger: SILENT_LOGGER,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RebaseConflictError);
      const rc = err as RebaseConflictError;
      expect(rc.conflict_files).toContain("conflict.txt");
    }
  });
});

describe("preTaskRebase — non-conflict failure", () => {
  it("throws a generic Error (NOT RebaseConflictError) when target_sha does not exist", async () => {
    const headBefore = rev("HEAD");
    const fakeSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    await expect(
      preTaskRebase({
        worktree_path: repo,
        target_sha: fakeSha,
        git_remote: null,
        logger: SILENT_LOGGER,
      }),
    ).rejects.not.toBeInstanceOf(RebaseConflictError);

    // HEAD untouched.
    expect(rev("HEAD")).toBe(headBefore);
  });
});

describe("preTaskRebase — optional fetch is non-fatal", () => {
  it("proceeds to rebase when git_remote is set but fetch fails (sha already local)", async () => {
    // Setup: create commit B on side, then point HEAD back to main.
    writeFile("a.txt", "a\n");
    gitNoOut(["add", "a.txt"]);
    gitNoOut(["commit", "-q", "-m", "A"]);

    gitNoOut(["checkout", "-q", "-b", "side", "HEAD~1"]);
    writeFile("b.txt", "b\n");
    gitNoOut(["add", "b.txt"]);
    gitNoOut(["commit", "-q", "-m", "B"]);
    const sideSha = rev("HEAD");

    gitNoOut(["checkout", "-q", "main"]);

    // The "nonexistent" remote will make fetch fail — but the sha is
    // already in the local object database, so rebase still succeeds.
    await preTaskRebase({
      worktree_path: repo,
      target_sha: sideSha,
      git_remote: "definitely-nonexistent-remote",
      logger: SILENT_LOGGER,
    });

    // Rebase succeeded — sideSha is now an ancestor of HEAD.
    expect(() =>
      git(["merge-base", "--is-ancestor", sideSha, "HEAD"]),
    ).not.toThrow();
  });
});
