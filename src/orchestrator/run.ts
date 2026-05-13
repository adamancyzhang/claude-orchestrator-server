import * as path from "node:path";
import { execSync, fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { Logger } from "../utils/logger.js";
import {
  InitChecker,
  createGlobalConfigStep,
  createUserClaudeMdStep,
  createTeamClaudeMdStep,
  createSkillsStep,
} from "./init-checker.js";
import { runPhases, type OrchDeps } from "./phases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = new Logger("Orchestrator");

export function defaultOrchDeps(): OrchDeps {
  return {
    ensureCleanWorkspace(projectRoot) {
      const status = execSync("git status --porcelain", { cwd: projectRoot, encoding: "utf-8" }).trim();
      return { clean: status.length === 0, status };
    },
    async runInitCheck({ templateDir, skillsDir, projectRoot, yFlag }) {
      const checker = new InitChecker({ yFlag });
      await checker.runAll([
        createGlobalConfigStep(),
        createUserClaudeMdStep(templateDir),
        createTeamClaudeMdStep(templateDir, projectRoot),
        createSkillsStep(skillsDir, projectRoot),
      ]);
    },
    commitInitFiles(projectRoot) {
      const initStatus = execSync("git status --porcelain", { cwd: projectRoot, encoding: "utf-8" }).trim();
      if (initStatus) {
        execSync("git add -A", { cwd: projectRoot });
        execSync("git commit -m \"chore: init orchestrator workspace files\"", { cwd: projectRoot });
        logger.info("Committed init-created workspace files");
      }
    },
    async initializeWorktrees(projectRoot, count) {
      const { initializeWorktrees } = await import("../worker/worktree-initializer.js");
      return initializeWorktrees(projectRoot, count);
    },
    async startLeader({ zkHosts, name, debug, worktreeConfigs }) {
      const { startLeader } = await import("../leader/index.js");
      const leaderReady = new Promise<void>((resolve) => setTimeout(resolve, 500));
      startLeader({ zkHosts, name, debug, worktreeConfigs }).catch((err) => {
        logger.error("Leader failed", err);
        process.exit(1);
      });
      await leaderReady;
    },
    forkWorker(cfg, opts) {
      return fork(
        path.join(__dirname, "..", "worker", "child.js"),
        [JSON.stringify({
          worktreePath: cfg.worktreePath,
          name: cfg.name,
          role: cfg.role,
          instanceId: cfg.instanceId,
          branch: cfg.branch,
          zkHosts: opts.zkHosts,
          debug: opts.debug,
          cliCommand: opts.cliCommand,
          cacheDir: opts.cacheDir,
        })],
        { stdio: "inherit" },
      );
    },
    waitForSignal() {
      return new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
      });
    },
  };
}

export async function runOrchestrator(
  config: {
    zkHosts: string;
    workerCount: number;
    name?: string;
    debug?: boolean;
    yFlag?: boolean;
  },
  depsOverride?: Partial<OrchDeps>,
): Promise<void> {
  const templateDir = path.join(__dirname, "..", "templates");
  const skillsDir = path.join(__dirname, "..", "skills");
  const projectRoot = process.cwd();
  const resolved = loadConfig({ zookeeper: config.zkHosts });

  const deps: OrchDeps = { ...defaultOrchDeps(), ...depsOverride };

  try {
    await runPhases({
      ...config,
      projectRoot,
      templateDir,
      skillsDir,
      cliCommand: resolved.cliCommand,
      cacheDir: resolved.cacheDir,
    }, deps);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Workspace has uncommitted changes")) {
      logger.error("Workspace has uncommitted changes. Please commit or stash before running orchestrator.");
      process.exit(1);
    }
    throw err;
  }
}

// Re-export so existing imports of fork-based types still resolve through this module.
export type { ChildProcess };
