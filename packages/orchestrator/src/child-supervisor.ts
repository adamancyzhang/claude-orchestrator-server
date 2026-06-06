import { fork, type ChildProcess } from "node:child_process";
import type { HookCommand, ILogger } from "@co/contracts";
import type { WorktreeConfig } from "./worktree-initializer.js";

const MAX_RESTARTS = 3;
const PARENT_CHECK_INTERVAL_MS = 1000;

export interface ChildSupervisorOptions {
  child_module_path: string;
  zk_hosts: string;
  cli_command: string;
  projects_root: string;
  leader_instance_id: string;
  debug: boolean;
  /**
   * Pass-through of ResolvedConfig.git.remote so the Worker can run
   * an optional `git fetch` before pre-task rebase. `null` disables.
   */
  git_remote: string | null;
  /**
   * Lifecycle-hook commands forwarded to each Worker child so the
   * HookEngine inside the child can fire them. Resolved by the Leader's
   * config merge — Worker doesn't reload config independently.
   */
  hooks: readonly HookCommand[];
  /**
   * Whether the cluster was started with `--magic`. Propagated to each
   * Worker so its CHAIN_LINKS / SelfEvaluator gate the `explore` link
   * appropriately.
   */
  magic_mode: boolean;
  /**
   * The project's merge-target branch (from GitConfig). Used in the
   * worker identity card as the origin branch this worktree was forked from.
   */
  origin_branch?: string | null;
  logger: ILogger;
}

export interface IChildSupervisor {
  start(configs: readonly WorktreeConfig[]): void | Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}

export class ChildSupervisor implements IChildSupervisor {
  private children: ChildProcess[] = [];
  private restartCounts = new Map<string, number>();
  private shuttingDown = false;

  constructor(private readonly opts: ChildSupervisorOptions) {}

  start(configs: readonly WorktreeConfig[]): void {
    for (const cfg of configs) this.children.push(this.spawn(cfg));
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    this.shuttingDown = true;
    for (const child of this.children) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.children.every((c) => c.exitCode !== null)) return;
      await sleep(50);
    }
    for (const child of this.children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }

  get current(): readonly ChildProcess[] {
    return this.children;
  }

  private spawn(cfg: WorktreeConfig): ChildProcess {
    const env = {
      worktree_path: cfg.worktree_path,
      name: cfg.name,
      role: cfg.role,
      instance_id: cfg.instance_id,
      branch: cfg.branch,
      zk_hosts: this.opts.zk_hosts,
      cli_command: this.opts.cli_command,
      projects_root: this.opts.projects_root,
      leader_instance_id: this.opts.leader_instance_id,
      debug: this.opts.debug,
      git_remote: this.opts.git_remote,
      hooks: this.opts.hooks,
      magic_mode: this.opts.magic_mode,
      origin_branch: this.opts.origin_branch ?? null,
    };
    const child = fork(this.opts.child_module_path, [JSON.stringify(env)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Drain child stdout/stderr to prevent buffer deadlock.
    // Worker output flows through the message routing system to the TUI.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("exit", (code) => {
      if (this.shuttingDown) return;
      const retries = this.restartCounts.get(cfg.name) ?? 0;
      if (code !== 0 && code !== null && retries < MAX_RESTARTS) {
        this.restartCounts.set(cfg.name, retries + 1);
        this.opts.logger.warn(`worker ${cfg.name} exited (${code}); restart ${retries + 1}/${MAX_RESTARTS}`);
        const replacement = this.spawn(cfg);
        const idx = this.children.indexOf(child);
        if (idx !== -1) this.children[idx] = replacement;
      } else if (code !== 0) {
        this.opts.logger.error(`worker ${cfg.name} exited (${code}) after max restarts`);
      }
    });
    return child;
  }
}

export function startParentAliveCheck(onParentDeath: () => void): NodeJS.Timeout {
  const parentPid = process.ppid;
  return setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      onParentDeath();
    }
  }, PARENT_CHECK_INTERVAL_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
