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
}

export interface OrchestratorPaths {
  template_dir: string;
  skills_dir: string;
  child_module: string;
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
  commitInitFiles(projectRoot, logger);

  // Phase 2: worktrees
  const worktreeConfigs = await initializeWorktrees({
    project_root: projectRoot,
    worker_count: input.worker_count,
    template_dir: paths.template_dir,
    skills_dir: paths.skills_dir,
    logger: logger.child("worktree"),
  });

  // Phase 3: leader
  const resolved = loadConfig({
    cli_zookeeper: input.zk_hosts,
    cli_debug: input.debug,
  });
  const leaderId = asInstanceId(randomUUID().replace(/-/g, ""));

  const zk = new ZkClient({
    hosts: resolved.zk.hosts,
    session_timeout_ms: resolved.zk.session_timeout_ms,
    ensure_paths: zkPaths.allEnsurePaths(),
  });
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
  });
  captureConsoleToFile(coRoot);

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
  tui.start();

  // Phase 4: fork workers
  const supervisor = new ChildSupervisor({
    child_module_path: paths.child_module,
    zk_hosts: resolved.zk.hosts,
    cli_command: resolved.commands.claude_cli,
    projects_root: resolved.projects_root,
    leader_instance_id: leaderInstance.id,
    debug: input.debug ?? false,
    logger: logger.child("supervisor"),
  });
  const workerConfigsForSupervisor = worktreeConfigs.map((c) => ({
    ...c,
    instance_id: c.instance_id,
  }));
  supervisor.start(workerConfigsForSupervisor);

  // Phase 5: wait for shutdown
  await new Promise<void>((resolve) => {
    const cleanup = async () => {
      await supervisor.shutdown();
      leaderWatcher.stop();
      monitor.stop();
      taskOrch.stop();
      tui.stop();
      restoreConsole();
      await registry.unregister(leaderInstance.id).catch(() => undefined);
      await zk.close();
      resolve();
    };
    process.once("SIGINT", () => void cleanup());
    process.once("SIGTERM", () => void cleanup());
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

function commitInitFiles(projectRoot: string, logger: ILogger): void {
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
