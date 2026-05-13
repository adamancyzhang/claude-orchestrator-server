import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { loadProjectWorktreeConfig, saveProjectWorktreeConfig } from "../config.js";
import { Logger } from "../utils/logger.js";

export interface WorktreeConfig {
  name: string;
  role: string;
  worktreePath: string;
  relativePath: string;
  branch: string;
  instanceId: string;
}

const BUILTIN_NAMES = [
  "Tom", "Jerry", "Lucy", "Thomas", "Jack", "Lisa",
  "Alice", "Bob", "Charlie", "Diana", "Edward", "Fiona",
  "George", "Helen", "Ivan", "Julia", "Kevin", "Linda",
  "Mike", "Nancy",
];

const ROLE_PRIORITY = ["planner", "builder", "verifier", "reviewer", "accepter"];

const logger = new Logger("WorktreeInit");

function assignRoles(count: number): string[] {
  if (count <= ROLE_PRIORITY.length) {
    return ROLE_PRIORITY.slice(0, count);
  }
  const roles = [...ROLE_PRIORITY];
  let remaining = count - ROLE_PRIORITY.length;
  while (remaining > 0) {
    roles.push("builder");
    remaining--;
  }
  return roles;
}

export function getWorktreeBranch(name: string): string {
  return `claude-orchestrator/${name}-workspace`;
}

function execGit(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

async function scanExistingNames(projectRoot: string): Promise<Set<string>> {
  const used = new Set<string>();
  const wtDir = path.join(projectRoot, ".claude-orchestrator", "worktree");

  // 1. Scan existing worktree directories
  if (fs.existsSync(wtDir)) {
    for (const entry of await fs.promises.readdir(wtDir)) {
      used.add(entry);
    }
  }

  // 2. Scan existing worktree branches
  const branches = execGit("branch -a", projectRoot);
  const wtBranchPattern = /claude-orchestrator\/(.+)-workspace/;
  for (const line of branches.split("\n")) {
    const m = line.trim().match(wtBranchPattern);
    if (m) used.add(m[1]);
  }

  // 3. Scan config.json worktree records
  const worktreeConfig = loadProjectWorktreeConfig();
  for (const name of Object.keys(worktreeConfig)) {
    used.add(name);
  }

  return used;
}

function generateFallbackNames(count: number, used: string[]): string[] {
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

function generateWorkerNames(
  count: number,
  usedNames: Set<string>,
): Array<{ name: string; role: string }> {
  const roles = assignRoles(count);
  const available = BUILTIN_NAMES.filter(n => !usedNames.has(n));

  if (available.length >= count) {
    return roles.map((role, i) => ({ name: available[i], role }));
  }

  const result: Array<{ name: string; role: string }> = [];
  for (let i = 0; i < Math.min(count, available.length); i++) {
    result.push({ name: available[i], role: roles[i] });
  }

  const remaining = count - available.length;
  const fallbackNames = generateFallbackNames(
    remaining,
    [...usedNames, ...available, ...result.map(r => r.name)],
  );
  for (let i = 0; i < remaining; i++) {
    result.push({ name: fallbackNames[i], role: roles[available.length + i] });
  }

  return result;
}

async function ensureWorktreeEnvironment(
  worktreePath: string,
  name: string,
  role: string,
): Promise<void> {
  const projectRoot = path.resolve(worktreePath, "..", "..", "..");
  const distTemplateDir = path.join(projectRoot, "dist", "templates");
  const srcTemplateDir = path.join(projectRoot, "templates");

  const templateDir = fs.existsSync(distTemplateDir) ? distTemplateDir : srcTemplateDir;
  const agentsDir = path.join(worktreePath, ".claude-orchestrator", "agents");

  if (fs.existsSync(templateDir)) {
    // Copy agent templates
    const templates = [
      "worker-decompose.md", "worker-evaluate.md",
      "worker-plan.md", "worker-build.md", "worker-verify.md",
      "worker-review.md", "worker-accept.md",
      "worker-identity.md", "worker-merge-decision.md",
      "worker-commit-message.md", "worker-evaluate-format-hint.md",
      "worker-task-doc.md",
    ];
    for (const filename of templates) {
      const src = path.join(templateDir, "agents", filename);
      const dest = path.join(agentsDir, filename);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }

    // Copy skills to worktree .claude/skills/
    const distSkillsDir = path.join(projectRoot, "dist", "skills");
    const srcSkillsDir = path.join(projectRoot, "skills");
    const skillsSrcDir = fs.existsSync(distSkillsDir) ? distSkillsDir : srcSkillsDir;
    const skillsDstDir = path.join(worktreePath, ".claude", "skills");

    const SKILLS_TO_COPY = [
      "task-traceability",
      "task-planning",
      "task-execution",
      "task-verification",
      "task-review",
      "task-acceptance",
      "claude-orchestrator",
    ];

    if (fs.existsSync(skillsSrcDir)) {
      for (const skillName of SKILLS_TO_COPY) {
        const srcSkillPath = path.join(skillsSrcDir, skillName, "SKILL.md");
        const dstSkillDir = path.join(skillsDstDir, skillName);
        const dstSkillPath = path.join(dstSkillDir, "SKILL.md");

        if (!fs.existsSync(srcSkillPath)) continue;

        if (fs.existsSync(dstSkillDir)) {
          fs.rmSync(dstSkillDir, { recursive: true, force: true });
        }
        fs.mkdirSync(dstSkillDir, { recursive: true });
        fs.copyFileSync(srcSkillPath, dstSkillPath);
      }
    }

    // Copy team-level CLAUDE.md to worktree root
    const teamClaudeSrc = path.join(templateDir, "claude-memory", "team-claude.md");
    const teamClaudeDest = path.join(worktreePath, "CLAUDE.md");
    if (fs.existsSync(teamClaudeSrc) && !fs.existsSync(teamClaudeDest)) {
      fs.copyFileSync(teamClaudeSrc, teamClaudeDest);
    }

    // Copy personal CLAUDE.md for this role
    const roleToPersonalTemplate: Record<string, string> = {
      planner: "personal-claude-planner.md",
      builder: "personal-claude-builder.md",
      verifier: "personal-claude-verifier.md",
      reviewer: "personal-claude-reviewer.md",
      accepter: "personal-claude-accepter.md",
    };
    const personalSrc = path.join(templateDir, "claude-memory", roleToPersonalTemplate[role] ?? "personal-claude-builder.md");
    const personalDir = path.join(worktreePath, ".claude-orchestrator", "docs", name);
    const personalDest = path.join(personalDir, "CLAUDE.md");
    if (fs.existsSync(personalSrc) && !fs.existsSync(personalDest)) {
      fs.mkdirSync(personalDir, { recursive: true });
      let content = fs.readFileSync(personalSrc, "utf-8");
      content = content.replace(/\{\{name\}\}/g, name).replace(/\{\{role\}\}/g, role);
      fs.writeFileSync(personalDest, content, "utf-8");
    }
  }
}

export async function initializeWorktrees(
  projectRoot: string,
  workerCount: number,
): Promise<WorktreeConfig[]> {
  const usedNames = await scanExistingNames(projectRoot);
  const assignments = generateWorkerNames(workerCount, usedNames);
  const configs: WorktreeConfig[] = [];

  const existingConfig = loadProjectWorktreeConfig();
  const worktreeRoot = path.join(projectRoot, ".claude-orchestrator", "worktree");

  for (const { name, role } of assignments) {
    const existing = existingConfig[name];
    const wtPath = path.join(worktreeRoot, name);

    if (existing && fs.existsSync(wtPath)) {
      configs.push({
        name,
        role: existing.role,
        worktreePath: wtPath,
        relativePath: `.claude-orchestrator/worktree/${name}`,
        branch: getWorktreeBranch(name),
        instanceId: existing.instance_id || crypto.randomUUID().replace(/-/g, ""),
      });
      logger.info(`Reusing existing worktree: ${name} (${role})`);
      continue;
    }

    const relativePath = `.claude-orchestrator/worktree/${name}`;
    const branch = getWorktreeBranch(name);

    try {
      await fs.promises.mkdir(worktreeRoot, { recursive: true });

      const branchExists = execGit(`rev-parse --verify ${branch}`, projectRoot);
      if (branchExists) {
        execGit(`worktree add ${relativePath} ${branch}`, projectRoot);
      } else {
        execGit(`worktree add ${relativePath} -b ${branch}`, projectRoot);
      }

      const instanceId = crypto.randomUUID().replace(/-/g, "");

      const wtConfigDir = path.join(wtPath, ".claude-orchestrator");
      await fs.promises.mkdir(wtConfigDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(wtConfigDir, "config.json"),
        JSON.stringify({ name, role, instance_id: instanceId }, null, 2),
      );

      await ensureWorktreeEnvironment(wtPath, name, role);

      if (fs.existsSync(path.join(wtPath, "package.json"))) {
        logger.info(`Installing dependencies for ${name}...`);
        try {
          execSync("npm install", { cwd: wtPath, stdio: "inherit" });
        } catch {
          logger.warn(`npm install failed for ${name}, continuing...`);
        }
      }

      configs.push({
        name,
        role,
        worktreePath: wtPath,
        relativePath,
        branch,
        instanceId,
      });

      logger.info(`Created worktree: ${name} (${role}) at ${relativePath}`);
    } catch (err) {
      logger.error(`Failed to create worktree for ${name}`, err);
    }
  }

  if (configs.length > 0) {
    saveProjectWorktreeConfig(configs);
  }

  return configs;
}
