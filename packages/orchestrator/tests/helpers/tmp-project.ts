// Helper for the docs/evals e2e tests: provisions an isolated temp project
// root with the same on-disk shape the orchestrator expects on first run:
//   - a clean git repo (so `ensureCleanWorkspace` passes)
//   - copies of `templates/` and `skills/` from the real repo so
//     `seedWorktreeAssets` has real content to copy into worktrees
//   - a unique parent directory under os.tmpdir(), torn down by the
//     caller after the test.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface TempProject {
  root: string;
  templates_dir: string;
  skills_dir: string;
  cleanup(): void;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Disable any global git hooks / signing config that might be set
      // in CI so the temp repo is unconditionally usable.
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

export function createTempProject(opts: {
  source_templates_dir: string;
  source_skills_dir: string;
  /**
   * Additional files (rel-path → content) to drop into the project root
   * and include in the seed commit. Lets the e2e test inject e.g. a
   * `.claude-orchestrator/config.json` with hook bindings before
   * `runOrchestrator` reads it, while keeping `ensureCleanWorkspace`
   * happy (`git status --porcelain` returns empty post-seed).
   */
  extra_files?: Record<string, string>;
}): TempProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "co-eval-startup-"));
  const templatesDst = path.join(root, "templates");
  const skillsDst = path.join(root, "skills");

  copyDir(opts.source_templates_dir, templatesDst);
  copyDir(opts.source_skills_dir, skillsDst);

  // Write a stub root file so the initial commit is non-empty.
  fs.writeFileSync(path.join(root, "README.md"), "# temp project\n");

  for (const [rel, content] of Object.entries(opts.extra_files ?? {})) {
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
  }

  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed"]);

  return {
    root,
    templates_dir: templatesDst,
    skills_dir: skillsDst,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
