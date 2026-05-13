import * as path from "node:path";
import { execSync, fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { Logger } from "../utils/logger.js";
import type { WorktreeConfig } from "../worker/worktree-initializer.js";
import {
  InitChecker,
  createGlobalConfigStep,
  createUserClaudeMdStep,
  createTeamClaudeMdStep,
  createSkillsStep,
} from "./init-checker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = new Logger("Orchestrator");

let shuttingDown = false;

export async function runOrchestrator(config: {
  zkHosts: string;
  workerCount: number;
  name?: string;
  debug?: boolean;
  yFlag?: boolean;
}): Promise<void> {
  // Phase 1: Interactive environment check (InitChecker)
  const templateDir = path.join(__dirname, "..", "templates");
  const skillsDir = path.join(__dirname, "..", "skills");
  const projectRoot = process.cwd();

  // Ensure workspace is clean before init
  const wasClean = !execSync("git status --porcelain", { cwd: projectRoot, encoding: "utf-8" }).trim();
  if (!wasClean) {
    logger.error("Workspace has uncommitted changes. Please commit or stash before running orchestrator:");
    const status = execSync("git status --porcelain", { cwd: projectRoot, encoding: "utf-8" }).trim();
    for (const line of status.split("\n")) {
      logger.error(`  ${line}`);
    }
    process.exit(1);
  }

  const checker = new InitChecker({ yFlag: config.yFlag ?? false });
  await checker.runAll([
    createGlobalConfigStep(templateDir),
    createUserClaudeMdStep(templateDir),
    createTeamClaudeMdStep(templateDir, projectRoot),
    createSkillsStep(skillsDir, projectRoot),
  ]);

  // Auto-commit any workspace files created by init
  const initStatus = execSync("git status --porcelain", { cwd: projectRoot, encoding: "utf-8" }).trim();
  if (initStatus) {
    execSync("git add -A", { cwd: projectRoot });
    execSync("git commit -m \"chore: init orchestrator workspace files\"", { cwd: projectRoot });
    logger.info("Committed init-created workspace files");
  }

  // Phase 2: Role assignment & worktree initialization
  const { initializeWorktrees } = await import("../worker/worktree-initializer.js");
  const worktreeConfigs = await initializeWorktrees(process.cwd(), config.workerCount);

  logger.info(`Worktrees ready: ${worktreeConfigs.map(w => `${w.name}(${w.role})`).join(", ")}`);

  // Phase 3: Start Leader TUI
  const { startLeader } = await import("../leader/index.js");
  const leaderReady = new Promise<void>((resolve) => {
    // Give leader a tick to start, then resolve
    setTimeout(resolve, 500);
  });

  startLeader({
    zkHosts: config.zkHosts,
    name: config.name,
    debug: config.debug ?? false,
    worktreeConfigs,
  }).catch((err) => {
    logger.error("Leader failed", err);
    process.exit(1);
  });

  await leaderReady;

  // Phase 4: Start Worker child processes
  const children = await startAllWorkers({
    zkHosts: config.zkHosts,
    configs: worktreeConfigs,
    debug: config.debug ?? false,
  });

  // Phase 5: Wait for shutdown
  await handleShutdown(children);
}

async function startAllWorkers(opts: {
  zkHosts: string;
  configs: WorktreeConfig[];
  debug: boolean;
}): Promise<ChildProcess[]> {
  const resolvedConfig = loadConfig({ zookeeper: opts.zkHosts });
  const children: ChildProcess[] = [];
  const restartCount = new Map<string, number>();

  function spawnChild(cfg: WorktreeConfig): ChildProcess {
    const child = fork(
      path.join(__dirname, "..", "worker", "child.js"),
      [JSON.stringify({
        worktreePath: cfg.worktreePath,
        name: cfg.name,
        role: cfg.role,
        instanceId: cfg.instanceId,
        branch: cfg.branch,
        zkHosts: opts.zkHosts,
        debug: opts.debug,
        cliCommand: resolvedConfig.cliCommand,
        cacheDir: resolvedConfig.cacheDir,
      })],
      { stdio: "inherit" },
    );

    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      const retries = restartCount.get(cfg.name) ?? 0;
      if (code !== 0 && code !== null && retries < 3) {
        logger.warn(`Worker ${cfg.name} exited (code=${code}), restart ${retries + 1}/3`);
        restartCount.set(cfg.name, retries + 1);
        const newChild = spawnChild(cfg);
        const idx = children.indexOf(child);
        if (idx !== -1) children[idx] = newChild;
      } else if (code !== 0 && code !== null) {
        logger.error(`Worker ${cfg.name} max retries exceeded, giving up`);
      }
    });

    return child;
  }

  for (const cfg of opts.configs) {
    children.push(spawnChild(cfg));
  }

  return children;
}

async function handleShutdown(children: ChildProcess[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      shuttingDown = true;
      for (const child of children) {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGTERM");
        }
      }
      resolve();
    };

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.on("exit", () => {
      for (const child of children) {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGTERM");
        }
      }
    });
  });
}
