import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "@co/infra";
import { type ILogger, noopLogger } from "@co/contracts";

export interface CleanupOptions {
  all?: boolean;
  project_root?: string;
  logger?: ILogger;
}

function removeRecursive(dir: string, logger: ILogger): void {
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info(`[CLEANUP] Removed: ${dir}`);
  } catch (err) {
    logger.warn(`Failed to remove ${dir}: ${String(err)}`);
  }
}

export async function cleanupOrchestrator(opts: CleanupOptions = {}): Promise<void> {
  const projectRoot = opts.project_root ?? process.cwd();
  const logger = opts.logger ?? noopLogger;

  if (opts.all) {
    // Remove all projects
    const config = loadConfig();
    const projectsRoot = config.projects_root;
    if (fs.existsSync(projectsRoot)) {
      logger.info(`Removing all projects in ${projectsRoot}...`);
      fs.readdirSync(projectsRoot).forEach((id) => {
        const projectDir = path.join(projectsRoot, id);
        if (fs.statSync(projectDir).isDirectory()) {
           removeRecursive(projectDir, logger);
        }
      });
    }
    return;
  }

  // Current project cleanup
  const stateDir = path.join(projectRoot, ".claude-orchestrator", "state");
  const leaderIdPath = path.join(stateDir, ".leader-id");

  if (!fs.existsSync(leaderIdPath)) {
    logger.warn("No .leader-id found in state directory. Cannot determine project ID.");
  } else {
    const leaderId = fs.readFileSync(leaderIdPath, "utf-8").trim();
    const config = loadConfig();
    const projectDir = path.join(config.projects_root, leaderId);
    if (fs.existsSync(projectDir)) {
      removeRecursive(projectDir, logger);
    }
  }

  // Remove worktrees
  const worktreeRoot = path.join(projectRoot, ".claude-orchestrator", "worktree");
  if (fs.existsSync(worktreeRoot)) {
    // Remove git worktrees first
    const entries = fs.readdirSync(worktreeRoot);
    for (const entry of entries) {
      const wtPath = path.join(worktreeRoot, entry);
      if (fs.statSync(wtPath).isDirectory()) {
        // Try to remove git worktree
        try {
          execSync(`git worktree remove ${wtPath}`, { cwd: projectRoot, stdio: "pipe" });
        } catch {
          // If git worktree remove fails, just remove directory
          removeRecursive(wtPath, logger);
        }
      }
    }
    // Remove the worktree root
    removeRecursive(worktreeRoot, logger);
  }

  // Remove state files
  if (fs.existsSync(stateDir)) {
    removeRecursive(stateDir, logger);
  }

  console.log("[CLEANUP] Cleanup complete.");
}
