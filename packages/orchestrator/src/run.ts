import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  asInstanceId,
  PROTOCOL_VERSION,
  zkPaths,
  type IClaudeRunner,
  type ILogger,
  type InstanceId,
  type IZkClient,
  type ZkPath,
} from "@co/contracts";
import {
  InMemoryZkClient,
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
  TaskOrchestrator,
  TaskRecovery,
  WorkerMonitor,
} from "@co/leader";
import {
  ChildSupervisor,
  type ChildSupervisorOptions,
  type IChildSupervisor,
} from "./child-supervisor.js";
import { InProcessSupervisor } from "./in-process-supervisor.js";
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
  // `--magic` (autonomous loop). Enables the explore link
  // and spawn_chain decisions across the cluster.
  magic?: boolean;
  // hard cap on chain_forest depth. `null` (default) is
  // unlimited. Env `CO_MAGIC_MAX_CHAINS` overrides this argument when
  // present and parseable.
  magic_max_chains?: number | null;
  // When true, use real ZooKeeper for message routing. Default (false)
  // uses an in-memory client shared between Leader and Workers.
  enabled_zookeeper?: boolean;
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
   * Factory for the leader's IClaudeRunner (used by ChainRouter's
   * `decompose` and MergeValidator's merge-decision render). Defaults
   * to `new ClaudeRunner(...)`. Tests inject a fake that returns canned
   * responses keyed on the prompt template.
   */
  claude_runner_factory?: (cli_command: string, logger: ILogger) => IClaudeRunner;
  /**
   * Test hook fired immediately after the LeaderEventBus is constructed
   * (before any subsystem starts), so tests can attach a recorder/tap.
   */
  on_leader_bus?: (bus: LeaderEventBus) => void;
  /**
   * When `false`, skip starting TaskRecovery (the orphan-task scanner).
   * Tests disable it so its polling can't re-dispatch a claimed task
   * mid-test and pollute the observable state.
   */
  recovery_enabled?: boolean;
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

  // Ensure a git repository with at least one commit exists before
  // anything else (git worktree add requires a valid repo + HEAD).
  ensureGitRepo(projectRoot, logger);

  const initChecker = new InitChecker({ y_flag: input.y_flag ?? false, logger });
  await initChecker.runAll([
    createGlobalConfigStep(logger),
    createUserClaudeMdStep(paths.template_dir, logger),
    createTeamClaudeMdStep(paths.template_dir, projectRoot, logger),
    createSkillsStep(paths.skills_dir, projectRoot, logger),
  ]);

  // Ensure .gitignore exists and covers orchestrator runtime directories
  // so they stay out of the project's git history.
  ensureGitignore(projectRoot, logger);

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

  // Verify the workspace is clean AFTER init files have been committed.
  // This catches uncommitted user changes that would be invisible to
  // the per-worker worktrees (they only see committed state).
  ensureCleanWorkspace(projectRoot);

  // Phase 2: worktrees
  // resolve magic-mode + depth cap. Env overrides CLI.
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

  const leaderId = resolved.instance_id ?? asInstanceId(randomUUID().replace(/-/g, ""));
  const coRoot = path.join(resolved.projects_root, leaderId);

  const worktreeConfigs = await initializeWorktrees({
    project_root: projectRoot,
    worker_count: input.worker_count,
    template_dir: paths.template_dir,
    logger: logger.child("worktree"),
    magic_mode: magicMode,
    leader_instance_id: leaderId,
    co_root: coRoot,
  });

  const zkEnsurePaths = zkPaths.allEnsurePaths();
  const zkOpts = {
    hosts: resolved.zk.hosts,
    session_timeout_ms: resolved.zk.session_timeout_ms,
    ensure_paths: zkEnsurePaths,
  };
  const useRealZk = input.enabled_zookeeper === true;
  const zk: IZkClient = deps.zk_factory
    ? deps.zk_factory(zkOpts)
    : useRealZk
      ? new ZkClient(zkOpts)
      : new InMemoryZkClient({ ensure_paths: zkEnsurePaths });
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
        // broadcast magic flags so workers know whether
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

  await ensureCoRoot({
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
  deps.on_leader_bus?.(bus);
  const state = new LeaderState();
  bus.onAny((event) => state.apply(event));

  const templateEngine = new TemplateEngine({
    primary_dir: path.join(paths.template_dir, "agents"),
    fallback_dir: paths.template_dir,
  });
  const runner: IClaudeRunner = deps.claude_runner_factory
    ? deps.claude_runner_factory(resolved.commands.claude_cli, logger.child("runner"))
    : new ClaudeRunner(resolved.commands.claude_cli, logger.child("runner"));
  const hookEntries = resolved.hooks.map((h) => ({
    event: h.event,
    command: h.command,
    enabled: h.enabled,
  }));
  const hookEngine = new HookEngine(hookEntries, logger.child("hooks"));

  const cachePaths = {
    projects_root: resolved.projects_root,
    leader_instance_id: leaderInstance.id,
  };

  const chainAudit = new ChainAudit({
    cache_paths: cachePaths,
    logger: logger.child("chain-audit"),
  });

  const mergeValidator = new MergeValidator({
    project_root: projectRoot,
    runner,
    template_engine: templateEngine,
    template_name: "workflow/merge-decision.md",
    bus,
    hooks: hookEngine,
    chain_audit: chainAudit,
    logger: logger.child("merge"),
    log_path_for: ({ chain_id, link, ts, kind }) => {
      const dir = chain_id
        ? path.join(coRoot, "merges", `chain-${chain_id}`)
        : path.join(coRoot, "merges", "misc");
      if (kind === "final") return path.join(dir, `final-${ts}.log`);
      const linkPart = link ?? "unknown";
      return path.join(dir, `merge-${linkPart}-${ts}.log`);
    },
    merge_target_branch: resolved.git.merge_target_branch,
    remote: resolved.git.remote,
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
    hooks: hookEngine,
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

  // seed LeaderState so the TUI [MAGIC] badge renders on
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

  const taskOrch = new TaskOrchestrator(taskQueue, bus, chainAudit);
  await taskOrch.start();

  const recovery = new TaskRecovery(
    taskQueue,
    registry,
    bus,
    logger.child("recovery"),
    chainAudit,
  );
  const recoveryEnabled = deps.recovery_enabled !== false;
  if (recoveryEnabled) {
    recovery.start();
    await recovery.scanOrphans();
  }

  let tui: null | { stop: () => Promise<void> } = null;
  if (!deps.headless) {
    const { TuiController } = await import("@co/leader/tui");
    const instance = new TuiController({
      state,
      bus,
      message_router: messageRouter,
      keyboard: new StdinKeyboardSource(),
      sink: new StdoutSink(),
      logger: logger.child("tui"),
      leader_id: leaderInstance.id,
      leader_name: leaderInstance.name,
    });
    await instance.start();
    tui = instance;
  }

  // Phase 4: start workers
  const cachePathOpts = {
    projects_root: resolved.projects_root,
    leader_instance_id: leaderInstance.id,
  };
  const forkSupervisorOpts: ChildSupervisorOptions = {
    child_module_path: paths.child_module,
    zk_hosts: resolved.zk.hosts,
    cli_command: resolved.commands.claude_cli,
    projects_root: resolved.projects_root,
    leader_instance_id: leaderInstance.id,
    debug: input.debug ?? false,
    git_remote: resolved.git.remote,
    hooks: resolved.hooks,
    magic_mode: magicMode,
    origin_branch: resolved.git.merge_target_branch,
    logger: logger.child("supervisor"),
  };
  const supervisor: IChildSupervisor = deps.supervisor_factory
    ? deps.supervisor_factory(forkSupervisorOpts)
    : useRealZk
      ? new ChildSupervisor(forkSupervisorOpts)
      : new InProcessSupervisor(zk, {
          cli_command: resolved.commands.claude_cli,
          template_dir: paths.template_dir,
          cache_paths: cachePathOpts,
          leader_instance_id: leaderInstance.id,
          hooks: resolved.hooks,
          git_remote: resolved.git.remote,
          magic_mode: magicMode,
          logger: logger.child("inproc"),
        });
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
      if (tui) await tui.stop();
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

function ensureGitRepo(projectRoot: string, logger: ILogger): void {
  let isRepo = false;
  try {
    execSync("git rev-parse --git-dir", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    isRepo = true;
  } catch {
    // not a git repo
  }

  if (!isRepo) {
    logger.info("initializing git repository...");
    execSync("git init", { cwd: projectRoot });
    // Create an empty initial commit so git worktree add has a HEAD to
    // branch from. Use --allow-empty because there may be no files yet.
    execSync('git commit --allow-empty -m "chore: init orchestrator workspace"', {
      cwd: projectRoot,
    });
    logger.info("git repository initialized");
    return;
  }

  // Repo exists — verify it has at least one commit (git worktree add
  // requires a reachable HEAD). An unborn HEAD happens when the user ran
  // `git init` by hand but never committed.
  let hasCommit = false;
  try {
    execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    hasCommit = true;
  } catch {
    // unborn HEAD
  }

  if (!hasCommit) {
    logger.info("creating initial commit (unborn HEAD)...");
    try {
      execSync("git add -A", { cwd: projectRoot });
    } catch {
      // ignore — may have no files
    }
    execSync('git commit --allow-empty -m "chore: init orchestrator workspace"', {
      cwd: projectRoot,
    });
    logger.info("initial commit created");
  }
}

function ensureCleanWorkspace(projectRoot: string): void {
  let status = "";
  try {
    status = execSync("git status --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return; // not a git repo — allow (shouldn't happen after ensureGitRepo)
  }
  if (status.length > 0) {
    throw new Error(
      "Workspace has uncommitted changes. Please commit or stash them before starting the orchestrator.",
    );
  }
}

function ensureGitignore(projectRoot: string, logger: ILogger): void {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const entries = [".claude-orchestrator/", ".claude/"];

  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf-8");
  }

  const lines = content.split("\n").map((l) => l.trim());
  const toAdd = entries.filter(
    (e) => !lines.some((l) => l === e || l === e.replace(/\/$/, "")),
  );

  if (toAdd.length === 0) return;

  const base = content
    ? content.endsWith("\n")
      ? content
      : `${content}\n`
    : "";

  fs.writeFileSync(gitignorePath, `${base}${toAdd.join("\n")}\n`);
  logger.info(`added ${toAdd.join(", ")} to .gitignore`);
}

interface CommitInitFilesOptions {
  enabled: boolean;
  branch: string | null;
}

// Paths that the init checker may create inside the project. We only
// stage these specific paths (not `git add -A`) so we never accidentally
// commit unrelated user changes with the init-chore message.
const INIT_PATHS = [
  "CLAUDE.md",
  ".gitignore",
];

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

  // Only add init-managed paths so we don't sweep up unrelated user
  // changes into the init commit. git add fails gracefully when the path
  // doesn't exist, so we just try each path and ignore errors.
  try {
    if (opts.branch) {
      execSync(`git checkout -B ${opts.branch}`, { cwd: projectRoot });
    }
    for (const p of INIT_PATHS) {
      try {
        execSync(`git add "${p}"`, {
          cwd: projectRoot,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // path doesn't exist or isn't tracked — skip
      }
    }
    // Only commit if there's something staged
    const diff = execSync("git diff --cached --name-only", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
    if (!diff) return;
    execSync('git commit -m "chore: init orchestrator workspace files"', {
      cwd: projectRoot,
    });
    logger.info("committed init workspace files");
  } catch (err) {
    logger.warn("init file commit skipped", { error: String(err) });
  }
}

export type { InstanceId };
