// CORE-RETENTION
// Locks in: WorktreeInitializer's behavior for worker name generation
// and role assignment:
//   - assignRoles returns correct roles for different worker counts
//   - generateWorkerNames respects used names and magic mode
//   - generateFallbackNames handles pool exhaustion
// Critical because: Worker names and roles are used throughout the system
// for identity, routing, and chain links. A regression here would cause
// name collisions or incorrect role assignments.
// Primary sources: packages/orchestrator/src/worktree-initializer.ts

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assignRoles,
  generateWorkerNames,
  generateFallbackNames,
  initializeWorktrees,
  BUILTIN_NAMES,
  ROLE_PRIORITY,
  MAGIC_ROLE_PRIORITY,
} from "../src/worktree-initializer.js";
import { Logger } from "@co/infra";

describe("assignRoles", () => {
  it("should return correct roles for count <= priority length", () => {
    expect(assignRoles(3)).toEqual(["planner", "executor", "verifier"]);
  });

  it("should return full priority list for count = priority length", () => {
    expect(assignRoles(5)).toEqual(ROLE_PRIORITY);
  });

  it("should add executor roles for count > priority length", () => {
    const result = assignRoles(7);
    expect(result).toEqual([...ROLE_PRIORITY, "executor", "executor"]);
  });

  it("should use magic role priority when magicMode is true", () => {
    const result = assignRoles(6, true);
    expect(result).toEqual(MAGIC_ROLE_PRIORITY);
  });

  it("should add executor roles for magic mode when count > magic priority length", () => {
    const result = assignRoles(8, true);
    expect(result).toEqual([...MAGIC_ROLE_PRIORITY, "executor", "executor"]);
  });
});

describe("generateWorkerNames", () => {
  it("should generate names from builtin pool when available", () => {
    const usedNames = new Set<string>();
    const result = generateWorkerNames(3, usedNames);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("Tom");
    expect(result[1].name).toBe("Jerry");
    expect(result[2].name).toBe("Lucy");
  });

  it("should skip used names", () => {
    const usedNames = new Set(["Tom", "Jerry"]);
    const result = generateWorkerNames(3, usedNames);
    expect(result[0].name).toBe("Lucy");
    expect(result[1].name).toBe("Thomas");
    expect(result[2].name).toBe("Jack");
  });

  it("should use fallback names when builtin pool is exhausted", () => {
    const usedNames = new Set(BUILTIN_NAMES);
    const result = generateWorkerNames(3, usedNames);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("Tom2");
    expect(result[1].name).toBe("Jerry2");
    expect(result[2].name).toBe("Lucy2");
  });

  it("should respect magic mode role assignment", () => {
    const usedNames = new Set<string>();
    const result = generateWorkerNames(6, usedNames, true);
    expect(result).toHaveLength(6);
    expect(result[5].role).toBe("explorer");
  });
});

describe("generateFallbackNames", () => {
  it("should generate names with numeric suffix", () => {
    const used: string[] = [];
    const result = generateFallbackNames(3, used);
    expect(result).toEqual(["Tom2", "Jerry2", "Lucy2"]);
  });

  it("should skip already used names", () => {
    const used = ["Tom2", "Jerry2"];
    const result = generateFallbackNames(3, used);
    expect(result).toEqual(["Lucy2", "Thomas2", "Jack2"]);
  });

  it("should increment suffix when pool is exhausted", () => {
    const used = BUILTIN_NAMES.map((n) => `${n}2`);
    const result = generateFallbackNames(3, used);
    expect(result).toEqual(["Tom3", "Jerry3", "Lucy3"]);
  });
});

describe("initializeWorktrees — symlink behavior", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-wt-test-"));
    // Init a git repo with an initial commit (worktree add requires HEAD)
    execSync("git init -q", { cwd: tmpDir });
    execSync("git config user.email test@test.com", { cwd: tmpDir });
    execSync("git config user.name Test", { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".claude-orchestrator/\n.claude/\n");
    execSync("git add -A", { cwd: tmpDir });
    execSync('git commit -q -m "init"', { cwd: tmpDir });

    // Create root .claude directory with a test skill
    const rootClaude = path.join(tmpDir, ".claude");
    fs.mkdirSync(path.join(rootClaude, "skills", "test-skill"), { recursive: true });
    fs.writeFileSync(path.join(rootClaude, "skills", "test-skill", "SKILL.md"), "# Test Skill");

    // Create template directory
    const templateDir = path.join(tmpDir, "templates");
    fs.mkdirSync(path.join(templateDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(templateDir, "agents", "identity.md"), "# Identity");
    fs.mkdirSync(path.join(templateDir, "workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(templateDir, "project-claude.md"),
      "# Project for {your_name}",
    );

  });

  afterEach(() => {
    // Clean up git worktrees before removing tmpDir
    try {
      const wtRoot = path.join(tmpDir, ".claude-orchestrator", "worktree");
      if (fs.existsSync(wtRoot)) {
        for (const name of fs.readdirSync(wtRoot)) {
          try {
            execSync(`git worktree remove --force .claude-orchestrator/worktree/${name}`, {
              cwd: tmpDir,
              stdio: "pipe",
            });
          } catch { /* best effort */ }
        }
      }
    } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should symlink .claude from root to worktree", async () => {
    const logger = new Logger({ namespace: "test", level: "error" });
    const configs = await initializeWorktrees({
      project_root: tmpDir,
      worker_count: 1,
      template_dir: path.join(tmpDir, "templates"),

      logger,
    });

    expect(configs).toHaveLength(1);
    const wtPath = configs[0].worktree_path;
    const wtClaude = path.join(wtPath, ".claude");

    // .claude should exist as a symlink
    expect(fs.existsSync(wtClaude)).toBe(true);
    const stat = fs.lstatSync(wtClaude);
    expect(stat.isSymbolicLink()).toBe(true);

    // Symlink target should be the root .claude directory
    const target = fs.readlinkSync(wtClaude);
    expect(path.resolve(target)).toBe(path.join(tmpDir, ".claude"));

    // Skills should be accessible through the symlink
    const skillPath = path.join(wtClaude, "skills", "test-skill", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, "utf-8")).toBe("# Test Skill");
  });

  it("should NOT create .claude-orchestrator/agents/ in worktree", async () => {
    const logger = new Logger({ namespace: "test", level: "error" });
    const configs = await initializeWorktrees({
      project_root: tmpDir,
      worker_count: 1,
      template_dir: path.join(tmpDir, "templates"),

      logger,
    });

    const wtPath = configs[0].worktree_path;
    const agentsDir = path.join(wtPath, ".claude-orchestrator", "agents");
    expect(fs.existsSync(agentsDir)).toBe(false);

    // .claude-orchestrator itself should not exist in worktree
    const orchDir = path.join(wtPath, ".claude-orchestrator");
    expect(fs.existsSync(orchDir)).toBe(false);
  });

  it("should still create per-worktree CLAUDE.md with placeholders replaced", async () => {
    const logger = new Logger({ namespace: "test", level: "error" });
    const configs = await initializeWorktrees({
      project_root: tmpDir,
      worker_count: 1,
      template_dir: path.join(tmpDir, "templates"),

      logger,
    });

    const wtPath = configs[0].worktree_path;
    const claudeMd = path.join(wtPath, "CLAUDE.md");
    expect(fs.existsSync(claudeMd)).toBe(true);

    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(content).not.toContain("{your_name}");
    expect(content).toContain(configs[0].name);
  });
});
