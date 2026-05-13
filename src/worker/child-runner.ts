import * as path from "node:path";
import { ZkClient } from "../zk/client.js";
import { InstanceRegistry } from "../modules/registry.js";
import { HookEngine } from "../hooks/engine.js";
import { TemplateEngine } from "../executor/template.js";
import { ClaudeRunner } from "../executor/runner.js";
import { SelfEvaluator } from "./evaluator.js";
import { WorkerWatcher } from "./watcher.js";
import { CommitChecker } from "./commit-checker.js";
import { Logger } from "../utils/logger.js";
import { saveInstanceId } from "../config.js";

export interface ChildConfig {
  worktreePath: string;
  name: string;
  role: string;
  instanceId: string;
  branch: string;
  zkHosts: string;
  debug: boolean;
  cliCommand: string;
  cacheDir: string;
}

export async function startWorkerChild(config: ChildConfig): Promise<void> {
  const logger = new Logger(`Worker-${config.name}`);

  // 1. Switch to worktree directory
  process.chdir(config.worktreePath);
  logger.info(`Working in ${config.worktreePath}`);

  // 2. Connect to ZK
  const zk = new ZkClient(config.zkHosts);
  await zk.connect();

  // 3. Register instance (EPHEMERAL) with worktree metadata
  const registry = new InstanceRegistry(zk);
  const instance = await registry.register(config.name, config.role, config.instanceId);

  // Update instance with worktree metadata
  try {
    await zk.updateInstance(instance.id, {
      ...(instance as unknown as Record<string, unknown>),
      worktree_name: config.name,
      worktree_path: config.worktreePath,
      worktree_branch: config.branch,
      pid: process.pid,
    });
  } catch {
    // Instance may have been deleted or session expired
  }

  saveInstanceId(instance.id);

  // 4. Resolve leader instance ID for cache path
  let leaderInstanceId = instance.id;
  try {
    const leaderData = await zk.getLeader();
    if (leaderData?.instance_id) {
      leaderInstanceId = leaderData.instance_id as string;
    }
  } catch {
    // Leader not running yet, use own instance id
  }

  // 5. Initialize modules
  const agentsDir = path.join(config.worktreePath, ".claude-orchestrator", "agents");
  const runner = new ClaudeRunner(
    config.cliCommand,
    config.cacheDir,
    leaderInstanceId,
    config.worktreePath,
  );

  const templateEngine = new TemplateEngine(agentsDir);
  const evaluator = new SelfEvaluator(templateEngine, runner, config.name, config.role);
  const commitChecker = new CommitChecker(config.worktreePath, runner);
  const hooks = new HookEngine();

  const watcher = new WorkerWatcher(
    zk,
    instance.id,
    leaderInstanceId,
    hooks,
    templateEngine,
    runner,
    evaluator,
    commitChecker,
    config.worktreePath,
    config.branch,
  );

  // 6. Start watch loop (non-blocking after initial setup)
  watcher.start().catch((err) => {
    logger.error("Watcher error", err);
  });

  // 7. Start parent alive check
  const parentCheck = startParentAliveCheck(watcher, zk);

  // 8. Block until SIGINT or parent death
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(parentCheck);
      watcher.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      clearInterval(parentCheck);
      watcher.stop();
      resolve();
    });
  });

  // 9. Cleanup
  try {
    await registry.unregister(instance.id);
  } catch {
    // Already gone
  }
  await zk.disconnect();
  logger.info("Unregistered. Goodbye.");
}

function startParentAliveCheck(
  watcher: WorkerWatcher,
  zk: ZkClient,
): ReturnType<typeof setInterval> {
  const parentPid = process.ppid;

  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      watcher.stop();
      zk.disconnect();
      process.exit(0);
    }
  }, 1000);

  return timer;
}
