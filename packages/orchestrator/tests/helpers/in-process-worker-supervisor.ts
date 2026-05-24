// TRUST-JUSTIFICATION: In-process IChildSupervisor used by
// `packages/orchestrator/tests/core/e2e/leader-worker-communication.test.ts`.
// Downstream: replaces `ChildSupervisor.spawn()` which forks Node child
//   processes that call into `packages/orchestrator/src/child-boot.ts`.
// Reason: eval 02 requires the FULL worker watch loop to run (not just
//   ephemeral-node registration like `fake-child-supervisor.ts`). Forking
//   real children would also require real ZK (children connect via the
//   `zk_hosts` arg, not the leader's shared in-memory instance) and real
//   claude-cli (each child constructs its own `new ClaudeRunner(...)`).
//   Running watchers in-process lets us share the in-memory ZK fake and
//   inject a stub IClaudeRunner uniformly across leader + 6 workers.
// Evidence: this supervisor mirrors `packages/orchestrator/src/child-boot.ts`
//   lines 42-192 — the same template engine, hook engine, evaluator,
//   commit checker, docs committer, and watcher constructors that the
//   forked child wires up. The only omissions are `process.chdir()`
//   (workers pass `cwd` explicitly to all git invocations) and the
//   parent-alive sentinel (no parent process to monitor in-test).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  asInstanceId,
  cachePaths,
  type IClaudeRunner,
  type ILogger,
  type Instance,
  type InstanceId,
  type InstanceRole,
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
  type DocsCommitMutex,
} from "@co/worker";
import type {
  IChildSupervisor,
  ChildSupervisorOptions,
} from "../../src/child-supervisor.js";
import type { WorktreeConfig } from "../../src/worktree-initializer.js";

export interface InProcessWorkerSupervisorOptions {
  /** Same ZK the leader uses, so registrations + messages are observable. */
  zk: IZkClient;
  /**
   * Builds the IClaudeRunner each worker uses. Test usually returns the
   * same FakeClaudeRunner instance so call counts aggregate across workers.
   */
  runner_factory: (cfg: WorktreeConfig) => IClaudeRunner;
  /** Repository templates dir — same primary source the production worker uses. */
  template_dir: string;
  /** CO root path (`<projects_root>/<leader_id>`) — same as cachePaths.coRootDir. */
  cache_paths: cachePaths.CachePathOptions;
  leader_id: InstanceId;
  /** Resolved hook commands, same shape the supervisor would forward. */
  hooks: ChildSupervisorOptions["hooks"];
  git_remote: string | null;
  magic_mode: boolean;
  /** Fake-process pid for the first worker; subsequent workers get +1. */
  base_pid?: number;
  logger: ILogger;
  /**
   * Shared async mutex passed to every WorkerDocsCommitter so concurrent
   * in-process workers don't race on `.git/index.lock` in the CO root.
   * The default `createAsyncMutex()` is fine for most tests.
   */
  docs_commit_mutex?: DocsCommitMutex;
}

interface RegisteredWorker {
  config: WorktreeConfig;
  instance: Instance;
  watcher: WorkerWatcher;
}

/**
 * Simple FIFO async mutex. Resolves the next waiter when `release()` is
 * called. Suitable for the e2e test's CO-root docs-commit serialization.
 */
export function createAsyncMutex(): DocsCommitMutex {
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

export class InProcessWorkerSupervisor implements IChildSupervisor {
  private readonly registry: InstanceRegistry;
  private readonly registered: RegisteredWorker[] = [];
  private readonly mutex: DocsCommitMutex;

  constructor(private readonly opts: InProcessWorkerSupervisorOptions) {
    this.registry = new InstanceRegistry({ zk: opts.zk });
    this.mutex = opts.docs_commit_mutex ?? createAsyncMutex();
  }

  async start(configs: readonly WorktreeConfig[]): Promise<void> {
    const basePid = this.opts.base_pid ?? 9000;
    for (let i = 0; i < configs.length; i++) {
      const cfg = configs[i];
      const instance = await this.registry.register({
        id: asInstanceId(cfg.instance_id),
        name: cfg.name,
        role: cfg.role,
        pid: basePid + i,
        work_dir: cfg.worktree_path,
        worktree_path: cfg.worktree_path,
        worktree_branch: cfg.branch,
      });

      const watcher = this.buildWatcher(cfg, instance);
      this.registered.push({ config: cfg, instance, watcher });
      // start() resolves immediately once the ZK watch is armed; the
      // actual processing happens on incoming watch fires.
      await watcher.start();
      this.opts.logger.info(`in-process worker ${cfg.name} started`, {
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

  /** Test introspection — names in registration order. */
  get_registered(): readonly { id: InstanceId; name: string; role: InstanceRole }[] {
    return this.registered.map((r) => ({
      id: r.instance.id,
      name: r.instance.name,
      role: r.config.role,
    }));
  }

  /** Test introspection — the live watcher map for direct assertions. */
  get_watchers(): ReadonlyMap<InstanceId, WorkerWatcher> {
    return new Map(this.registered.map((r) => [r.instance.id, r.watcher]));
  }

  private buildWatcher(cfg: WorktreeConfig, instance: Instance): WorkerWatcher {
    const logger = this.opts.logger.child(`watcher/${cfg.name}`);

    const builtinAgentsDir = path.join(this.opts.template_dir, "agents");
    const projectAgentsDir = path.join(
      cfg.worktree_path,
      ".claude-orchestrator",
      "agents",
    );
    const templateEngine = new TemplateEngine({
      primary_dir: projectAgentsDir,
      fallback_dir: fs.existsSync(builtinAgentsDir) ? builtinAgentsDir : undefined,
    });

    const runner = this.opts.runner_factory(cfg);

    // System prompt = identity card + (per-role) standing responsibility
    // description. Mirrors child-boot.ts:82-119 so FakeClaudeRunner can
    // reliably extract role from system_prompt.
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
    const personalTplName = `personal-claude-${cfg.role}.md`;
    const personalTpl = templateEngine.has(personalTplName)
      ? templateEngine.render(personalTplName, {
          name: cfg.name,
          role: cfg.role,
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
      co_root: cachePaths.coRootDir(this.opts.cache_paths),
      worker_name: cfg.name,
      runner,
      template_engine: templateEngine,
      cache_paths: this.opts.cache_paths,
      logger: logger.child("docs-commit"),
      docs_commit_mutex: this.mutex,
    });

    const hooks = new HookEngine(
      this.opts.hooks.map((h) => ({
        event: h.event,
        command: h.command,
        enabled: h.enabled,
      })),
      logger.child("hooks"),
    );

    const messageRouter = new MessageRouter({ zk: this.opts.zk });
    const taskQueue = new TaskQueue({ zk: this.opts.zk });

    return new WorkerWatcher({
      instance_id: instance.id,
      leader_id: this.opts.leader_id,
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
      logger: logger.child("watcher-loop"),
      git_remote: this.opts.git_remote,
      magic_mode: this.opts.magic_mode,
    });
  }
}
