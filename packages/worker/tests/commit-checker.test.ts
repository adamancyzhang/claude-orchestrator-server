// CORE-RETENTION
// Locks in: CommitChecker.check() against a real tmp git repo — returns null
// when nothing is dirty, commits explicit paths only (never -A), surfaces a
// CommitFailedError when `git commit` itself fails, and filters
// orchestrator-seeded paths (CLAUDE.md / .claude-orchestrator/agents/ /
// .claude/skills/) out of the commit set.
// Critical because: a stray `-A` (the pre-A1 implementation) would sweep
// .env or token.json into the worktree commit; conversely, a silent null
// return on failure would let chain-router proceed with no commit envelope
// and skip MergeValidator for the link.
// Primary sources: packages/worker/src/commit-checker.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  asInstanceId,
  asTaskId,
  CommitFailedError,
  type IClaudeRunner,
  type ILogger,
  type ITemplateEngine,
  type RunOptions,
  type RunResult,
} from "@co/contracts";
import { CommitChecker } from "../src/commit-checker.js";

let repoDir: string;
let projectsRoot: string;

function git(args: string[], cwd: string = repoDir): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-commit-"));
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "co-commit-projects-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoDir, "initial.txt"), "x\n");
  git(["add", "initial.txt"]);
  git(["commit", "-m", "init"]);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(projectsRoot, { recursive: true, force: true });
});

const SILENT_LOGGER: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT_LOGGER,
} as unknown as ILogger;

// TRUST-JUSTIFICATION: IClaudeRunner spawns the `claude` CLI. Stub writes
// a one-line commit message to the log file so CommitChecker's real
// `fs.promises.readFile + trim().split + slice(0,72)` runs. The protocol
// contract — "runner writes some text, we use the first line" — is
// asserted by checking that the commit message starts with our stub's
// first line.
function fakeRunner(message: string): IClaudeRunner {
  return {
    async run(opts: RunOptions): Promise<RunResult> {
      fs.mkdirSync(path.dirname(opts.log_path), { recursive: true });
      fs.writeFileSync(opts.log_path, message + "\n", "utf-8");
      return { exit_code: 0, session_id: null, log_path: opts.log_path };
    },
  };
}

const STUB_TEMPLATE_ENGINE: ITemplateEngine = {
  has: (name) => name === "worker-commit-message.md",
  load: () => "prompt",
  render: () => "prompt",
};

function makeChecker(runner: IClaudeRunner = fakeRunner("feat: thing")): CommitChecker {
  return new CommitChecker({
    worktree_path: repoDir,
    runner,
    template_engine: STUB_TEMPLATE_ENGINE,
    logger: SILENT_LOGGER,
    cache_paths: {
      projects_root: projectsRoot,
      leader_instance_id: asInstanceId("leader-test"),
    },
    worker_name: "T",
  });
}

const CTX = {
  link: "execute" as const,
  task_id: asTaskId("task-1"),
  task_title: "do thing",
  task_description: "details",
};

describe("CommitChecker.check — clean worktree", () => {
  it("returns null when there are no changes to commit", async () => {
    const cc = makeChecker();
    const result = await cc.check(CTX);
    expect(result).toBeNull();
  });
});

describe("CommitChecker.check — dirty worktree", () => {
  it("commits an untracked file and returns the sha + changed_files / untracked_files", async () => {
    fs.writeFileSync(path.join(repoDir, "new.txt"), "hello\n");
    const cc = makeChecker(fakeRunner("feat: add new"));
    const result = await cc.check(CTX);
    expect(result).not.toBeNull();
    expect(result?.message).toBe("feat: add new");
    expect(result?.untracked_files).toEqual(["new.txt"]);
    expect(result?.changed_files).toEqual([]);
    // sha must be a valid 40-char hex string.
    expect(result?.sha).toMatch(/^[a-f0-9]{40}$/);
    // HEAD log carries the new commit.
    expect(git(["log", "-1", "--pretty=%s"])).toBe("feat: add new");
  });

  it("commits a modified tracked file (changed_files non-empty)", async () => {
    fs.writeFileSync(path.join(repoDir, "initial.txt"), "modified\n");
    const cc = makeChecker(fakeRunner("fix: bug"));
    const result = await cc.check(CTX);
    expect(result?.changed_files.length).toBeGreaterThan(0);
    expect(result?.changed_files[0]).toMatch(/initial\.txt$/);
  });
});

describe("CommitChecker.check — orchestrator-seeded paths are skipped", () => {
  it("filters CLAUDE.md / .claude-orchestrator/agents/ / .claude/skills/ out of the commit set", async () => {
    // Create the seeded paths.
    fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "seeded\n");
    fs.mkdirSync(path.join(repoDir, ".claude-orchestrator", "agents"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoDir, ".claude-orchestrator", "agents", "x.md"),
      "x\n",
    );
    fs.mkdirSync(path.join(repoDir, ".claude", "skills"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".claude", "skills", "y.md"), "y\n");
    // Plus one legitimate change.
    fs.writeFileSync(path.join(repoDir, "feature.ts"), "real change\n");

    const cc = makeChecker();
    const result = await cc.check(CTX);
    expect(result).not.toBeNull();
    // CLAUDE.md + seeded dirs must NOT appear in the commit's tree.
    const lsFiles = git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
    expect(lsFiles).toContain("feature.ts");
    expect(lsFiles).toContain("initial.txt");
    expect(lsFiles).not.toContain("CLAUDE.md");
    expect(lsFiles).not.toContain(".claude-orchestrator/agents/x.md");
    expect(lsFiles).not.toContain(".claude/skills/y.md");
  });
});

describe("CommitChecker.check — git failure surfaces as CommitFailedError", () => {
  it("throws CommitFailedError when git commit itself fails (e.g. pre-commit hook)", async () => {
    // Install a pre-commit hook that refuses every commit.
    const hookDir = path.join(repoDir, ".git", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    const hookPath = path.join(hookDir, "pre-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\necho 'no'\nexit 1\n");
    fs.chmodSync(hookPath, 0o755);
    // Make a change.
    fs.writeFileSync(path.join(repoDir, "thing.txt"), "blocked\n");

    const cc = makeChecker();
    await expect(cc.check(CTX)).rejects.toBeInstanceOf(CommitFailedError);
  });
});
