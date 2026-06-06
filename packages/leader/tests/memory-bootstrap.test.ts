// CORE-RETENTION
// Locks in: MemoryBootstrap raises TemplateNotFoundError when a required
// template is missing (configuration error → fail fast, NOT fake-failed
// stats); readPurpose distinguishes ENOENT (return "") from other read
// errors (rethrow); buildFileSummariesBlock renders deterministic per-file
// lines and a "(none)" sentinel for empty directories.
// Critical because: a silent template miss today leaves the workspace
// memory tree empty while logging a `warn` line that no one reads —
// downstream worker prompts then degrade to "no project context found."
// Primary sources: packages/leader/src/memory-bootstrap.ts
// Regresses fixes for A4 (lines 162-167) and A5 (lines 371-381).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  asInstanceId,
  cachePaths,
  TemplateNotFoundError,
  type IClaudeRunner,
  type ILogger,
  type ITemplateEngine,
  type RunOptions,
  type RunResult,
} from "@co/contracts";
import { MemoryBootstrap } from "../src/memory-bootstrap.js";

let projectsRoot: string;
let workspaceRoot: string;

beforeEach(() => {
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "co-mem-projects-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "co-mem-ws-"));
});

afterEach(() => {
  fs.rmSync(projectsRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

const SILENT_LOGGER: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT_LOGGER,
} as unknown as ILogger;

// TRUST-JUSTIFICATION: IClaudeRunner spawns the external `claude` CLI.
// We never call runner.run() in these unit tests — both A4 and A5
// regressions throw before the runner is invoked. A throwing stub keeps
// the test contract clear: any code path that touches the runner here is
// a bug.
const NEVER_RUNNER: IClaudeRunner = {
  async run(): Promise<RunResult> {
    throw new Error("NEVER_RUNNER should not be invoked in these tests");
  },
};

function makeBootstrap(
  templateEngine: ITemplateEngine,
  runner: IClaudeRunner = NEVER_RUNNER,
): MemoryBootstrap {
  return new MemoryBootstrap({
    cache_paths: {
      projects_root: projectsRoot,
      leader_instance_id: asInstanceId("leader-test"),
    },
    workspace_root: workspaceRoot,
    runner,
    template_engine: templateEngine,
    logger: SILENT_LOGGER,
  });
}

// ── A4 regression: missing file_template throws TemplateNotFoundError ─

describe("MemoryBootstrap.refreshFiles — missing file template (A4 regression)", () => {
  it("throws TemplateNotFoundError instead of returning fake 'all failed' stats", async () => {
    // Engine that lies: it answers `has(file)` false and `has(dir)` true,
    // so the file path raises before the dir path is consulted. Note that
    // refreshFiles() pre-filters via enumerateSources() which calls
    // `git ls-files` in workspace_root — initialize an empty git repo so
    // a target file is recognized as tracked.
    const tplEngine: ITemplateEngine = {
      has: (name) => name !== "workflow/memorize-file.md",
      load: () => "",
      render: () => "rendered",
    };
    initEmptyRepoWithTrackedFile(workspaceRoot, "packages/p/src/x.ts", "x");

    const bs = makeBootstrap(tplEngine);
    await expect(
      bs.refreshFiles(["packages/p/src/x.ts"]),
    ).rejects.toBeInstanceOf(TemplateNotFoundError);
  });
});

// ── A4 regression: missing dir_template also throws ───────────────────

describe("MemoryBootstrap.refreshFiles — missing dir template", () => {
  it("throws TemplateNotFoundError when the dir template is absent", async () => {
    // File template present, dir template missing.
    const tplEngine: ITemplateEngine = {
      has: (name) => name !== "workflow/memorize-dir.md",
      load: () => "",
      render: () => "rendered",
    };
    // Runner stub that writes a result so the file generation phase
    // counts as success and the dir phase is actually reached.
    const writingRunner: IClaudeRunner = {
      async run(opts: RunOptions): Promise<RunResult> {
        // The bootstrap passes log_path = `${resultPath}.log`; reconstruct
        // resultPath by stripping the trailing `.log`.
        const resultPath = opts.log_path.replace(/\.log$/, "");
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(resultPath, "summary\n");
        return { exit_code: 0, session_id: null, log_path: opts.log_path };
      },
    };
    initEmptyRepoWithTrackedFile(workspaceRoot, "packages/p/src/x.ts", "x");

    const bs = makeBootstrap(tplEngine, writingRunner);
    await expect(
      bs.refreshFiles(["packages/p/src/x.ts"]),
    ).rejects.toBeInstanceOf(TemplateNotFoundError);
  });
});

// ── A5 regression: readPurpose ENOENT vs other read errors ────────────

describe("MemoryBootstrap.buildFileSummariesBlock — readPurpose (A5 regression)", () => {
  it("renders '(no summary)' when the memory file is missing (ENOENT)", () => {
    const bs = makeBootstrap(stubTemplateEngine());
    const block = bs.buildFileSummariesBlock("packages/p/src", [
      "packages/p/src/x.ts",
    ]);
    expect(block).toBe("- x.ts: (no summary)");
  });

  it("renders the Purpose section content for an existing memory file", () => {
    const bs = makeBootstrap(stubTemplateEngine());
    const memoryFile = cachePaths.workspaceMemoryFilePath(
      {
        projects_root: projectsRoot,
        leader_instance_id: asInstanceId("leader-test"),
      },
      "packages/p/src/x.ts",
    );
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(
      memoryFile,
      "---\nsource: packages/p/src/x.ts\n---\n\n## Purpose\nDoes the thing.\n\n## Other\n",
      "utf-8",
    );
    const block = bs.buildFileSummariesBlock("packages/p/src", [
      "packages/p/src/x.ts",
    ]);
    expect(block).toBe("- x.ts: Does the thing.");
  });

  it("returns '(none)' for an empty file list", () => {
    const bs = makeBootstrap(stubTemplateEngine());
    expect(bs.buildFileSummariesBlock("packages/p/src", [])).toBe("(none)");
  });

  it("rethrows non-ENOENT errors when the memory file path is unreadable (directory in place of file)", () => {
    // Place a *directory* at the memory file path so readFileSync emits
    // EISDIR rather than ENOENT. Previously the catch-all returned ""
    // and silently produced a "(no summary)" line; the fix surfaces the
    // errno.
    const bs = makeBootstrap(stubTemplateEngine());
    const memoryFile = cachePaths.workspaceMemoryFilePath(
      {
        projects_root: projectsRoot,
        leader_instance_id: asInstanceId("leader-test"),
      },
      "packages/p/src/y.ts",
    );
    fs.mkdirSync(memoryFile, { recursive: true });

    expect(() =>
      bs.buildFileSummariesBlock("packages/p/src", ["packages/p/src/y.ts"]),
    ).toThrow(/EISDIR/);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────

function stubTemplateEngine(): ITemplateEngine {
  return {
    has: () => true,
    load: () => "rendered",
    render: () => "rendered",
  };
}

function initEmptyRepoWithTrackedFile(
  dir: string,
  relativePath: string,
  content: string,
): void {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const file = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const opts = { cwd: dir, encoding: "utf-8" as const };
  execFileSync("git", ["init"], opts);
  execFileSync("git", ["checkout", "-b", "main"], opts);
  execFileSync("git", ["config", "user.email", "t@e.com"], opts);
  execFileSync("git", ["config", "user.name", "t"], opts);
  execFileSync("git", ["config", "commit.gpgsign", "false"], opts);
  execFileSync("git", ["add", relativePath], opts);
  execFileSync("git", ["commit", "-m", "init"], opts);
}
