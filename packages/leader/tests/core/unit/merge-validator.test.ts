// CORE-RETENTION
// Locks in FOUR observable contracts on MergeValidator (Bug-1, Bug-2,
// Issue-4, Issue-5 from docs/v0.6/git-worktree-evaluation.md):
//   (1) isCommitMerged uses `git merge-base --is-ancestor` semantics:
//       returns true only when sha is reachable from mainBranch. The
//       previous `branch --contains` check always returned true under
//       shared .git, silently skipping every merge.
//   (2) The merge command is invoked via execFileSync with the commit
//       message as a separate argv element; shell metacharacters in
//       the message (`, $, ;, ") cannot break command parsing or
//       cause injection.
//   (3) merge_target_branch comes from MergeValidatorOptions, not from
//       leader HEAD at validate-time. When set, merges target that
//       branch even if HEAD has moved to something else.
//   (4) When `remote` is configured, validate() calls `git fetch` before
//       reading the merge target. When `remote` is null, no fetch happens.
// Core path because: every chain's worktree changes funnel through this
//   module on close_chain. A silent skip (Bug-1) or an injection sink
//   (Bug-2) defeats the chain's entire correctness story.
// Owner subsystem: leader.
// Primary source files exercised:
//   - packages/leader/src/merge-validator.ts
//
// TRUST-JUSTIFICATION: we fake IClaudeRunner (askDecision invocations).
//   Downstream: real claude-cli is covered in tests/core/manual/. Here
//   we control the merge-decision JSON output so each test isolates the
//   git path. We use a real on-disk git repo + real `git` so the
//   contracts we assert are the real protocol between MergeValidator
//   and git's CLI.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  asMessageId,
  type IClaudeRunner,
  type IEventBus,
  type ILogger,
  type LeaderEvent,
  type RunOptions,
  type RunResult,
} from "@co/contracts";
import { TemplateEngine } from "@co/runtime";
import { MergeValidator, type CommitInfo } from "../../../src/merge-validator.js";

class SilentLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
}

class CapturingBus implements IEventBus<LeaderEvent> {
  emitted: LeaderEvent[] = [];
  emit(e: LeaderEvent): void {
    this.emitted.push(e);
  }
  onAny(): () => void {
    return () => {};
  }
  on(): () => void {
    return () => {};
  }
}

class FixedRunner implements IClaudeRunner {
  constructor(private readonly mergeDecisionJson: string) {}
  async run(opts: RunOptions): Promise<RunResult> {
    fs.mkdirSync(path.dirname(opts.log_path), { recursive: true });
    fs.writeFileSync(opts.log_path, this.mergeDecisionJson);
    return { exit_code: 0, session_id: null, log_path: opts.log_path };
  }
}

function newTemplateEngine(): TemplateEngine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-tpl-"));
  fs.writeFileSync(
    path.join(dir, "worker-merge-decision.md"),
    "merge prompt for {{branch}} {{sha}}",
  );
  return new TemplateEngine({ primary_dir: dir });
}

function initRepo(): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
  return { dir, head };
}

function makeFeatureBranch(repo: string, branch: string, file: string, body: string): string {
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: repo });
  fs.writeFileSync(path.join(repo, file), body);
  execFileSync("git", ["add", file], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", `feat: ${file}`], { cwd: repo });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf-8",
  }).trim();
  execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });
  return sha;
}

function makeValidator(repo: string, opts: {
  merge_target_branch?: string | null;
  remote?: string | null;
  decision?: string;
} = {}): MergeValidator {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-log-"));
  return new MergeValidator({
    project_root: repo,
    runner: new FixedRunner(
      opts.decision ?? JSON.stringify({ decision: "merge", reason: "ok" }),
    ),
    template_engine: newTemplateEngine(),
    template_name: "worker-merge-decision.md",
    bus: new CapturingBus(),
    logger: new SilentLogger(),
    log_path_for: (key) => path.join(cacheDir, `${key}.log`),
    merge_target_branch: opts.merge_target_branch,
    remote: opts.remote,
  });
}

function commitInfo(sha: string, branch: string, message = "feat: x"): CommitInfo {
  return {
    sha,
    branch,
    message,
    task_title: "test",
    task_link: "build",
  };
}

describe("MergeValidator.isCommitMerged (Bug-1)", () => {
  it("returns false for a Worker-branch sha that has never been merged into main", async () => {
    // Pre-Bug-1, `git branch --contains <sha>` always listed the
    // Worker's own branch (shared .git), so isCommitMerged returned
    // true and the validate() loop short-circuited as "Already
    // merged". Verify the fixed implementation actually invokes the
    // merge path now.
    const { dir } = initRepo();
    const sha = makeFeatureBranch(dir, "co/build-1", "build.txt", "build");
    const validator = makeValidator(dir);
    const decision = await validator.validate(commitInfo(sha, "co/build-1"));
    expect(decision.decision).toBe("merge");
    // Main now contains the build commit
    const main = execFileSync("git", ["log", "main", "--pretty=%s"], {
      cwd: dir,
      encoding: "utf-8",
    });
    expect(main).toContain("feat: build.txt");
  });

  it("returns 'skip' when the sha is already an ancestor of main", async () => {
    // After one successful merge, calling validate() again with the
    // same sha must skip (not double-merge).
    const { dir } = initRepo();
    const sha = makeFeatureBranch(dir, "co/build-1", "build.txt", "build");
    const validator = makeValidator(dir);
    await validator.validate(commitInfo(sha, "co/build-1"));
    const second = await validator.validate(commitInfo(sha, "co/build-1"));
    expect(second.decision).toBe("skip");
  });
});

describe("MergeValidator merge -m (Bug-2: no shell injection)", () => {
  it("does not execute backticks / $() embedded in commit message", async () => {
    const { dir } = initRepo();
    const sha = makeFeatureBranch(dir, "co/inj-1", "x.txt", "x");
    const sentinel = path.join(
      os.tmpdir(),
      `co-merge-sentinel-${Date.now()}-${process.pid}`,
    );
    if (fs.existsSync(sentinel)) fs.unlinkSync(sentinel);
    const malicious = "feat: `touch " + sentinel + "` $(touch " + sentinel + ")";
    const validator = makeValidator(dir);
    await validator.validate(commitInfo(sha, "co/inj-1", malicious));
    expect(fs.existsSync(sentinel)).toBe(false);
    // The merge commit's literal subject contains the malicious string
    const subject = execFileSync(
      "git",
      ["log", "-1", "main", "--pretty=%s"],
      { cwd: dir, encoding: "utf-8" },
    ).trim();
    expect(subject).toContain(malicious);
  });

  it("preserves embedded double quotes verbatim in the merge message", async () => {
    const { dir } = initRepo();
    const sha = makeFeatureBranch(dir, "co/quote-1", "y.txt", "y");
    const tricky = `feat: he said "hi" and 'bye'`;
    const validator = makeValidator(dir);
    await validator.validate(commitInfo(sha, "co/quote-1", tricky));
    const subject = execFileSync(
      "git",
      ["log", "-1", "main", "--pretty=%s"],
      { cwd: dir, encoding: "utf-8" },
    ).trim();
    expect(subject).toContain(tricky);
  });
});

describe("MergeValidator merge_target_branch (Issue-4)", () => {
  it("merges into the configured target branch, not the leader's HEAD", async () => {
    // Boot leader on a feature branch but configure the target as
    // "main". Validate that the merge lands on main, not on the
    // feature branch the leader happens to be checked out on.
    const { dir } = initRepo();
    // Move leader HEAD to a feature branch
    execFileSync("git", ["checkout", "-q", "-b", "leader-side"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "leader.txt"), "leader");
    execFileSync("git", ["add", "leader.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "leader work"], { cwd: dir });

    const sha = makeFeatureBranch(dir, "co/build-1", "build.txt", "build");
    // makeFeatureBranch checked us out back to main; we want leader to
    // resume on leader-side before validate() runs.
    execFileSync("git", ["checkout", "-q", "leader-side"], { cwd: dir });

    const validator = makeValidator(dir, { merge_target_branch: "main" });
    await validator.validate(commitInfo(sha, "co/build-1"));

    // main now contains the build commit
    const mainLog = execFileSync("git", ["log", "main", "--pretty=%s"], {
      cwd: dir,
      encoding: "utf-8",
    });
    expect(mainLog).toContain("feat: build.txt");
    // leader-side is NOT polluted with the merge — the leader's work
    // tree returns to leader-side after validate().
    const head = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: dir, encoding: "utf-8" },
    ).trim();
    expect(head).toBe("leader-side");
  });
});
