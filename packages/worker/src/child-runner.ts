import type { InstanceId } from "@co/contracts";

export interface ChildConfig {
  worktree_path: string;
  name: string;
  role: string;
  instance_id: InstanceId;
  branch: string;
  zk_hosts: string;
  cli_command: string;
  projects_root: string;
  leader_instance_id: InstanceId;
  debug: boolean;
  /**
   * Optional git remote name for pre-task rebase fetches. `null` means
   * the Worker performs rebases purely against local refs (shared
   * `.git` with the project repo already provides the upstream sha).
   */
  git_remote: string | null;
}

/**
 * Worker child process entry point.
 *
 * Concrete startup wiring (registering the instance, connecting ZK, spinning
 * up WorkerWatcher / SelfEvaluator / CommitChecker / HookEngine) lives in
 * `@co/orchestrator` to keep this package free of infrastructure imports.
 * The orchestrator forks `dist/child.js` (which calls back into this module's
 * boot helper via a registered factory).
 */
export type ChildBoot = (config: ChildConfig) => Promise<void>;

let boot: ChildBoot | null = null;

export function registerChildBoot(impl: ChildBoot): void {
  boot = impl;
}

export async function startWorkerChild(config: ChildConfig): Promise<void> {
  if (!boot) {
    throw new Error(
      "Worker child boot not registered — orchestrator must register a ChildBoot before forking",
    );
  }
  await boot(config);
}
