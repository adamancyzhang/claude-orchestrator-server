// CORE-RETENTION
// Locks in: MemoryBootstrap idempotency, source enumeration via `git ls-files`,
//   per-directory grouping, file-summaries block composition, and
//   completion-marker behavior (memory/CLAUDE.md as the populated sentinel).
// Core path because: workspace memory is consumed by every Worker on every
//   chain link; a regression in the bootstrap (wrong path layout, wrong
//   marker, or non-idempotent re-runs) silently produces empty/stale memory
//   on Leader restart and misleads all downstream link decisions.
// Owner subsystem: leader.
// Primary source files exercised:
//   - packages/leader/src/memory-bootstrap.ts
//   - packages/contracts/src/paths/cachePaths.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  asInstanceId,
  asSessionId,
  type IClaudeRunner,
  type ILogger,
  type ITemplateEngine,
  type RunOptions,
  type RunResult,
} from "@co/contracts";
import { MemoryBootstrap } from "../../../src/memory-bootstrap.js";

class SilentLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
}

// TRUST-JUSTIFICATION: Mocking IClaudeRunner.run for MemoryBootstrap unit tests.
// Downstream: real claude-cli subprocess spawned for per-file / per-dir memory
//   generation. Each call costs ~30 s and ~$0.10 — running 98+ of them in CI
//   is impractical and non-deterministic.
// Reason: MemoryBootstrap's responsibility under test here is enumeration,
//   grouping, path layout, and idempotency — none of which depend on the
//   semantic content of the Claude response. The protocol contract is:
//   `runner.run({prompt, log_path, cwd, quiet}) → {exit_code: 0}` and the
//   prompt's `Write` instruction creates the result file.
// Evidence: real-Claude flow is exercised in tests/core/manual/ smoke runs
//   when actually generating memory for a project. The unit test stubs the
//   runner with a deterministic fake that writes the expected result file
//   so we can assert on observable filesystem layout.
function makeFakeRunner(opts: {
  write_result?: boolean;
  exit_code?: number;
}): IClaudeRunner {
  const exitCode = opts.exit_code ?? 0;
  const writeResult = opts.write_result ?? true;
  return {
    async run(o: RunOptions): Promise<RunResult> {
      // The real prompt instructs Claude to Write to result_path. Extract
      // that path from the prompt body and emulate the side effect.
      if (writeResult) {
        const match = o.prompt.match(/result_path[^`]*`([^`]+)`/);
        if (match) {
          const resultPath = match[1];
          fs.mkdirSync(path.dirname(resultPath), { recursive: true });
          fs.writeFileSync(resultPath, "---\nfake\n---\n## Purpose\nstub\n", "utf-8");
        }
      }
      return {
        exit_code: exitCode,
        session_id: asSessionId("fake"),
        log_path: o.log_path,
      };
    },
  };
}

function makeFakeTemplateEngine(present: Record<string, string>): ITemplateEngine {
  return {
    load(name: string): string {
      const body = present[name];
      if (body == null) throw new Error(`missing template ${name}`);
      return body;
    },
    render(name: string, vars: Record<string, string>): string {
      let out = present[name] ?? "";
      for (const [k, v] of Object.entries(vars)) {
        out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
      }
      return out;
    },
    has(name: string): boolean {
      return name in present;
    },
  };
}

/**
 * Build a temp directory that:
 *   - is a git repo
 *   - has tracked source files under `packages/<pkg>/src/`
 *   - serves as both the workspace root and the cache root (separate
 *     subdirs) so we can assert on observable layout under
 *     `${cache}/leader-1/memory/...` without cross-test interference.
 */
function makeFixture(): {
  workspace: string;
  cacheRoot: string;
  sources: string[];
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-bootstrap-"));
  const workspace = path.join(root, "workspace");
  const cacheRoot = path.join(root, "cache");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });

  execSync("git init -q", { cwd: workspace });

  const sources = [
    "packages/alpha/src/index.ts",
    "packages/alpha/src/helper.ts",
    "packages/beta/src/main.ts",
  ];
  for (const s of sources) {
    const full = path.join(workspace, s);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// ${s}\nexport const x = 1;\n`, "utf-8");
  }
  fs.writeFileSync(
    path.join(workspace, "README.md"),
    "untracked-readme-should-not-appear\n",
    "utf-8",
  );
  // `git ls-files` reads the index, not commits — so stage the files but
  // do not commit. This avoids depending on a working git signing setup
  // in CI sandboxes while still exercising the real ls-files glob.
  execSync("git add packages README.md", { cwd: workspace });

  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { workspace, cacheRoot, sources, cleanup };
}

function makeBootstrap(
  fixture: ReturnType<typeof makeFixture>,
  runnerOpts: { write_result?: boolean; exit_code?: number } = {},
): MemoryBootstrap {
  return new MemoryBootstrap({
    cache_paths: {
      projects_root: fixture.cacheRoot,
      leader_instance_id: asInstanceId("leader-1"),
    },
    workspace_root: fixture.workspace,
    runner: makeFakeRunner(runnerOpts),
    template_engine: makeFakeTemplateEngine({
      "worker-memorize-file.md":
        "result_path is `{{result_path}}` for {{source_path}}",
      "worker-memorize-dir.md":
        "result_path is `{{result_path}}` for {{dir_path}}",
    }),
    logger: new SilentLogger(),
  });
}

describe("MemoryBootstrap", () => {
  it("enumerateSources returns only files matched by the default git glob, sorted", () => {
    const fx = makeFixture();
    try {
      const bs = makeBootstrap(fx);
      const sources = bs.enumerateSources();
      expect(sources).toEqual([
        "packages/alpha/src/helper.ts",
        "packages/alpha/src/index.ts",
        "packages/beta/src/main.ts",
      ]);
      // README.md is tracked but does not match `packages/**/*.ts`.
      expect(sources).not.toContain("README.md");
    } finally {
      fx.cleanup();
    }
  });

  it("groupByDir buckets sources by parent directory in encounter order", () => {
    const fx = makeFixture();
    try {
      const bs = makeBootstrap(fx);
      const grouped = bs.groupByDir([
        "packages/alpha/src/helper.ts",
        "packages/alpha/src/index.ts",
        "packages/beta/src/main.ts",
      ]);
      expect(Array.from(grouped.keys())).toEqual([
        "packages/alpha/src",
        "packages/beta/src",
      ]);
      expect(grouped.get("packages/alpha/src")).toEqual([
        "packages/alpha/src/helper.ts",
        "packages/alpha/src/index.ts",
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("isPopulated returns false when memory/CLAUDE.md does not exist", () => {
    const fx = makeFixture();
    try {
      const bs = makeBootstrap(fx);
      expect(bs.isPopulated()).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("run() writes per-file summaries, per-dir CLAUDE.md, and root marker; mirrors source tree", async () => {
    const fx = makeFixture();
    try {
      const bs = makeBootstrap(fx);
      const stats = await bs.run();
      // 3 files generated, 2 dirs generated, root marker written.
      expect(stats.files_generated).toBe(3);
      expect(stats.files_failed).toBe(0);
      expect(stats.dirs_generated).toBe(2);
      expect(stats.dirs_failed).toBe(0);

      const memRoot = path.join(fx.cacheRoot, "leader-1", "memory");
      // Mirrored per-file summaries — extension swapped to .md.
      expect(
        fs.existsSync(
          path.join(memRoot, "packages/alpha/src/helper.md"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(memRoot, "packages/alpha/src/index.md"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(memRoot, "packages/beta/src/main.md"),
        ),
      ).toBe(true);
      // Per-directory CLAUDE.md indexes.
      expect(
        fs.existsSync(path.join(memRoot, "packages/alpha/src/CLAUDE.md")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(memRoot, "packages/beta/src/CLAUDE.md")),
      ).toBe(true);
      // Root marker — gate for isPopulated().
      expect(fs.existsSync(path.join(memRoot, "CLAUDE.md"))).toBe(true);
      expect(bs.isPopulated()).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("run() is idempotent — second run is a no-op once the root marker exists", async () => {
    const fx = makeFixture();
    try {
      const bs = makeBootstrap(fx);
      await bs.run();
      const memRoot = path.join(fx.cacheRoot, "leader-1", "memory");
      const helperPath = path.join(memRoot, "packages/alpha/src/helper.md");
      // Sentinel: mtime before second pass.
      const before = fs.statSync(helperPath).mtimeMs;
      // Second pass — should detect populated, skip everything.
      const second = await bs.run();
      expect(second.files_generated).toBe(0);
      expect(second.dirs_generated).toBe(0);
      // File untouched.
      expect(fs.statSync(helperPath).mtimeMs).toBe(before);
    } finally {
      fx.cleanup();
    }
  });

  it("run() counts and logs failures without aborting the pass", async () => {
    const fx = makeFixture();
    try {
      const bs = makeBootstrap(fx, { exit_code: 1, write_result: false });
      const stats = await bs.run();
      // All 3 files fail, no dir summaries because per-dir generation also
      // calls the same failing runner — but the pass completes and writes
      // the marker so subsequent restarts don't loop forever on a broken
      // claude-cli.
      expect(stats.files_failed).toBe(3);
      expect(stats.files_generated).toBe(0);
      expect(bs.isPopulated()).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("refreshFiles overwrites existing per-file memory and regenerates affected dir indexes", async () => {
    const fx = makeFixture();
    try {
      const bs = makeBootstrap(fx);
      await bs.run();
      const memRoot = path.join(fx.cacheRoot, "leader-1", "memory");
      const helperPath = path.join(memRoot, "packages/alpha/src/helper.md");
      const beforeMtime = fs.statSync(helperPath).mtimeMs;
      // Wait long enough for mtime resolution then refresh that one file.
      await new Promise((r) => setTimeout(r, 25));
      const stats = await bs.refreshFiles([
        "packages/alpha/src/helper.ts",
      ]);
      expect(stats.generated).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.filtered_out).toBe(0);
      // helper.md rewritten (mtime changed).
      expect(fs.statSync(helperPath).mtimeMs).toBeGreaterThan(beforeMtime);
      // The alpha dir index is rewritten too (delete + regenerate).
      expect(
        fs.existsSync(path.join(memRoot, "packages/alpha/src/CLAUDE.md")),
      ).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("refreshFiles filters out files not matched by source_globs", async () => {
    const fx = makeFixture();
    try {
      const bs = makeBootstrap(fx);
      await bs.run();
      const stats = await bs.refreshFiles([
        "packages/alpha/src/helper.ts",  // matches
        "README.md",                      // tracked but not in glob
        "packages/alpha/missing.ts",      // not tracked
      ]);
      expect(stats.generated).toBe(1);
      expect(stats.filtered_out).toBe(2);
    } finally {
      fx.cleanup();
    }
  });
});
