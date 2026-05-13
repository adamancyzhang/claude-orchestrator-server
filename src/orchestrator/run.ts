import * as fs from "node:fs";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, loadGlobalConfig, saveInstanceConfig, loadInstanceConfig } from "../config.js";
import { Logger } from "../utils/logger.js";
import type { WorktreeConfig } from "../worker/worktree-initializer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = new Logger("Orchestrator");

let shuttingDown = false;

export async function runOrchestrator(config: {
  zkHosts: string;
  workerCount: number;
  name?: string;
  debug?: boolean;
}): Promise<void> {
  // Phase 1: Environment self-check + config
  await ensureEnvironment();

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

async function ensureEnvironment(): Promise<void> {
  // 1. Ensure global config ~/.claude-orchestrator/config.json
  const existingGlobal = loadGlobalConfig();

  if (!existingGlobal.commands?.["claude-cli"] || !existingGlobal.cache_dir) {
    const prevCommands = existingGlobal.commands;
    const prevHooks = existingGlobal.hooks;
    saveInstanceConfig(
      {
        commands: {
          "claude-cli": prevCommands?.["claude-cli"] || "claude --dangerously-skip-permissions --permission-mode dontAsk",
        },
        hooks: prevHooks || {
          leader_message_start: null,
          leader_message_end: null,
          worker_message_start: null,
          worker_message_end: null,
        },
        cache_dir: existingGlobal.cache_dir || ".claude-orchestrator/sessions",
        zookeeper: existingGlobal.zookeeper || {
          url: "127.0.0.1:2181",
          root_path: "/claude-orchestrator",
          auth: null,
        },
      },
      true,
    );
  }

  // 2. Copy team-level CLAUDE.md to project root (if not exists)
  const templateDir = path.join(__dirname, "..", "templates");
  const teamClaudeSrc = path.join(templateDir, "claude-memory", "team-claude.md");
  const teamClaudeDest = path.join(process.cwd(), "CLAUDE.md");
  if (fs.existsSync(teamClaudeSrc) && !fs.existsSync(teamClaudeDest)) {
    fs.copyFileSync(teamClaudeSrc, teamClaudeDest);
  }

  // 3. Copy skills to .claude/skills/
  const skillsSrcDir = path.join(__dirname, "..", "skills");
  const skillsDstDir = path.join(process.cwd(), ".claude", "skills");

  const SKILLS_TO_COPY = [
    "task-planning",
    "task-execution",
    "task-verification",
    "task-review",
    "task-acceptance",
    "task-traceability",
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
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }
      resolve();
    };

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.on("exit", () => {
      for (const child of children) {
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }
    });
  });
}
