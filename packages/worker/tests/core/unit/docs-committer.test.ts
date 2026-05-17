// CORE-RETENTION
// Locks in TWO observable contracts:
//   (1) WorkerDocsCommitter commits ONLY docs/<worker_name>/<paths> in
//       the CO root, using `git commit --only -- <paths>`. With the
//       shared CO root .git, this is the safety net that prevents
//       cross-Worker contamination when multiple Workers commit
//       concurrently: A's resulting commit tree must contain only A's
//       paths, never any of B's, even if B's `git add` raced into the
//       index between A's `git add` and A's `git commit`.
//   (2) Returns null when there are no docs changes — the upstream
//       chain-router treats a null as "no docs hash to propagate" and
//       must keep functioning unchanged. We also verify the commit sha
//       returned matches the actual HEAD on success.
// Core path because: this is the new module that enables the v0.6
//   CI flow's docs-tracking story. If the --only scoping breaks, every
//   Worker's docs commit can include unrelated paths from concurrent
//   Workers, polluting the CO root history.
// Owner subsystem: worker.
// Primary source files exercised:
//   - packages/worker/src/docs-committer.ts
//
// TRUST-JUSTIFICATION: this test fakes IClaudeRunner (commit message
//   generation) and uses a real on-disk git repo + real `git` binary.
//   The protocol contract between WorkerDocsCommitter and git is the
//   exact argv we pass to `git commit --only` — we verify the resulting
//   commit's tree contains only the expected paths via `git show --stat`.
// Downstream: real claude-cli is covered in tests/core/manual/.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  asInstanceId,
  asTaskId,
  type IClaudeRunner,
  type ILogger,
  type RunOptions,
  type RunResult,
} from "@co/contracts";
import { TemplateEngine } from "@co/runtime";
import { WorkerDocsCommitter } from "../../../src/docs-committer.js";

class SilentLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
}

class FixedRunner implements IClaudeRunner {
  constructor(private readonly out: string) {}
  async run(opts: RunOptions): Promise<RunResult> {
    fs.mkdirSync(path.dirname(opts.log_path), { recursive: true });
    fs.writeFileSync(opts.log_path, this.out);
    return { exit_code: 0, session_id: null, log_path: opts.log_path };
  }
}

function newTemplateEngine(): TemplateEngine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-tpl-"));
  fs.writeFileSync(
    path.join(dir, "worker-commit-message.md"),
    "msg for {{task_title}} ({{link}})",
  );
  return new TemplateEngine({ primary_dir: dir });
}

function initCoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-root-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "co-root");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

function makeCommitter(
  coRoot: string,
  workerName: string,
  message: string,
): WorkerDocsCommitter {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docs-cache-"));
  return new WorkerDocsCommitter({
    co_root: coRoot,
    worker_name: workerName,
    runner: new FixedRunner(message),
    template_engine: newTemplateEngine(),
    cache_paths: {
      projects_root: projectsRoot,
      leader_instance_id: asInstanceId("leader-1"),
    },
    logger: new SilentLogger(),
  });
}

function writeDoc(coRoot: string, worker: string, relPath: string, content: string): void {
  const abs = path.join(coRoot, "docs", worker, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function listCommitFiles(coRoot: string, sha: string): string[] {
  return execFileSync(
    "git",
    ["show", "--name-only", "--pretty=format:", sha],
    {
      cwd: coRoot,
      encoding: "utf-8",
    },
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("WorkerDocsCommitter", () => {
  it("returns null when docs/<worker_name>/ has no changes", async () => {
    const coRoot = initCoRoot();
    // Worker dir doesn't exist at all
    const committer = makeCommitter(coRoot, "Tom", "docs: nothing");
    const sha = await committer.commitIfChanged({
      task_id: asTaskId("task-1"),
      link: "plan",
      task_title: "plan a thing",
    });
    expect(sha).toBeNull();
  });

  it("commits scoped docs and returns the resulting HEAD sha", async () => {
    const coRoot = initCoRoot();
    writeDoc(coRoot, "Tom", "2026-05-17/plan-chain-1.md", "plan notes");
    const committer = makeCommitter(coRoot, "Tom", "docs(Tom): plan notes");
    const sha = await committer.commitIfChanged({
      task_id: asTaskId("task-1"),
      link: "plan",
      task_title: "plan a thing",
    });
    expect(sha).toBeTruthy();
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: coRoot,
      encoding: "utf-8",
    }).trim();
    expect(sha).toBe(head);
    const files = listCommitFiles(coRoot, sha!);
    expect(files).toEqual(["docs/Tom/2026-05-17/plan-chain-1.md"]);
  });

  it("does NOT pull in another worker's staged docs even after a concurrent `git add`", async () => {
    // Simulates the concurrency hazard: worker B has already staged its
    // own docs (e.g. its own commit is mid-flight) before worker A's
    // commit fires. With `git commit --only -- docs/A/...`, worker A's
    // resulting tree must contain only A's path, never B's.
    const coRoot = initCoRoot();
    writeDoc(coRoot, "Tom", "2026-05-17/plan.md", "Tom notes");
    writeDoc(coRoot, "Bob", "2026-05-17/build.md", "Bob notes");
    // Manually stage Bob's file so the index already has Bob's path
    // when Tom's committer runs.
    execFileSync("git", ["add", "docs/Bob/2026-05-17/build.md"], {
      cwd: coRoot,
    });

    const tomCommitter = makeCommitter(coRoot, "Tom", "docs(Tom): plan");
    const tomSha = await tomCommitter.commitIfChanged({
      task_id: asTaskId("task-tom"),
      link: "plan",
      task_title: "plan",
    });
    expect(tomSha).toBeTruthy();
    const tomFiles = listCommitFiles(coRoot, tomSha!);
    expect(tomFiles).toEqual(["docs/Tom/2026-05-17/plan.md"]);

    // Bob's file is still uncommitted on HEAD — Tom's commit did not
    // pick it up despite it being staged. Workers stay isolated.
    const showTree = execFileSync(
      "git",
      ["ls-tree", "-r", tomSha!, "docs/Bob/"],
      { cwd: coRoot, encoding: "utf-8" },
    ).trim();
    expect(showTree).toBe("");

    // Bob can now commit its own — independently and cleanly.
    const bobCommitter = makeCommitter(coRoot, "Bob", "docs(Bob): build");
    const bobSha = await bobCommitter.commitIfChanged({
      task_id: asTaskId("task-bob"),
      link: "build",
      task_title: "build",
    });
    expect(bobSha).toBeTruthy();
    const bobFiles = listCommitFiles(coRoot, bobSha!);
    expect(bobFiles).toEqual(["docs/Bob/2026-05-17/build.md"]);
  });

  it("falls back to template-default commit message when runner returns blank", async () => {
    const coRoot = initCoRoot();
    writeDoc(coRoot, "Tom", "2026-05-17/plan.md", "x");
    // Runner returns empty content → template logic falls back to a
    // sane default. Verifies the fallback is the `docs(<worker_name>):`
    // pattern, not "commit failed" or undefined.
    const committer = makeCommitter(coRoot, "Tom", "");
    const sha = await committer.commitIfChanged({
      task_id: asTaskId("task-1"),
      link: "plan",
      task_title: "plan",
    });
    expect(sha).toBeTruthy();
    const subject = execFileSync(
      "git",
      ["log", "-1", "--pretty=%s", sha!],
      { cwd: coRoot, encoding: "utf-8" },
    ).trim();
    expect(subject).toMatch(/^docs\(Tom\):/);
  });
});
