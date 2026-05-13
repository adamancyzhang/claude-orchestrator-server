import type { ChildProcess } from "node:child_process";
import type { WorktreeConfig } from "../worker/worktree-initializer.js";

/**
 * Phase-level operations factored out of `runOrchestrator` so they can be
 * mocked end-to-end in tests without spinning up ZK, git, or child processes.
 */
export interface OrchDeps {
  ensureCleanWorkspace: (projectRoot: string) => { clean: boolean; status?: string };
  runInitCheck: (opts: { templateDir: string; skillsDir: string; projectRoot: string; yFlag: boolean }) => Promise<void>;
  commitInitFiles: (projectRoot: string) => void;
  initializeWorktrees: (projectRoot: string, count: number) => Promise<WorktreeConfig[]>;
  startLeader: (config: {
    zkHosts: string;
    name?: string;
    debug: boolean;
    worktreeConfigs: WorktreeConfig[];
  }) => Promise<void>;
  forkWorker: (cfg: WorktreeConfig, opts: { zkHosts: string; debug: boolean; cliCommand: string; cacheDir: string }) => ChildProcess;
  waitForSignal: () => Promise<void>;
}

export interface PhaseLog {
  phase: number;
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RunConfig {
  zkHosts: string;
  workerCount: number;
  name?: string;
  debug?: boolean;
  yFlag?: boolean;
  templateDir: string;
  skillsDir: string;
  projectRoot: string;
  cliCommand: string;
  cacheDir: string;
}

const MAX_WORKER_RESTARTS = 3;

/**
 * Execute the 5-phase startup. Side effects come exclusively from the injected
 * `deps`. This makes it possible to assert ordering and failure recovery in
 * a unit test.
 */
export async function runPhases(
  config: RunConfig,
  deps: OrchDeps,
): Promise<{ children: ChildProcess[]; log: PhaseLog[] }> {
  const log: PhaseLog[] = [];

  // Phase 1: environment / init check
  const status = deps.ensureCleanWorkspace(config.projectRoot);
  if (!status.clean) {
    log.push({ phase: 1, name: "ensureCleanWorkspace", ok: false, detail: status.status });
    throw new Error("Workspace has uncommitted changes");
  }
  log.push({ phase: 1, name: "ensureCleanWorkspace", ok: true });

  await deps.runInitCheck({
    templateDir: config.templateDir,
    skillsDir: config.skillsDir,
    projectRoot: config.projectRoot,
    yFlag: config.yFlag ?? false,
  });
  log.push({ phase: 1, name: "runInitCheck", ok: true });

  deps.commitInitFiles(config.projectRoot);
  log.push({ phase: 1, name: "commitInitFiles", ok: true });

  // Phase 2: worktree initialization
  const worktreeConfigs = await deps.initializeWorktrees(config.projectRoot, config.workerCount);
  log.push({ phase: 2, name: "initializeWorktrees", ok: true, detail: `${worktreeConfigs.length} worktrees` });

  // Phase 3: leader (fire-and-forget; the leader itself owns its TUI lifecycle)
  await deps.startLeader({
    zkHosts: config.zkHosts,
    name: config.name,
    debug: config.debug ?? false,
    worktreeConfigs,
  });
  log.push({ phase: 3, name: "startLeader", ok: true });

  // Phase 4: fork workers with restart-up-to-3 supervision
  const children: ChildProcess[] = [];
  const restartCount = new Map<string, number>();
  let shuttingDown = false;

  const spawn = (cfg: WorktreeConfig): ChildProcess => {
    const child = deps.forkWorker(cfg, {
      zkHosts: config.zkHosts,
      debug: config.debug ?? false,
      cliCommand: config.cliCommand,
      cacheDir: config.cacheDir,
    });
    child.on("exit", (code: number | null) => {
      if (shuttingDown) return;
      const retries = restartCount.get(cfg.name) ?? 0;
      if (code !== 0 && code !== null && retries < MAX_WORKER_RESTARTS) {
        restartCount.set(cfg.name, retries + 1);
        const replacement = spawn(cfg);
        const idx = children.indexOf(child);
        if (idx !== -1) children[idx] = replacement;
      }
    });
    return child;
  };

  for (const cfg of worktreeConfigs) {
    children.push(spawn(cfg));
  }
  log.push({ phase: 4, name: "forkWorkers", ok: true, detail: `${children.length} children` });

  // Phase 5: wait for shutdown
  const shutdown = (async () => {
    await deps.waitForSignal();
    shuttingDown = true;
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    }
  })();
  log.push({ phase: 5, name: "waitForShutdown", ok: true });

  await shutdown;
  return { children, log };
}
