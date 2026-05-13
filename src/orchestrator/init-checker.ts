import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { loadInitStatus, saveInitStatusStep, expandHomeDir } from "../config.js";
import type { StepAction, StepRecord } from "../config.js";

type DangerLevel = "safe" | "caution" | "danger";

interface StepDetails {
  needsConfirm: boolean;
  message: string;
  diff?: string;
  action?: StepAction;
}

interface InitStep {
  id: string;
  title: string;
  description: string;
  dangerLevel: DangerLevel;
  check: () => Promise<StepDetails>;
  execute: () => Promise<void>;
}

const COLORS: Record<DangerLevel, string> = {
  safe: "\x1b[32m",
  caution: "\x1b[33m",
  danger: "\x1b[31m",
};
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function dangerLabel(level: DangerLevel): string {
  const labels: Record<DangerLevel, string> = { safe: "SAFE", caution: "CAUTION", danger: "DANGER" };
  return `${COLORS[level]}${labels[level]}${RESET}`;
}

export class InitChecker {
  private status = loadInitStatus();

  constructor(private opts: { yFlag: boolean }) {}

  async runAll(steps: InitStep[]): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      await this.runStep(steps[i], i + 1, steps.length);
    }
  }

  private async runStep(step: InitStep, num: number, total: number): Promise<void> {
    const label = `[${num}/${total}]`;
    console.log(`\n${BOLD}${label} ${step.title}${RESET}`);
    console.log(`${DIM}${step.description}${RESET}`);

    const details = await step.check();

    if (this.opts.yFlag) {
      const approved = this.autoApprove(step.id);
      if (!approved) {
        console.log(`  ${DIM}Skipped (previous decision: rejected/skipped)${RESET}`);
        return;
      }
      console.log(`  ${DIM}Auto-approved (-y mode)${RESET}`);
    } else if (details.needsConfirm) {
      const approved = await this.promptUser(step, details);
      if (!approved) {
        console.log(`  ${DIM}Skipped by user${RESET}`);
        this.saveStatus(step.id, { action: "skipped", timestamp: new Date().toISOString(), reason: "User skipped" });
        return;
      }
    } else {
      console.log(`  ${dangerLabel(step.dangerLevel)} — auto-executing`);
    }

    await step.execute();

    const record = this.buildRecord(step.id, details);
    console.log(`  ${COLORS.safe}Done${RESET} — ${record.action}`);
    this.saveStatus(step.id, record);
  }

  private autoApprove(stepId: string): boolean {
    const record = (this.status as Record<string, StepRecord | undefined>)[stepId];
    if (!record) return true; // First time — approve
    return !["rejected", "skipped"].includes(record.action); // Respect previous rejection/skip
  }

  private buildRecord(_stepId: string, details: StepDetails): StepRecord {
    return { action: details.action ?? "created", timestamp: new Date().toISOString() };
  }

  private saveStatus(stepId: string, record: StepRecord): void {
    saveInitStatusStep(stepId, record);
  }

  private async promptUser(step: InitStep, details: StepDetails): Promise<boolean> {
    const label = dangerLabel(step.dangerLevel);
    console.log(`  ${label}: ${details.message}`);

    if (details.diff) {
      console.log(details.diff.split("\n").map(l => `  ${DIM}${l}${RESET}`).join("\n"));
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(`  Proceed? [y/N/s/diff] `, (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        if (a === "y" || a === "yes") resolve(true);
        else if (a === "diff" && details.diff) {
          console.log(details.diff);
          resolve(false); // Show diff then decline; user can re-run
        } else resolve(false);
      });
    });
  }
}

// Step factory functions

export function createGlobalConfigStep(): InitStep {
  const globalConfigDir = expandHomeDir("~/.claude-orchestrator");
  const globalConfigFile = path.join(globalConfigDir, "config.json");

  return {
    id: "global_config",
    title: "Global Config",
    description: `Ensure ${globalConfigFile} exists with required fields`,
    dangerLevel: "caution",
    async check() {
      const exists = fs.existsSync(globalConfigFile);
      if (!exists) {
        return { needsConfirm: true, message: "Create new global config", action: "created" };
      }
      return { needsConfirm: true, message: "Config exists, adding only missing fields", action: "updated" };
    },
    async execute() {
      fs.mkdirSync(globalConfigDir, { recursive: true });
      const existing = fs.existsSync(globalConfigFile)
        ? JSON.parse(fs.readFileSync(globalConfigFile, "utf-8"))
        : {};

      const defaults = {
        commands: { "claude-cli": "claude --dangerously-skip-permissions --permission-mode dontAsk" },
        hooks: {
          leader_message_start: null,
          leader_message_end: null,
          worker_message_start: null,
          worker_message_end: null,
        },
        cache_dir: ".claude-orchestrator/sessions",
        zookeeper: { url: "127.0.0.1:2181", root_path: "/claude-orchestrator", auth: null },
      };

      const merged = { ...defaults, ...existing };
      if (existing.commands) merged.commands = { ...defaults.commands, ...existing.commands };
      if (existing.hooks) merged.hooks = { ...defaults.hooks, ...existing.hooks };
      if (existing.zookeeper) merged.zookeeper = { ...defaults.zookeeper, ...existing.zookeeper };

      fs.writeFileSync(globalConfigFile, JSON.stringify(merged, null, 2));
    },
  };
}

export function createUserClaudeMdStep(templateDir: string): InitStep {
  const src = path.join(templateDir, "user-global-claude.md");
  const dest = expandHomeDir("~/.claude/CLAUDE.md");

  return {
    id: "user_claude_md",
    title: "User Global CLAUDE.md",
    description: `Copy ${src} → ${dest}`,
    dangerLevel: "danger",
    async check() {
      if (!fs.existsSync(src)) {
        return { needsConfirm: false, message: "Source template not found, skipping" };
      }
      if (!fs.existsSync(dest)) {
        return { needsConfirm: true, message: "Create new user CLAUDE.md", action: "created" };
      }
      const srcContent = fs.readFileSync(src, "utf-8");
      const destContent = fs.readFileSync(dest, "utf-8");
      if (srcContent === destContent) {
        return { needsConfirm: false, message: "Already up to date" };
      }
      return {
        needsConfirm: true,
        message: "Target exists and content differs. Overwrite?",
        diff: diffContent(destContent, srcContent),
        action: "replaced",
      };
    },
    async execute() {
      if (!fs.existsSync(src)) return;
      const destDir = path.dirname(dest);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);
    },
  };
}

export function createTeamClaudeMdStep(templateDir: string, projectRoot: string): InitStep {
  const src = path.join(templateDir, "claude-memory", "team-claude.md");
  const dest = path.join(projectRoot, "CLAUDE.md");

  return {
    id: "team_claude_md",
    title: "Team CLAUDE.md",
    description: `Copy ${src} → ${dest}`,
    dangerLevel: "danger",
    async check() {
      if (!fs.existsSync(src)) {
        return { needsConfirm: false, message: "Source template not found, skipping" };
      }
      if (!fs.existsSync(dest)) {
        return { needsConfirm: true, message: "Create new team CLAUDE.md", action: "created" };
      }
      const srcContent = fs.readFileSync(src, "utf-8");
      const destContent = fs.readFileSync(dest, "utf-8");
      if (srcContent === destContent) {
        return { needsConfirm: false, message: "Already up to date" };
      }
      return {
        needsConfirm: true,
        message: "Target exists and content differs. Overwrite?",
        diff: diffContent(destContent, srcContent),
        action: "replaced",
      };
    },
    async execute() {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    },
  };
}

export function createSkillsStep(skillsDir: string, projectRoot: string): InitStep {
  const SKILLS = [
    "task-planning", "task-execution", "task-verification",
    "task-review", "task-acceptance", "task-traceability",
    "claude-orchestrator",
  ];
  const destBase = path.join(projectRoot, ".claude", "skills");

  return {
    id: "skills",
    title: "Skills",
    description: `Copy ${SKILLS.length} skills to ${destBase}/`,
    dangerLevel: "danger",
    async check() {
      if (!fs.existsSync(skillsDir)) {
        return { needsConfirm: false, message: "Skills source not found, skipping" };
      }
      const conflicts: string[] = [];
      const newSkills: string[] = [];
      let unchanged = 0;
      for (const name of SKILLS) {
        const srcSkill = path.join(skillsDir, name, "SKILL.md");
        const dstSkill = path.join(destBase, name, "SKILL.md");
        if (!fs.existsSync(srcSkill)) continue;
        if (!fs.existsSync(dstSkill)) {
          newSkills.push(name);
        } else {
          const srcContent = fs.readFileSync(srcSkill, "utf-8");
          const dstContent = fs.readFileSync(dstSkill, "utf-8");
          if (srcContent !== dstContent) {
            conflicts.push(name);
          } else {
            unchanged++;
          }
        }
      }
      if (conflicts.length === 0 && newSkills.length === 0) {
        return { needsConfirm: false, message: "All skills already up to date" };
      }
      const parts: string[] = [];
      if (newSkills.length > 0) parts.push(`${newSkills.length} new: ${newSkills.join(", ")}`);
      if (conflicts.length > 0) parts.push(`${conflicts.length} differ: ${conflicts.join(", ")}`);
      return {
        needsConfirm: true,
        message: `Skills to install: ${parts.join("; ")}${unchanged > 0 ? ` (${unchanged} unchanged)` : ""}. Proceed?`,
        action: newSkills.length > 0 && conflicts.length === 0 ? "created" : "updated",
      };
    },
    async execute() {
      for (const name of SKILLS) {
        const srcSkill = path.join(skillsDir, name, "SKILL.md");
        const dstDir = path.join(destBase, name);
        const dstSkill = path.join(dstDir, "SKILL.md");
        if (!fs.existsSync(srcSkill)) continue;
        if (fs.existsSync(dstDir)) {
          fs.rmSync(dstDir, { recursive: true, force: true });
        }
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(srcSkill, dstSkill);
      }
    },
  };
}

function diffContent(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const result: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  result.push("--- existing\n+++ new");
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine !== newLine) {
      if (oldLine !== undefined) result.push(`- ${oldLine}`);
      if (newLine !== undefined) result.push(`+ ${newLine}`);
    } else {
      if (i < 3 || i >= maxLen - 3 || result.length < 20) {
        result.push(`  ${oldLine}`);
      }
    }
  }
  return result.join("\n");
}
