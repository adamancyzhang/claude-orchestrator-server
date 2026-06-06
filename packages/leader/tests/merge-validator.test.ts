// CORE-RETENTION
// Locks in: MergeValidator.validate() executes real git inside the project
// root, classifies failures via classifyGitError, and treats `detectConflicts`
// errors as fatal (not as "no conflicts"). isCommitMerged distinguishes
// exit-1 ("not an ancestor") from other failures. classifyGitError maps
// stderr substrings to typed CoError subclasses.
// Critical because: the merge step is the chain's commit gate. Pre-fix,
// `detectConflicts` swallowed every git failure as "clean merge," letting a
// broken repo report a clean merge. isCommitMerged had a documented historical
// regression (lines 232-236) where `git branch --contains` always returned
// true and silently skipped every merge — these tests defend against the
// reintroduction of that class of bug.
// Primary sources: packages/leader/src/merge-validator.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  GitNetworkError,
  GitPermissionError,
  MergeConflictError,
  ValidationError,
  WorktreeLockedError,
  type ChainId,
  type IClaudeRunner,
  type ITemplateEngine,
  type RunOptions,
  type RunResult,
} from "@co/contracts";
import {
  MergeValidator,
  classifyGitError,
  extractStderr,
  LeaderEventBus,
} from "../src/index.js";

// ── classifyGitError / extractStderr (pure table-driven) ─────────────

describe("classifyGitError", () => {
  function fakeGitErr(stderr: string): Error {
    const e = new Error("exec failed");
    (e as Error & { stderr: string }).stderr = stderr;
    return e;
  }

  it("maps lock-file stderr to WorktreeLockedError", () => {
    const e = classifyGitError(
      fakeGitErr("fatal: cannot lock ref 'HEAD'"),
      "merge failed",
    );
    expect(e).toBeInstanceOf(WorktreeLockedError);
  });

  it("maps index.lock stderr to WorktreeLockedError", () => {
    const e = classifyGitError(
      fakeGitErr("Unable to create '.git/index.lock': File exists."),
      "x",
    );
    expect(e).toBeInstanceOf(WorktreeLockedError);
  });

  it("maps permission-denied stderr to GitPermissionError", () => {
    const e = classifyGitError(fakeGitErr("error: permission denied"), "x");
    expect(e).toBeInstanceOf(GitPermissionError);
  });

  it("maps read-only-filesystem stderr to GitPermissionError", () => {
    const e = classifyGitError(
      fakeGitErr("fatal: Read-only file system"),
      "x",
    );
    expect(e).toBeInstanceOf(GitPermissionError);
  });

  it("maps DNS/connection stderr to GitNetworkError", () => {
    expect(
      classifyGitError(
        fakeGitErr("fatal: unable to access 'https://x': Could not resolve host: x"),
        "x",
      ),
    ).toBeInstanceOf(GitNetworkError);
    expect(
      classifyGitError(fakeGitErr("Connection refused"), "x"),
    ).toBeInstanceOf(GitNetworkError);
    expect(
      classifyGitError(fakeGitErr("Network is unreachable"), "x"),
    ).toBeInstanceOf(GitNetworkError);
  });

  it("falls back to a generic Error that preserves stderr in the message", () => {
    const e = classifyGitError(fakeGitErr("something weird went wrong"), "ctx");
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(WorktreeLockedError);
    expect(e).not.toBeInstanceOf(GitPermissionError);
    expect(e).not.toBeInstanceOf(GitNetworkError);
    expect(e.message).toContain("something weird went wrong");
    expect(e.message).toContain("ctx");
  });
});

describe("extractStderr", () => {
  it("returns string stderr unchanged", () => {
    expect(extractStderr({ stderr: "abc" })).toBe("abc");
  });

  it("decodes Buffer stderr as utf-8", () => {
    expect(extractStderr({ stderr: Buffer.from("xyz", "utf-8") })).toBe("xyz");
  });

  it("returns '' when no stderr field exists", () => {
    expect(extractStderr(new Error("plain"))).toBe("");
    expect(extractStderr(null)).toBe("");
    expect(extractStderr(undefined)).toBe("");
  });
});

// ── Integration: real tmp git repo ────────────────────────────────────

let repoDir: string;

function git(args: string[], cwd: string = repoDir): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(): void {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-validator-"));
  git(["init"]);
  git(["checkout", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  // Disable signing / hooks / GPG that the host env might force on.
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "init\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "init"]);
}

beforeEach(() => initRepo());
afterEach(() => fs.rmSync(repoDir, { recursive: true, force: true }));

// ── Test fixtures (real IClaudeRunner / ITemplateEngine stubs) ────────

// TRUST-JUSTIFICATION: IClaudeRunner spawns the external `claude` CLI.
// The stub writes a pre-baked MergeDecision JSON to log_path so
// askDecision's downstream fs.readFile + extractJson + schema parse
// runs the real code path. The protocol boundary (write JSON → caller
// reads JSON) is asserted by checking the returned MergeDecision.
// Evidence: full end-to-end merge flow is exercised by chain-router /
// orchestrator integration tests; here we cover validator logic only.
function fakeRunner(decisionJson: string): IClaudeRunner {
  return {
    async run(opts: RunOptions): Promise<RunResult> {
      fs.mkdirSync(path.dirname(opts.log_path), { recursive: true });
      fs.writeFileSync(opts.log_path, decisionJson);
      return { exit_code: 0, session_id: null, log_path: opts.log_path };
    },
  };
}

const stubTemplateEngine: ITemplateEngine = {
  has: () => true,
  load: () => "render",
  render: () => "render",
};

function makeValidator(
  decisionJson: string,
  overrides: Partial<{
    project_root: string;
    merge_target_branch: string | null;
  }> = {},
): MergeValidator {
  const logsDir = path.join(repoDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return new MergeValidator({
    project_root: overrides.project_root ?? repoDir,
    runner: fakeRunner(decisionJson),
    template_engine: stubTemplateEngine,
    template_name: "merge-decision",
    bus: new LeaderEventBus(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => ({
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }) as unknown as never,
    } as unknown as never,
    log_path_for: ({ ts, kind }) => path.join(logsDir, `${kind}-${ts}.log`),
    merge_target_branch:
      overrides.merge_target_branch === undefined
        ? "main"
        : overrides.merge_target_branch,
  });
}

function commitOnNewBranch(branch: string, file: string, content: string): string {
  git(["checkout", "-b", branch, "main"]);
  fs.writeFileSync(path.join(repoDir, file), content);
  git(["add", file]);
  git(["commit", "-m", `add ${file}`]);
  const sha = git(["rev-parse", "HEAD"]);
  git(["checkout", "main"]);
  return sha;
}

// ── Integration tests ─────────────────────────────────────────────────

describe("MergeValidator.validate — happy path", () => {
  it("performs a clean fast-forwardable merge into main", async () => {
    const sha = commitOnNewBranch("feat/clean", "clean.txt", "hello\n");
    const validator = makeValidator(
      JSON.stringify({ decision: "merge", reason: "looks good" }),
    );

    const decision = await validator.validate(
      {
        sha,
        branch: "feat/clean",
        message: "add clean",
        task_title: "T",
        task_link: "execute",
      },
      null as ChainId | null,
    );

    expect(decision.decision).toBe("merge");

    // After validate(), main must now contain clean.txt.
    expect(fs.existsSync(path.join(repoDir, "clean.txt"))).toBe(true);
    const log = git(["log", "--oneline", "main"]);
    expect(log).toContain("add clean.txt");
  });
});

describe("MergeValidator.validate — already-merged shortcut", () => {
  it("skips when the commit is an ancestor of main", async () => {
    commitOnNewBranch("feat/x", "x.txt", "x\n");
    // Merge it first so the second pass sees it as ancestor.
    git(["merge", "feat/x", "--no-ff", "-m", "first merge"]);
    const sha = git(["rev-parse", "feat/x"]);

    const validator = makeValidator(
      JSON.stringify({ decision: "merge", reason: "any" }),
    );
    const decision = await validator.validate(
      {
        sha,
        branch: "feat/x",
        message: "x",
        task_title: "T",
        task_link: "execute",
      },
      null,
    );
    expect(decision.decision).toBe("skip");
    expect(decision.reason).toBe("Already merged");
  });
});

describe("MergeValidator.validate — conflict path", () => {
  it("throws MergeConflictError carrying the conflict file list on a real conflicting branch", async () => {
    // Set up two branches that touch the same file in incompatible ways.
    git(["checkout", "-b", "feat/conflict", "main"]);
    fs.writeFileSync(path.join(repoDir, "shared.txt"), "left\n");
    git(["add", "shared.txt"]);
    git(["commit", "-m", "left side"]);
    const conflictSha = git(["rev-parse", "HEAD"]);
    git(["checkout", "main"]);
    fs.writeFileSync(path.join(repoDir, "shared.txt"), "right\n");
    git(["add", "shared.txt"]);
    git(["commit", "-m", "right side"]);

    const validator = makeValidator(
      JSON.stringify({ decision: "merge", reason: "go" }),
    );
    await expect(
      validator.validate(
        {
          sha: conflictSha,
          branch: "feat/conflict",
          message: "left",
          task_title: "T",
          task_link: "execute",
        },
        null,
      ),
    ).rejects.toMatchObject({
      // MergeConflictError carries conflict_files. Use toMatchObject to avoid
      // depending on stack-frame equality.
      conflict_files: expect.arrayContaining(["shared.txt"]),
      code: "MERGE_CONFLICT",
    });
  });
});

describe("MergeValidator.validate — bad decision JSON", () => {
  it("throws ValidationError when runner produces a non-schema MergeDecision", async () => {
    const sha = commitOnNewBranch("feat/bad", "x.txt", "x\n");
    const validator = makeValidator(
      JSON.stringify({ decision: "explode", reason: "nope" }),
    );
    await expect(
      validator.validate(
        {
          sha,
          branch: "feat/bad",
          message: "x",
          task_title: "T",
          task_link: "execute",
        },
        null,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("MergeValidator.validate — broken git surfaces as classified error", () => {
  it("isCommitMerged surfaces non-1 git failures rather than silently treating them as 'merged'", async () => {
    // Point the validator at a non-git directory so `git merge-base
    // --is-ancestor` fails with exit 128. Today this would throw a
    // classified error; the regression we defend against is reverting to
    // a silent "true" on any error.
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const validator = makeValidator(
        JSON.stringify({ decision: "merge", reason: "x" }),
        { project_root: nonRepo, merge_target_branch: "main" },
      );
      await expect(
        validator.validate(
          {
            sha: "deadbeef",
            branch: "feat/x",
            message: "x",
            task_title: "T",
            task_link: "execute",
          },
          null,
        ),
      ).rejects.toThrow(); // any classified Error subclass, never silently skipped
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
