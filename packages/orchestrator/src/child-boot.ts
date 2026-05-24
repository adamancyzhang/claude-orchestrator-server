import * as fs from "node:fs";
import * as path from "node:path";
import {
  asInstanceId,
  zkPaths,
  type ILogger,
  type InstanceRole,
} from "@co/contracts";
import { Logger, ZkClient } from "@co/infra";
import {
  buildWorkerSystemPrompt,
  ClaudeRunner,
  HookEngine,
  TemplateEngine,
} from "@co/runtime";
import {
  InstanceRegistry,
  MessageRouter,
  TaskQueue,
} from "@co/coordination";
import {
  CommitChecker,
  SelfEvaluator,
  WorkerDocsCommitter,
  WorkerWatcher,
  registerChildBoot,
  type ChildConfig,
} from "@co/worker";
import { startParentAliveCheck } from "./child-supervisor.js";

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

  const messageRouter = new MessageRouter({ zk });
  const taskQueue = new TaskQueue({ zk });

  const builtinDir = resolveTemplateDir(config.worktree_path);
  const projectAgentsDir = path.join(
    config.worktree_path,
    ".claude-orchestrator",
    "agents",
  );
  const templateEngine = new TemplateEngine({
    primary_dir: projectAgentsDir,
    fallback_dir: builtinDir,
  });

  const runner = new ClaudeRunner(config.cli_command, logger);

  const coRoot = path.join(config.projects_root, config.leader_instance_id);
  const identitySystemPrompt = buildWorkerSystemPrompt(templateEngine, {
    name: config.name,
    role: config.role,
    origin_branch: config.origin_branch ?? null,
    worktree_path: config.worktree_path,
    worktree_branch: config.branch,
    co_root: coRoot,
    co_role_path: path.join(coRoot, "docs", config.name),
  });

  const cachePathOpts = {
    projects_root: config.projects_root,
    leader_instance_id: asInstanceId(config.leader_instance_id),
  };

  const evaluator = new SelfEvaluator({
    runner,
    template_engine: templateEngine,
    logger: logger.child("evaluator"),
    cache_paths: cachePathOpts,
    worktree_path: config.worktree_path,
    identity_system_prompt: identitySystemPrompt,
    worker_name: config.name,
    worker_role: config.role,
  });

  const commitChecker = new CommitChecker({
    worktree_path: config.worktree_path,
    runner,
    template_engine: templateEngine,
    logger: logger.child("commit"),
    cache_paths: cachePathOpts,
    worker_name: config.name,
  });

  // CO root path is `${projects_root}/${leader_instance_id}` (see
  // cachePaths.coRootDir). All Worker processes share this single
  // working tree — WorkerDocsCommitter's `git commit --only` is what
  // keeps concurrent commits from leaking into each other.
  const docsCommitter = new WorkerDocsCommitter({
    co_root: coRoot,
    worker_name: config.name,
    runner,
    template_engine: templateEngine,
    cache_paths: cachePathOpts,
    logger: logger.child("docs-commit"),
  });

  const hooks = new HookEngine(
    (config.hooks ?? []).map((h) => ({
      event: h.event,
      command: h.command,
      enabled: h.enabled,
    })),
    logger.child("hooks"),
  );

  const watcher = new WorkerWatcher({
    instance_id: instance.id,
    leader_id: asInstanceId(config.leader_instance_id),
    worker_name: config.name,
    worker_role: config.role,
    worktree_path: config.worktree_path,
    worktree_branch: config.branch,
    registry,
    message_router: messageRouter,
    task_queue: taskQueue,
    runner,
    template_engine: templateEngine,
    hooks,
    evaluator,
    commit_checker: commitChecker,
    docs_committer: docsCommitter,
    cache_paths: cachePathOpts,
    identity_system_prompt: identitySystemPrompt,
    logger: logger.child("watcher"),
    git_remote: config.git_remote,
    magic_mode: config.magic_mode,
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
