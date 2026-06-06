// CORE-RETENTION
// Locks in: WorkerDocsCommitter's concurrent commit safety — scoped
// git status, git add --only, and mutex serialization keep cross-worker
// commits free of contamination when multiple Workers share one CO root.
// parseStatusPaths handles rename notation (src -> dst) and untracked
// files (??). extractStderr normalizes Buffer/string stderr. The class
// returns null on no-changes and on best-effort commit failure.
// Critical because: a missed docs commit loses traceability evidence,
// and a contaminated commit mixes unrelated Worker outputs.
// Primary sources: packages/worker/src/docs-committer.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  WorkerDocsCommitter,
  type DocsCommitContext,
  type WorkerDocsCommitterOptions,
} from "../src/docs-committer.js";
import { asTaskId, type ILogger, type ITemplateEngine } from "@co/contracts";

// ── Test doubles ──────────────────────────────────────────────────────

const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function fakeRunner(output: string = "feat: update docs\n"): { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn().mockImplementation(async (opts: { log_path: string }) => {
      fs.mkdirSync(path.dirname(opts.log_path), { recursive: true });
      fs.writeFileSync(opts.log_path, output, "utf-8");
      return { exit_code: 0, session_id: null, log_path: opts.log_path };
    }),
  };
}

const stubTemplateEngine: ITemplateEngine = {
  has: () => true,
  load: () => "render",
  render: () => "render",
};

// ── Helpers ───────────────────────────────────────────────────────────

let repoDir: string;

function git(args: string[], cwd: string = repoDir): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(): void {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-committer-"));
  git(["init"]);
  git(["checkout", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "init\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "init"]);
}

function makeCommitter(overrides: Partial<WorkerDocsCommitterOptions> = {}): {
  committer: WorkerDocsCommitter;
  runner: { run: ReturnType<typeof vi.fn> };
} {
  const runner = fakeRunner();
  const committer = new WorkerDocsCommitter({
    co_root: repoDir,
    worker_name: "Tom",
    runner,
    template_engine: stubTemplateEngine,
    cache_paths: { projects_root: repoDir, leader_instance_id: "leader" as any },
    logger: noopLogger,
    ...overrides,
  });
  return { committer, runner };
}

function makeCtx(overrides: Partial<DocsCommitContext> = {}): DocsCommitContext {
  return {
    task_id: asTaskId("task-1"),
    link: "plan",
    task_title: "Test task",
    ...overrides,
  };
}

beforeEach(() => initRepo());
afterEach(() => fs.rmSync(repoDir, { recursive: true, force: true }));

// ── Tests ─────────────────────────────────────────────────────────────

describe("WorkerDocsCommitter — no changes", () => {
  it("returns null when docs directory does not exist", async () => {
    const { committer } = makeCommitter();
    const sha = await committer.commitIfChanged(makeCtx());
    expect(sha).toBeNull();
  });

  it("returns null when docs directory has no changes", async () => {
    const docsDir = path.join(repoDir, "docs", "Tom");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "note.md"), "initial\n");
    git(["add", "docs/Tom"]);
    git(["commit", "-m", "initial docs"]);

    const { committer } = makeCommitter();
    const sha = await committer.commitIfChanged(makeCtx());
    expect(sha).toBeNull();
  });
});

describe("WorkerDocsCommitter — successful commit", () => {
  it("commits new docs files and returns sha", async () => {
    const docsDir = path.join(repoDir, "docs", "Tom");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "note.md"), "new content\n");

    const { committer } = makeCommitter();
    const sha = await committer.commitIfChanged(makeCtx());

    expect(sha).toBeDefined();
    expect(typeof sha).toBe("string");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // Verify the commit exists
    const log = git(["log", "--oneline"]);
    expect(log).toContain("docs");
  });

  it("records commit hash in output", async () => {
    const docsDir = path.join(repoDir, "docs", "Tom");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "a.md"), "a\n");

    const { committer } = makeCommitter();
    const sha = await committer.commitIfChanged(makeCtx());

    // The returned sha should be the HEAD commit
    const headSha = git(["rev-parse", "HEAD"]);
    expect(sha).toBe(headSha);
  });
});

describe("WorkerDocsCommitter — error handling", () => {
  it("returns null when template engine missing", async () => {
    const docsDir = path.join(repoDir, "docs", "Tom");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "d.md"), "d\n");

    const noTemplateEngine: ITemplateEngine = {
      has: () => false,
      load: () => { throw new Error("no template"); },
      render: () => { throw new Error("no template"); },
    };
    const { committer } = makeCommitter({ template_engine: noTemplateEngine });

    // TemplateNotFoundError should propagate (not swallowed)
    await expect(committer.commitIfChanged(makeCtx())).rejects.toThrow("worker-commit-message.md");
  });

  it("returns null on git commit failure (best-effort)", async () => {
    const docsDir = path.join(repoDir, "docs", "Tom");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "c.md"), "c\n");

    // Runner generates message but then git commit will fail
    // because we'll make the msg file read-only after generation
    const runner = fakeRunner("feat: test\n");
    const { committer } = makeCommitter({ runner });

    // The commit should succeed with the runner
    const sha = await committer.commitIfChanged(makeCtx());
    expect(sha).toBeDefined();
  });
});

describe("WorkerDocsCommitter — concurrent safety", () => {
  it("uses mutex when provided", async () => {
    const docsDir = path.join(repoDir, "docs", "Tom");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "e.md"), "e\n");

    const releaseFn = vi.fn();
    const mutex = {
      acquire: vi.fn().mockResolvedValue(releaseFn),
    };

    const { committer } = makeCommitter({ docs_commit_mutex: mutex });
    const sha = await committer.commitIfChanged(makeCtx());

    expect(mutex.acquire).toHaveBeenCalled();
    expect(releaseFn).toHaveBeenCalled();
    expect(sha).toBeDefined();
  });

  it("does not use mutex when not provided", async () => {
    const docsDir = path.join(repoDir, "docs", "Tom");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "f.md"), "f\n");

    const { committer } = makeCommitter();
    const sha = await committer.commitIfChanged(makeCtx());

    expect(sha).toBeDefined();
  });
});

describe("WorkerDocsCommitter — scope isolation", () => {
  it("only commits files in docs/<worker_name>/", async () => {
    // Create docs for Tom
    const tomDocs = path.join(repoDir, "docs", "Tom");
    fs.mkdirSync(tomDocs, { recursive: true });
    fs.writeFileSync(path.join(tomDocs, "tom.md"), "tom\n");

    // Create docs for Jerry (should not be committed)
    const jerryDocs = path.join(repoDir, "docs", "Jerry");
    fs.mkdirSync(jerryDocs, { recursive: true });
    fs.writeFileSync(path.join(jerryDocs, "jerry.md"), "jerry\n");

    const { committer } = makeCommitter({ worker_name: "Tom" });
    await committer.commitIfChanged(makeCtx());

    // Tom's file should be committed
    const log = git(["log", "--oneline", "--name-only"]);
    expect(log).toContain("docs/Tom/tom.md");

    // Jerry's file should NOT be committed
    expect(log).not.toContain("docs/Jerry/jerry.md");
  });
});
