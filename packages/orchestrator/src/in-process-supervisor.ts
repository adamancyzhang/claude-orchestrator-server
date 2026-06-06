import * as path from "node:path";
import {
  asInstanceId,
  cachePaths,
  type ILogger,
  type Instance,
  type InstanceId,
  type IZkClient,
} from "@co/contracts";
import { buildWorkerSystemPrompt, ClaudeRunner, HookEngine, TemplateEngine } from "@co/runtime";
import {
  InstanceRegistry,
  MessageRouter,
  TaskQueue,
} from "@co/coordination";
import {
  CommitChecker,
  SelfEvaluator,
  WorkerActivityReporter,
  WorkerDocsCommitter,
  WorkerWatcher,
} from "@co/worker";
import type {
  IChildSupervisor,
  ChildSupervisorOptions,
} from "./child-supervisor.js";
import type { WorktreeConfig } from "./worktree-initializer.js";

interface RegisteredWorker {
  config: WorktreeConfig;
  instance: Instance;
  watcher: WorkerWatcher;
  activity_reporter: WorkerActivityReporter;
}

/**
 * Simple FIFO async mutex that serializes in-process git operations
 * (WorkerDocsCommitter uses `git commit --only` which can race on
 * `.git/index.lock` when workers share the same CO root).
 */
function createAsyncMutex() {
  let chain: Promise<void> = Promise.resolve();
  return {
    async acquire(): Promise<() => void> {
      let release!: () => void;
      const next = new Promise<void>((res) => {
        release = res;
      });
      const wait = chain;
      chain = chain.then(() => next);
      await wait;
      return release;
    },
  };
}

export class InProcessSupervisor implements IChildSupervisor {
  private readonly registry: InstanceRegistry;
  private readonly registered: RegisteredWorker[] = [];
  private readonly mutex = createAsyncMutex();
  private readonly hooks: ChildSupervisorOptions["hooks"];
  private readonly gitRemote: string | null;
  private readonly magicMode: boolean;

  constructor(
    private readonly zk: IZkClient,
    private readonly opts: {
      cli_command: string;
      template_dir: string;
      cache_paths: cachePaths.CachePathOptions;
      leader_instance_id: InstanceId;
      hooks: ChildSupervisorOptions["hooks"];
      git_remote: string | null;
      magic_mode: boolean;
      logger: ILogger;
    },
  ) {
    this.registry = new InstanceRegistry({ zk });
    this.hooks = opts.hooks;
    this.gitRemote = opts.git_remote;
    this.magicMode = opts.magic_mode;
  }

  async start(configs: readonly WorktreeConfig[]): Promise<void> {
    for (const cfg of configs) {
      const logger = this.opts.logger.child(`inproc/${cfg.name}`);
      const instance = await this.registry.register({
        id: cfg.instance_id,
        name: cfg.name,
        role: cfg.role,
        pid: process.pid,
        work_dir: cfg.worktree_path,
        worktree_path: cfg.worktree_path,
        worktree_branch: cfg.branch,
      });

      const { watcher, activity_reporter } = this.buildWatcher(
        cfg,
        instance,
        logger,
      );
      this.registered.push({ config: cfg, instance, watcher, activity_reporter });
      await watcher.start();
      logger.info(`in-process worker ${cfg.name} started`, {
        id: instance.id,
        role: cfg.role,
      });
    }
  }

  async shutdown(): Promise<void> {
    for (const r of this.registered) {
      r.watcher.stop();
      r.activity_reporter.stop();
      await this.registry.unregister(r.instance.id).catch(() => undefined);
    }
    this.registered.length = 0;
  }

  private buildWatcher(
    cfg: WorktreeConfig,
    instance: Instance,
    logger: ILogger,
  ): { watcher: WorkerWatcher; activity_reporter: WorkerActivityReporter } {
    const builtinDir = this.opts.template_dir;
    const projectAgentsDir = path.join(
      cfg.worktree_path,
      ".claude-orchestrator",
      "agents",
    );
    const templateEngine = new TemplateEngine({
      primary_dir: projectAgentsDir,
      fallback_dir: builtinDir,
    });

    const runner = new ClaudeRunner(this.opts.cli_command, logger);

    const coRoot = cachePaths.coRootDir(this.opts.cache_paths);
    const identitySystemPrompt = buildWorkerSystemPrompt(templateEngine, {
      name: cfg.name,
      role: cfg.role,
      origin_branch: null,
      worktree_path: cfg.worktree_path,
      worktree_branch: cfg.branch,
      co_root: coRoot,
      co_role_path: path.join(coRoot, "docs", cfg.name),
    });

    const messageRouter = new MessageRouter({ zk: this.zk });
    const taskQueue = new TaskQueue({ zk: this.zk });

    const activityReporter = new WorkerActivityReporter({
      router: messageRouter,
      identity: {
        instance_id: instance.id,
        worker_name: cfg.name,
        worker_role: cfg.role,
        leader_id: this.opts.leader_instance_id,
      },
      logger: logger.child("activity"),
    });

    const evaluator = new SelfEvaluator({
      runner,
      template_engine: templateEngine,
      logger: logger.child("evaluator"),
      cache_paths: this.opts.cache_paths,
      worktree_path: cfg.worktree_path,
      identity_system_prompt: identitySystemPrompt,
      worker_name: cfg.name,
      worker_role: cfg.role,
      activity_reporter: activityReporter,
    });

    const commitChecker = new CommitChecker({
      worktree_path: cfg.worktree_path,
      runner,
      template_engine: templateEngine,
      logger: logger.child("commit"),
      cache_paths: this.opts.cache_paths,
      worker_name: cfg.name,
    });

    const docsCommitter = new WorkerDocsCommitter({
      co_root: coRoot,
      worker_name: cfg.name,
      runner,
      template_engine: templateEngine,
      cache_paths: this.opts.cache_paths,
      logger: logger.child("docs-commit"),
      docs_commit_mutex: this.mutex,
    });

    const hooks = new HookEngine(
      this.hooks.map((h) => ({
        event: h.event,
        command: h.command,
        enabled: h.enabled,
      })),
      logger.child("hooks"),
    );

    const watcher = new WorkerWatcher({
      instance_id: instance.id,
      leader_id: this.opts.leader_instance_id,
      worker_name: cfg.name,
      worker_role: cfg.role,
      worktree_path: cfg.worktree_path,
      worktree_branch: cfg.branch,
      registry: this.registry,
      message_router: messageRouter,
      task_queue: taskQueue,
      runner,
      template_engine: templateEngine,
      hooks,
      evaluator,
      commit_checker: commitChecker,
      docs_committer: docsCommitter,
      cache_paths: this.opts.cache_paths,
      identity_system_prompt: identitySystemPrompt,
      logger: logger.child("watcher"),
      git_remote: this.gitRemote,
      magic_mode: this.magicMode,
      activity_reporter: activityReporter,
    });
    return { watcher, activity_reporter: activityReporter };
  }
}
