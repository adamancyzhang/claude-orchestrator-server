import * as path from "node:path";
import {
  asInstanceId,
  cachePaths,
  type ILogger,
  type Instance,
  type InstanceId,
  type IZkClient,
} from "@co/contracts";
import { ClaudeRunner, HookEngine, TemplateEngine } from "@co/runtime";
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

      const watcher = this.buildWatcher(cfg, instance, logger);
      this.registered.push({ config: cfg, instance, watcher });
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
      await this.registry.unregister(r.instance.id).catch(() => undefined);
    }
    this.registered.length = 0;
  }

  private buildWatcher(
    cfg: WorktreeConfig,
    instance: Instance,
    logger: ILogger,
  ): WorkerWatcher {
    const builtinAgentsDir = path.join(this.opts.template_dir, "agents");
    const projectAgentsDir = path.join(
      cfg.worktree_path,
      ".claude-orchestrator",
      "agents",
    );
    const templateEngine = new TemplateEngine({
      primary_dir: projectAgentsDir,
      fallback_dir: builtinAgentsDir,
    });

    const runner = new ClaudeRunner(this.opts.cli_command, logger);

    // Same identity-card assembly as child-boot.ts
    const ROLE_TO_SYSTEM_TEMPLATE: Record<string, string> = {
      planner: "worker-planner.md",
      executor: "worker-executor.md",
      verifier: "worker-verifier.md",
      reviewer: "worker-reviewer.md",
      accepter: "worker-accepter.md",
      explorer: "worker-explorer.md",
    };
    const identityTpl = templateEngine.has("worker-identity.md")
      ? templateEngine.load("worker-identity.md")
      : "You are {{name}}, a {{role}}.";
    const coRoot = cachePaths.coRootDir(this.opts.cache_paths);
    const personalTplName = `personal-claude-${cfg.role}.md`;
    const personalTpl = templateEngine.has(personalTplName)
      ? templateEngine.render(personalTplName, {
          name: cfg.name,
          role: cfg.role,
          co_root: coRoot,
        })
      : "";
    const roleTplName = ROLE_TO_SYSTEM_TEMPLATE[cfg.role];
    const roleTpl =
      roleTplName && templateEngine.has(roleTplName)
        ? templateEngine.load(roleTplName)
        : "";
    const identityParts = [identityTpl, personalTpl, roleTpl].filter(
      (s) => s.length > 0,
    );
    const identitySystemPrompt = ClaudeRunner.buildIdentityPrompt(
      identityParts.join("\n\n---\n\n"),
      {
        name: cfg.name,
        role: cfg.role,
        worktree_path: cfg.worktree_path,
        worktree_branch: cfg.branch,
        co_root: coRoot,
      },
    );

    const evaluator = new SelfEvaluator({
      runner,
      template_engine: templateEngine,
      logger: logger.child("evaluator"),
      cache_paths: this.opts.cache_paths,
      worktree_path: cfg.worktree_path,
      identity_system_prompt: identitySystemPrompt,
      worker_name: cfg.name,
      worker_role: cfg.role,
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

    const messageRouter = new MessageRouter({ zk: this.zk });
    const taskQueue = new TaskQueue({ zk: this.zk });

    return new WorkerWatcher({
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
    });
  }
}
