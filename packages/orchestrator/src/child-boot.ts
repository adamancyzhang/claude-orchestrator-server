import * as fs from "node:fs";
import * as path from "node:path";
import {
  asInstanceId,
  PROTOCOL_VERSION,
  zkPaths,
  type ILogger,
  type InstanceRole,
} from "@co/contracts";
import { Logger, ZkClient } from "@co/infra";
import {
  ClaudeRunner,
  HookEngine,
  TemplateEngine,
} from "@co/runtime";
import {
  InstanceRegistry,
  MessageRouter,
} from "@co/coordination";
import {
  CHAIN_LINKS,
  CommitChecker,
  SelfEvaluator,
  WorkerWatcher,
  registerChildBoot,
  type ChildConfig,
} from "@co/worker";
import { startParentAliveCheck } from "./child-supervisor.js";

void CHAIN_LINKS;

function resolveTemplateDir(worktreePath: string): string {
  const projectRoot = path.resolve(worktreePath, "..", "..", "..");
  const candidates = [
    path.join(projectRoot, "packages", "orchestrator", "dist", "templates"),
    path.join(projectRoot, "templates"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[1];
}

async function boot(config: ChildConfig): Promise<void> {
  process.chdir(config.worktree_path);
  const logger: ILogger = new Logger({
    namespace: `worker/${config.name}`,
    level: config.debug ? "debug" : "info",
  });
  const ensurePaths = zkPaths.allEnsurePaths();
  const zk = new ZkClient({
    hosts: config.zk_hosts,
    ensure_paths: ensurePaths,
  });
  await zk.connect();

  const registry = new InstanceRegistry({ zk });
  const instance = await registry.register({
    id: asInstanceId(config.instance_id),
    name: config.name,
    role: config.role as InstanceRole,
    worktree_name: config.name as never,
    worktree_path: config.worktree_path,
    worktree_branch: config.branch,
    pid: process.pid,
  });
  void PROTOCOL_VERSION;

  const messageRouter = new MessageRouter({ zk });

  const builtinAgentsDir = path.join(resolveTemplateDir(config.worktree_path), "agents");
  const projectAgentsDir = path.join(
    config.worktree_path,
    ".claude-orchestrator",
    "agents",
  );
  const templateEngine = new TemplateEngine({
    primary_dir: projectAgentsDir,
    fallback_dir: builtinAgentsDir,
  });

  const runner = new ClaudeRunner(config.cli_command, logger);
  const identitySystemPrompt = ClaudeRunner.buildIdentityPrompt(
    templateEngine.has("worker-identity.md")
      ? templateEngine.load("worker-identity.md")
      : "You are {{name}}, a {{role}}.",
    {
      name: config.name,
      role: config.role,
      worktree_path: config.worktree_path,
      worktree_branch: config.branch,
      instance_id: config.instance_id,
    },
  );

  const cachePathOpts = {
    cache_dir: config.cache_dir,
    leader_instance_id: asInstanceId(config.leader_instance_id),
  };

  const evaluator = new SelfEvaluator({
    runner,
    template_engine: templateEngine,
    logger: logger.child("evaluator"),
    cache_paths: cachePathOpts,
    worktree_path: config.worktree_path,
    identity_system_prompt: identitySystemPrompt,
  });

  const commitChecker = new CommitChecker({
    worktree_path: config.worktree_path,
    runner,
    template_engine: templateEngine,
    logger: logger.child("commit"),
    cache_paths: cachePathOpts,
    worker_name: config.name,
  });

  const hooks = new HookEngine([], logger.child("hooks"));

  const watcher = new WorkerWatcher({
    instance_id: instance.id,
    leader_id: asInstanceId(config.leader_instance_id),
    worker_name: config.name,
    worker_role: config.role,
    worktree_path: config.worktree_path,
    worktree_branch: config.branch,
    registry,
    message_router: messageRouter,
    runner,
    template_engine: templateEngine,
    hooks,
    evaluator,
    commit_checker: commitChecker,
    cache_paths: cachePathOpts,
    identity_system_prompt: identitySystemPrompt,
    logger: logger.child("watcher"),
  });

  await watcher.start();

  const aliveCheck = startParentAliveCheck(() => {
    logger.warn("parent died — exiting");
    watcher.stop();
    void zk.close();
    process.exit(0);
  });

  await new Promise<void>((resolve) => {
    const cleanup = async () => {
      clearInterval(aliveCheck);
      watcher.stop();
      await registry.unregister(instance.id).catch(() => undefined);
      await zk.close();
      resolve();
    };
    process.once("SIGINT", () => void cleanup());
    process.once("SIGTERM", () => void cleanup());
  });
  logger.info("goodbye");
}

registerChildBoot(boot);
