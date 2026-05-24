import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  loadInitStatus,
  loadProjectInitStatus,
  saveInitStatus,
  saveProjectInitStatus,
} from "@co/infra";
import type { ILogger, InitStatusEntry, InitStatusLevel } from "@co/contracts";

interface StepDetails {
  needs_confirm: boolean;
  message: string;
  diff?: string;
}

interface InitStep {
  id: string;
  title: string;
  description: string;
  level: InitStatusLevel;
  scope: "global" | "project";
  check(): Promise<StepDetails>;
  execute(): Promise<void>;
}

const COLORS: Record<InitStatusLevel, string> = {
  Safe: "\x1b[32m",
  Caution: "\x1b[33m",
  Danger: "\x1b[31m",
};
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function expandHomeDir(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export interface InitCheckerOptions {
  y_flag: boolean;
  logger: ILogger;
}

export class InitChecker {
  private readonly globalEntries: InitStatusEntry[];
  private readonly projectEntries: InitStatusEntry[];
  private readonly status: readonly InitStatusEntry[];

  constructor(private readonly opts: InitCheckerOptions) {
    const global = loadInitStatus();
    const project = loadProjectInitStatus();
    this.globalEntries = [...global];
    this.projectEntries = [...project];
    this.status = [...global, ...project];
  }

  async runAll(steps: readonly InitStep[]): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      await this.runStep(steps[i], i + 1, steps.length);
    }
    saveInitStatus(this.globalEntries);
    saveProjectInitStatus(this.projectEntries);
  }

  private async runStep(step: InitStep, num: number, total: number): Promise<void> {
    console.log(`\n${BOLD}[${num}/${total}] ${step.title}${RESET}`);
    console.log(`${DIM}${step.description}${RESET}`);
    const details = await step.check();
    if (this.opts.y_flag) {
      if (this.previouslySkipped(step.id)) {
        console.log(`  ${DIM}Skipped (previous decision: skipped)${RESET}`);
        return;
      }
      console.log(`  ${DIM}Auto-approved (-y mode)${RESET}`);
    } else if (details.needs_confirm) {
      const approved = await this.promptUser(step, details);
      if (!approved) {
        console.log(`  ${DIM}Skipped by user${RESET}`);
        this.record(step, "skipped");
        return;
      }
    } else {
      console.log(`  ${COLORS[step.level]}${step.level}${RESET} — auto-executing`);
    }
    await step.execute();
    this.record(step, this.opts.y_flag ? "auto" : "approved");
    console.log(`  ${COLORS.Safe}done${RESET}`);
  }

  private record(step: InitStep, decision: InitStatusEntry["decision"]): void {
    const entry: InitStatusEntry = {
      step_id: step.id,
      level: step.level,
      decided_at: new Date().toISOString(),
      decision,
    };
    const target = step.scope === "global" ? this.globalEntries : this.projectEntries;
    const idx = target.findIndex((e) => e.step_id === step.id);
    if (idx >= 0) target[idx] = entry;
    else target.push(entry);
  }

  private previouslySkipped(stepId: string): boolean {
    return this.status.some((e) => e.step_id === stepId && e.decision === "skipped");
  }

  private async promptUser(step: InitStep, details: StepDetails): Promise<boolean> {
    console.log(`  ${COLORS[step.level]}${step.level}${RESET}: ${details.message}`);
    if (details.diff) {
      console.log(details.diff.split("\n").map((l) => `  ${DIM}${l}${RESET}`).join("\n"));
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question(`  Proceed? [y/N] `, (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        resolve(a === "y" || a === "yes");
      });
    });
  }
}

export function createGlobalConfigStep(logger: ILogger): InitStep {
  const dir = expandHomeDir("~/.claude-orchestrator");
  const file = path.join(dir, "config.json");
  return {
    id: "global_config",
    title: "Global Config",
    description: `Ensure ${file} exists with required fields`,
    level: "Caution",
    scope: "global",
    async check() {
      const defaults = {
        projects_root: "~/.claude-orchestrator/projects",
        commands: {
          claude_cli: "claude --dangerously-skip-permissions --permission-mode dontAsk",
          git: "git",
        },
        zookeeper: { hosts: "127.0.0.1:2181", session_timeout_ms: 30000 },
      };
      if (!fs.existsSync(file)) {
        return { needs_confirm: true, message: "Create new global config" };
      }
      const existing = JSON.parse(fs.readFileSync(file, "utf-8"));
      const merged = { ...defaults, ...existing };
      if (JSON.stringify(merged) === JSON.stringify(existing)) {
        return { needs_confirm: false, message: "Already up to date" };
      }
      return { needs_confirm: true, message: "Merging missing fields" };
    },
    async execute() {
      fs.mkdirSync(dir, { recursive: true });
      const existing = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf-8"))
        : {};
      const defaults = {
        projects_root: "~/.claude-orchestrator/projects",
        commands: {
          claude_cli: "claude --dangerously-skip-permissions --permission-mode dontAsk",
          git: "git",
        },
        zookeeper: { hosts: "127.0.0.1:2181", session_timeout_ms: 30000 },
      };
      const merged = { ...defaults, ...existing };
      fs.writeFileSync(file, JSON.stringify(merged, null, 2));
      logger.info(`updated ${file}`);
    },
  };
}

export function createUserClaudeMdStep(templateDir: string, logger: ILogger): InitStep {
  const src = path.join(templateDir, "user-global-claude.md");
  const dest = expandHomeDir("~/.claude/CLAUDE.md");
  return {
    id: "user_claude_md",
    title: "User Global CLAUDE.md",
    description: `Copy ${src} → ${dest}`,
    level: "Danger",
    scope: "global",
    async check() {
      if (!fs.existsSync(src)) {
        return { needs_confirm: false, message: "Source missing — skip" };
      }
      if (!fs.existsSync(dest)) {
        return { needs_confirm: true, message: "Create new user CLAUDE.md" };
      }
      const srcContent = fs.readFileSync(src, "utf-8");
      const destContent = fs.readFileSync(dest, "utf-8");
      if (srcContent === destContent) {
        return { needs_confirm: false, message: "Already up to date" };
      }
      return { needs_confirm: true, message: "Existing differs — overwrite?" };
    },
    async execute() {
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      logger.info(`wrote ${dest}`);
    },
  };
}

export function createTeamClaudeMdStep(
  templateDir: string,
  projectRoot: string,
  logger: ILogger,
): InitStep {
  const src = path.join(templateDir, "claude-memory", "team-claude.md");
  const dest = path.join(projectRoot, "CLAUDE.md");
  return {
    id: "team_claude_md",
    title: "Team CLAUDE.md",
    description: `Copy ${src} → ${dest}`,
    level: "Danger",
    scope: "project",
    async check() {
      if (!fs.existsSync(src)) {
        return { needs_confirm: false, message: "Source missing — skip" };
      }
      if (!fs.existsSync(dest)) {
        return { needs_confirm: true, message: "Create new team CLAUDE.md" };
      }
      const srcContent = fs.readFileSync(src, "utf-8");
      const destContent = fs.readFileSync(dest, "utf-8");
      if (srcContent === destContent) {
        return { needs_confirm: false, message: "Already up to date" };
      }
      return { needs_confirm: true, message: "Existing differs — overwrite?" };
    },
    async execute() {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        logger.info(`wrote ${dest}`);
      }
    },
  };
}

export const CHAIN_SKILLS = [
  "task-planning",
  "task-execution",
  "task-verification",
  "task-review",
  "task-acceptance",
  "task-exploration",
  "task-traceability",
];

export function createSkillsStep(
  skillsDir: string,
  projectRoot: string,
  logger: ILogger,
): InitStep {
  const destBase = path.join(projectRoot, ".claude", "skills");
  return {
    id: "skills",
    title: "Skills",
    description: `Copy skills from ${skillsDir} to ${destBase}/`,
    level: "Danger",
    scope: "project",
    async check() {
      if (!fs.existsSync(skillsDir)) {
        return { needs_confirm: false, message: "Skills source missing" };
      }
      const available = CHAIN_SKILLS.filter(
        (s) => fs.existsSync(path.join(skillsDir, s, "SKILL.md")),
      );
      if (available.length === 0) {
        return { needs_confirm: false, message: "No chain skills available" };
      }
      let allMatch = true;
      for (const skill of available) {
        const src = path.join(skillsDir, skill, "SKILL.md");
        const dst = path.join(destBase, skill, "SKILL.md");
        if (!fs.existsSync(dst)) { allMatch = false; break; }
        if (fs.readFileSync(src, "utf-8") !== fs.readFileSync(dst, "utf-8")) { allMatch = false; break; }
      }
      if (allMatch) {
        return { needs_confirm: false, message: "All skills already up to date" };
      }
      return {
        needs_confirm: true,
        message: `${available.length} chain skills available; overwrite existing?`,
      };
    },
    async execute() {
      for (const skill of CHAIN_SKILLS) {
        const srcSkill = path.join(skillsDir, skill, "SKILL.md");
        if (!fs.existsSync(srcSkill)) continue;
        const dstDir = path.join(destBase, skill);
        if (fs.existsSync(dstDir)) {
          fs.rmSync(dstDir, { recursive: true, force: true });
        }
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(srcSkill, path.join(dstDir, "SKILL.md"));
      }
      logger.info(`${CHAIN_SKILLS.length} chain skills installed`);
    },
  };
}
