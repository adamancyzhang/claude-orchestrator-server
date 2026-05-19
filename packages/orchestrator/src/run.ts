import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  asInstanceId,
  PROTOCOL_VERSION,
  zkPaths,
  type ILogger,
  type InstanceId,
  type IZkClient,
  type ZkPath,
} from "@co/contracts";
import {
  Logger,
  ZkClient,
  captureConsoleToFile,
  loadConfig,
  restoreConsole,
  saveInstanceId,
} from "@co/infra";
import {
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
  ChainAudit,
  ChainRouter,
  LeaderEventBus,
  LeaderState,
  LeaderWatcher,
  MemoryBootstrap,
  MergeValidator,
  StdinKeyboardSource,
  StdoutSink,
  StreamTailer,
  TaskOrchestrator,
  TaskRecovery,
  TuiController,
  WorkerMonitor,
} from "@co/leader";
import {
  ChildSupervisor,
  type ChildSupervisorOptions,
  type IChildSupervisor,
} from "./child-supervisor.js";
import {
  InitChecker,
  createGlobalConfigStep,
  createSkillsStep,
  createTeamClaudeMdStep,
  createUserClaudeMdStep,
} from "./init-checker.js";
import { initializeWorktrees } from "./worktree-initializer.js";
import { ensureCoRoot } from "./co-root-initializer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RunInput {
  zk_hosts: string;
  worker_count: number;
  name?: string;
  debug?: boolean;
  y_flag?: boolean;
  // v0.7 NEW — `--magic` (autonomous loop). Enables the explore link
  // and spawn_chain decisions across the cluster.
  magic?: boolean;
  // v0.7 NEW — hard cap on chain_forest depth. `null` (default) is
  // unlimited. Env `CO_MAGIC_MAX_CHAINS` overrides this argument when
  // present and parseable.
  magic_max_chains?: number | null;
}

export interface OrchestratorPaths {
  template_dir: string;
  skills_dir: string;
  child_module: string;
}

export interface ZkClientFactoryInput {
  hosts: string;
  session_timeout_ms: number;
  ensure_paths: readonly ZkPath[];
}

export interface OrchestratorDeps {
  /**
   * Factory for the leader's ZK client. Defaults to `new ZkClient(opts)`.
   * Tests inject an in-memory fake here.
   */
  zk_factory?: (opts: ZkClientFactoryInput) => IZkClient;
  /**
   * Factory for the child supervisor (worker fork manager). Defaults
   * to `new ChildSupervisor(opts)`. Tests inject a fake that simulates
   * worker registration without forking real processes.
   */
  supervisor_factory?: (opts: ChildSupervisorOptions) => IChildSupervisor;
  /**
   * When true, skip console capture and TUI startup. Used by tests so
   * they don't have their stdout hijacked or stdin raw-moded.
   */
  headless?: boolean;
  /**
   * Optional extra shutdown signal. When this promise resolves, the
   * orchestrator runs cleanup and returns (same effect as SIGINT).
   * Used by tests to drive the run loop to a clean exit.
   */
  shutdown_signal?: Promise<void>;
}

export function defaultPaths(): OrchestratorPaths {
  const pkgRoot = path.resolve(__dirname, "..");
  const projectRoot = path.resolve(pkgRoot, "..", "..");
  return {
    template_dir: path.join(projectRoot, "templates"),
    skills_dir: path.join(projectRoot, "skills"),
    child_module: path.join(__dirname, "child.js"),
  };
}

export async function runOrchestrator(
  input: RunInput,
  paths: OrchestratorPaths = defaultPaths(),
  deps: OrchestratorDeps = {},
): Promise<void> {
  const logger: ILogger = new Logger({
    namespace: "orchestrator",
    level: input.debug ? "debug" : "info",
  });

  // Phase 1: env / init
  const projectRoot = process.cwd();
  ensureCleanWorkspace(projectRoot);
  const initChecker = new InitChecker({ y_flag: input.y_flag ?? false, logger });
  await initChecker.runAll([
    createGlobalConfigStep(logger),
    createUserClaudeMdStep(paths.template_dir, logger),
    createTeamClaudeMdStep(paths.template_dir, projectRoot, logger),
    createSkillsStep(paths.skills_dir, projectRoot, logger),
  ]);
  // Phase 3 used to live further down; we need ResolvedConfig BEFORE
  // commitInitFiles so the auto_commit_init_files toggle is honored.
  const resolved = loadConfig({
    cli_zookeeper: input.zk_hosts,
    cli_debug: input.debug,
  });
  commitInitFiles(projectRoot, logger, {
    enabled: resolved.git.auto_commit_init_files,
    branch: resolved.git.auto_commit_init_files_branch,
  });

  // Phase 2: worktrees
  // v0.7 NEW — resolve magic-mode + depth cap. Env overrides CLI.
  const magicMode = input.magic === true;
  const envMaxChainsRaw = process.env.CO_MAGIC_MAX_CHAINS;
  const envMaxChains =
    envMaxChainsRaw && Number.isFinite(Number(envMaxChainsRaw))
      ? Number(envMaxChainsRaw)
      : null;
  const magicMaxChains =
    envMaxChains != null
      ? envMaxChains
      : input.magic_max_chains ?? null;

  const worktreeConfigs = await initializeWorktrees({
    project_root: projectRoot,
    worker_count: input.worker_count,
    template_dir: paths.template_dir,
    skills_dir: paths.skills_dir,
    logger: logger.child("worktree"),
    magic_mode: magicMode,
  });
  const leaderId = asInstanceId(randomUUID().replace(/-/g, ""));

  const zkOpts = {
    hosts: resolved.zk.hosts,
    session_timeout_ms: resolved.zk.session_timeout_ms,
    ensure_paths: zkPaths.allEnsurePaths(),
  };
  const zk: IZkClient = deps.zk_factory
    ? deps.zk_factory(zkOpts)
    : new ZkClient(zkOpts);
  await zk.connect();

  await zk.createEphemeral(
    zkPaths.leader(),
    Buffer.from(
      JSON.stringify({
        protocol_version: PROTOCOL_VERSION,
        leader_id: leaderId,
        pid: process.pid,
        host: os.hostname(),
        started_at: new Date().toISOString(),
        // v0.7 NEW — broadcast magic flags so workers know whether
        // spawn_chain decisions and explore links are in play.
        magic_mode: magicMode,
        magic_max_chains: magicMaxChains,
      }),
      "utf-8",
    ),
  );

  const registry = new InstanceRegistry({ zk });
  const leaderInstance = await registry.register({
    id: leaderId,
    name: input.name ?? "Leader",
    role: "leader",
    pid: process.pid,
    work_dir: projectRoot,
  });
  saveInstanceId(leaderInstance.id);

  const coRoot = await ensureCoRoot({
    projects_root: resolved.projects_root,
    leader_instance_id: leaderInstance.id,
    git_command: resolved.commands.git,
    logger: logger.child("co-root"),
    auto_commit_init_files: resolved.git.auto_commit_init_files,
  });
  if (!deps.headless) captureConsoleToFile(coRoot);

  const messageRouter = new MessageRouter({ zk });
  const taskQueue = new TaskQueue({ zk });

  const bus = new LeaderEventBus();
  const state = new LeaderState();
  bus.onAny((event) => state.apply(event));

  const templateEngine = new TemplateEngine({
    primary_dir: path.join(paths.template_dir, "agents"),
  });
  const runner = new ClaudeRunner(resolved.commands.claude_cli, logger.child("runner"));
  const hookEntries = resolved.hooks.map((h) => ({
    event: h.event,
    command: h.command,
    enabled: h.enabled,
  }));
  const hookEngine = new HookEngine(hookEntries, logger.child("hooks"));
  void hookEngine;

  const cachePaths = {
    projects_root: resolved.projects_root,
    leader_instance_id: leaderInstance.id,
  };

  const mergeValidator = new MergeValidator({
    project_root: projectRoot,
    runner,
    template_engine: templateEngine,
    template_name: "worker-merge-decision.md",
    bus,
    logger: logger.child("merge"),
    log_path_for: (key) => path.join(coRoot, "merges", `${key}.log`),
    merge_target_branch: resolved.git.merge_target_branch,
    remote: resolved.git.remote,
  });

  const chainAudit = new ChainAudit({
    cache_paths: cachePaths,
    logger: logger.child("chain-audit"),
  });

  // Memory bootstrap is constructed before ChainRouter so we can hand
  // the same instance to ChainRouter for both `/init` (user-triggered
  // full bootstrap + stale sweep) and `memory_refresh` (per-commit
  // incremental refresh). The bootstrap does NOT run automatically on
  // startup — the user kicks it explicitly by typing `/init` in the TUI
  // because a full pass calls claude-cli ~once per source file and is
  // expensive to launch unsolicited.
  const memoryBootstrap = new MemoryBootstrap({
    cache_paths: cachePaths,
    workspace_root: projectRoot,
    runner,
    template_engine: templateEngine,
    logger: logger.child("memory-bootstrap"),
  });

  // CO_CHAIN_MAX_RETRIES caps the total feedback retries a chain may
  // accumulate before ChainRouter forcibly aborts it. Unset → ChainAudit
  // applies its built-in default (DEFAULT_MAX_TOTAL_RETRIES = 9).
  const envMaxRetries = process.env.CO_CHAIN_MAX_RETRIES;
  const maxChainRetries =
    envMaxRetries && Number.isFinite(Number(envMaxRetries))
      ? Number(envMaxRetries)
      : undefined;

  const chainRouter = new ChainRouter({
    task_queue: taskQueue,
    message_router: messageRouter,
    registry,
    bus,
    runner,
    template_engine: templateEngine,
    logger: logger.child("chain"),
    leader_id: leaderInstance.id,
    leader_name: leaderInstance.name,
    cache_paths: cachePaths,
    merge_validator: mergeValidator,
    chain_audit: chainAudit,
    memory_bootstrap: memoryBootstrap,
    max_chain_retries: maxChainRetries,
    magic_mode: magicMode,
    magic_max_chains: magicMaxChains,
  });

  // v0.7 NEW — seed LeaderState so the TUI [MAGIC] badge renders on
  // first frame instead of waiting for the next chain event. The
  // event must be emitted AFTER the bus is wired to state.apply.
  bus.emit({
    type: "magic_mode_configured",
    magic_mode: magicMode,
    magic_max_chains: magicMaxChains,
  });

  const leaderWatcher = new LeaderWatcher(
    messageRouter,
    bus,
    chainRouter,
    leaderInstance.id,
    logger.child("watcher"),
  );
  await leaderWatcher.start();

  const monitor = new WorkerMonitor(registry, bus);
  await monitor.start();

  const taskOrch = new TaskOrchestrator(taskQueue, bus);
  await taskOrch.start();

  const recovery = new TaskRecovery(taskQueue, registry, bus, logger.child("recovery"));
  recovery.start();
  await recovery.scanOrphans();

  const tailer = new StreamTailer();
  void tailer;

  const tui = new TuiController({
    state,
    bus,
    message_router: messageRouter,
    keyboard: new StdinKeyboardSource(),
    sink: new StdoutSink(),
    logger: logger.child("tui"),
    leader_id: leaderInstance.id,
    leader_name: leaderInstance.name,
    projects_root: resolved.projects_root,
  });
  if (!deps.headless) tui.start();

  // Phase 4: fork workers
  const supervisorOpts: ChildSupervisorOptions = {
    child_module_path: paths.child_module,
    zk_hosts: resolved.zk.hosts,
    cli_command: resolved.commands.claude_cli,
    projects_root: resolved.projects_root,
    leader_instance_id: leaderInstance.id,
    debug: input.debug ?? false,
    git_remote: resolved.git.remote,
    logger: logger.child("supervisor"),
  };
  const supervisor: IChildSupervisor = deps.supervisor_factory
    ? deps.supervisor_factory(supervisorOpts)
    : new ChildSupervisor(supervisorOpts);
  const workerConfigsForSupervisor = worktreeConfigs.map((c) => ({
    ...c,
    instance_id: c.instance_id,
  }));
  await Promise.resolve(supervisor.start(workerConfigsForSupervisor));

  // Phase 5: wait for shutdown
  await new Promise<void>((resolve) => {
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await supervisor.shutdown();
      leaderWatcher.stop();
      monitor.stop();
      taskOrch.stop();
      if (!deps.headless) tui.stop();
      restoreConsole();
      await registry.unregister(leaderInstance.id).catch(() => undefined);
      await zk.close();
      resolve();
    };
    process.once("SIGINT", () => void cleanup());
    process.once("SIGTERM", () => void cleanup());
    if (deps.shutdown_signal) {
      void deps.shutdown_signal.then(() => cleanup());
    }
  });
}

function ensureCleanWorkspace(projectRoot: string): void {
  let status = "";
  try {
    status = execSync("git status --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return; // not a git repo — allow
  }
  if (status.length > 0) {
    throw new Error("Workspace has uncommitted changes");
  }
}

interface CommitInitFilesOptions {
  enabled: boolean;
  branch: string | null;
}

function commitInitFiles(
  projectRoot: string,
  logger: ILogger,
  opts: CommitInitFilesOptions,
): void {
  if (!opts.enabled) {
    logger.info("auto_commit_init_files disabled — skipping init commit");
    return;
  }
  let status = "";
  try {
    status = execSync("git status --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return;
  }
  if (!status) return;
  try {
    if (opts.branch) {
      // Redirect init commits to a dedicated branch so the user's
      // working branch is not polluted by orchestrator boilerplate.
      execSync(`git checkout -B ${opts.branch}`, { cwd: projectRoot });
    }
    execSync("git add -A", { cwd: projectRoot });
    execSync('git commit -m "chore: init orchestrator workspace files"', {
      cwd: projectRoot,
    });
    logger.info("committed init workspace files");
  } catch (err) {
    logger.warn("init file commit skipped", { error: String(err) });
  }
}

export type { InstanceId };
