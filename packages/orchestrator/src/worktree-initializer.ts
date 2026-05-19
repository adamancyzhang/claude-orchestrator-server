import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  loadProjectWorktreeConfig,
  saveProjectWorktreeConfig,
  type WorktreeEntry,
} from "@co/infra";
import {
  asInstanceId,
  type ILogger,
  type InstanceId,
  type InstanceRole,
} from "@co/contracts";

export interface WorktreeConfig {
  name: string;
  role: InstanceRole;
  worktree_path: string;
  relative_path: string;
  branch: string;
  instance_id: InstanceId;
}

export const BUILTIN_NAMES = [
  "Tom", "Jerry", "Lucy", "Thomas", "Jack", "Lisa",
  "Alice", "Bob", "Charlie", "Diana", "Edward", "Fiona",
  "George", "Helen", "Ivan", "Julia", "Kevin", "Linda",
  "Mike", "Nancy",
];

export const ROLE_PRIORITY: InstanceRole[] = [
  "planner",
  "executor",
  "verifier",
  "reviewer",
  "accepter",
];

// v0.7 NEW — magic-mode role fill order. The 6th worker is the
// explorer (run.ts enforces N >= 6); 7+ workers default to executor
// (FR-32: only one explorer per cluster).
export const MAGIC_ROLE_PRIORITY: InstanceRole[] = [
  "planner",
  "executor",
  "verifier",
  "reviewer",
  "accepter",
  "explorer",
];

export function assignRoles(
  count: number,
  magicMode = false,
): InstanceRole[] {
  const priority = magicMode ? MAGIC_ROLE_PRIORITY : ROLE_PRIORITY;
  if (count <= priority.length) return priority.slice(0, count);
  const roles: InstanceRole[] = [...priority];
  for (let i = priority.length; i < count; i++) roles.push("executor");
  return roles;
}

function getWorktreeBranch(name: string): string {
  return `claude-orchestrator/${name}-workspace`;
}

function execGit(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function execGitArgs(args: string[], cwd: string): string {
  // execFileSync variant used wherever we touch user-controlled values
  // (branch names, paths). The legacy `execGit(string, cwd)` is fine
  // for hard-coded git invocations within this file but we prefer the
  // args-array form for any new code added here.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function scanExistingNames(projectRoot: string): Promise<Set<string>> {
  const used = new Set<string>();
  const wtDir = path.join(projectRoot, ".claude-orchestrator", "worktree");

  if (fs.existsSync(wtDir)) {
    for (const entry of await fs.promises.readdir(wtDir)) used.add(entry);
  }
  try {
    const branches = execGit("branch -a", projectRoot);
    for (const line of branches.split("\n")) {
      const m = line.trim().match(/claude-orchestrator\/(.+)-workspace/);
      if (m) used.add(m[1]);
    }
  } catch {
    // not a git repo or empty; skip
  }
  for (const name of Object.keys(loadProjectWorktreeConfig())) used.add(name);
  return used;
}

export function generateFallbackNames(
  count: number,
  used: string[],
): string[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const result: string[] = [];
  for (const letter of alphabet) {
    if (result.length >= count) break;
    for (const suffix of ["", "ay", "ee", "ie"]) {
      if (result.length >= count) break;
      const candidate = `${letter}${suffix}`;
      if (!used.includes(candidate)) {
        result.push(candidate);
        used.push(candidate);
      }
    }
  }
  return result;
}

export function generateWorkerNames(
  count: number,
  usedNames: Set<string>,
  magicMode = false,
): Array<{ name: string; role: InstanceRole }> {
  const roles = assignRoles(count, magicMode);
  const available = BUILTIN_NAMES.filter((n) => !usedNames.has(n));

  if (available.length >= count) {
    return roles.map((role, i) => ({ name: available[i], role }));
  }

  const result: Array<{ name: string; role: InstanceRole }> = [];
  for (let i = 0; i < Math.min(count, available.length); i++) {
    result.push({ name: available[i], role: roles[i] });
  }
  const remaining = count - available.length;
  const fallback = generateFallbackNames(
    remaining,
    [...usedNames, ...available, ...result.map((r) => r.name)],
  );
  for (let i = 0; i < remaining; i++) {
    result.push({ name: fallback[i], role: roles[available.length + i] });
  }
  return result;
}

export interface InitializeWorktreesOptions {
  project_root: string;
  worker_count: number;
  template_dir: string;
  skills_dir: string;
  logger: ILogger;
  /**
   * When true (default), reused worktrees are reset hard to the
   * project's current HEAD before reuse. Prevents starting a new
   * task on top of a previous run's dirty state. Set false only for
   * tests that purposefully inspect post-shutdown worktree state.
   */
  reset_on_reuse?: boolean;
  // v0.7 NEW — when true the 6th worker is assigned role=explorer
  // instead of the default executor.
  magic_mode?: boolean;
}

export async function initializeWorktrees(
  opts: InitializeWorktreesOptions,
): Promise<WorktreeConfig[]> {
  const usedNames = await scanExistingNames(opts.project_root);
  const assignments = generateWorkerNames(
    opts.worker_count,
    usedNames,
    opts.magic_mode === true,
  );
  const existingConfig = loadProjectWorktreeConfig();
  const worktreeRoot = path.join(
    opts.project_root,
    ".claude-orchestrator",
    "worktree",
  );

  const configs: WorktreeConfig[] = [];
  const resetOnReuse = opts.reset_on_reuse ?? true;
  let leaderHead = "";
  try {
    leaderHead = execGitArgs(["rev-parse", "HEAD"], opts.project_root);
  } catch {
    leaderHead = "";
  }
  for (const { name, role } of assignments) {
    const existing = existingConfig[name];
    const wtPath = path.join(worktreeRoot, name);
    const branch = getWorktreeBranch(name);
    if (existing && fs.existsSync(wtPath)) {
      // Reset the reused worktree back to the leader's HEAD so the
      // new task starts from a known-clean slate. Without this, a
      // previous run's uncommitted modifications or stranded
      // mid-rebase state would leak into the new task. Best-effort:
      // if any step fails we log and continue rather than block
      // worker startup.
      if (resetOnReuse && leaderHead) {
        try {
          // The worktree should already be on the per-Worker branch
          // since `git worktree add` checked it out at creation time
          // and each worktree's HEAD lives in .git/worktrees/<name>/HEAD
          // independently. Skip a redundant `git checkout` (which can
          // refuse with "would be overwritten" on dirty index even
          // when staying on the same branch) and reset/clean directly.
          execGitArgs(["reset", "--hard", leaderHead], wtPath);
          execGitArgs(["clean", "-fdq"], wtPath);
          opts.logger.info(`reused worktree ${name} reset to ${leaderHead.slice(0, 8)}`);
        } catch (err) {
          opts.logger.warn(
            `worktree ${name} reset failed; continuing without clean slate`,
            { error: String(err) },
          );
        }
      }
      configs.push({
        name,
        role: existing.role,
        worktree_path: wtPath,
        relative_path: `.claude-orchestrator/worktree/${name}`,
        branch,
        instance_id: asInstanceId(
          existing.instance_id || randomUUID().replace(/-/g, ""),
        ),
      });
      opts.logger.info(`reusing worktree ${name} (${role})`);
      continue;
    }

    await fs.promises.mkdir(worktreeRoot, { recursive: true });
    let branchExists = "";
    try {
      branchExists = execGit(`rev-parse --verify ${branch}`, opts.project_root);
    } catch {
      branchExists = "";
    }
    const relative = `.claude-orchestrator/worktree/${name}`;
    if (branchExists) {
      execGit(`worktree add ${relative} ${branch}`, opts.project_root);
    } else {
      execGit(`worktree add ${relative} -b ${branch}`, opts.project_root);
    }

    const instanceId = asInstanceId(randomUUID().replace(/-/g, ""));

    seedWorktreeAssets(wtPath, name, role, opts.template_dir, opts.skills_dir);

    configs.push({
      name,
      role,
      worktree_path: wtPath,
      relative_path: relative,
      branch,
      instance_id: instanceId,
    });
    opts.logger.info(`created worktree ${name} (${role}) at ${relative}`);
  }

  if (configs.length > 0) {
    const record: Record<string, WorktreeEntry> = {};
    for (const c of configs) {
      record[c.name] = {
        name: c.name,
        role: c.role,
        path: c.relative_path,
        branch: c.branch,
        instance_id: c.instance_id,
      };
    }
    saveProjectWorktreeConfig(record);
  }

  return configs;
}

function seedWorktreeAssets(
  worktreePath: string,
  name: string,
  role: InstanceRole,
  templateDir: string,
  skillsDir: string,
): void {
  if (!fs.existsSync(templateDir)) return;

  const agentsSrc = path.join(templateDir, "agents");
  const agentsDst = path.join(worktreePath, ".claude-orchestrator", "agents");
  if (fs.existsSync(agentsSrc)) {
    fs.mkdirSync(agentsDst, { recursive: true });
    for (const file of fs.readdirSync(agentsSrc)) {
      const src = path.join(agentsSrc, file);
      const dst = path.join(agentsDst, file);
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  }

  if (fs.existsSync(skillsDir)) {
    const skillsDst = path.join(worktreePath, ".claude", "skills");
    for (const skill of fs.readdirSync(skillsDir)) {
      const srcSkill = path.join(skillsDir, skill, "SKILL.md");
      const dstDir = path.join(skillsDst, skill);
      const dstSkill = path.join(dstDir, "SKILL.md");
      if (!fs.existsSync(srcSkill)) continue;
      if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true, force: true });
      fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(srcSkill, dstSkill);
    }
  }

  const memoryDir = path.join(templateDir, "claude-memory");
  const teamSrc = path.join(memoryDir, "team-claude.md");
  const teamDst = path.join(worktreePath, "CLAUDE.md");
  if (fs.existsSync(teamSrc) && !fs.existsSync(teamDst)) {
    fs.copyFileSync(teamSrc, teamDst);
  }
}
