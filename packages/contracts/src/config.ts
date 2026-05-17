import type { InstanceId, ProjectId } from "./ids.js";
import type { InstanceRole } from "./enums.js";
import type { HookEventType } from "./hooks.js";

export interface ZkConfig {
  hosts: string;
  session_timeout_ms: number;
  project_id?: ProjectId;
}

export interface CommandsConfig {
  claude_cli: string;
  git: string;
}

export interface HookCommand {
  event: HookEventType;
  command: string;
  enabled: boolean;
}

export type InitStatusLevel = "Safe" | "Caution" | "Danger";
export type InitStatusDecision = "approved" | "skipped" | "auto";

export interface InitStatusEntry {
  step_id: string;
  level: InitStatusLevel;
  decided_at: string;
  decision: InitStatusDecision;
}

export interface GitConfig {
  /**
   * Explicit branch name MergeValidator should merge into. When unset,
   * falls back to leader's HEAD at validate() time. Useful when the
   * orchestrator boots on a feature branch but should still merge
   * back into `main` / `master`.
   */
  merge_target_branch: string | null;
  /**
   * Remote name to fetch from before merges and from worker pre-task
   * rebases. `null` disables all fetch/rebase-from-remote behavior
   * (purely local flow). Defaults to "origin".
   */
  remote: string | null;
  /**
   * When false, orchestrator does not auto-commit init files in the
   * project root or CO root at startup. Defaults to true for backward
   * compatibility.
   */
  auto_commit_init_files: boolean;
  /**
   * Optional separate branch to redirect init-file commits to. When
   * non-null, the orchestrator runs `git checkout -B <branch>` before
   * the init commit so the user's working branch is not polluted.
   */
  auto_commit_init_files_branch: string | null;
}

export interface ResolvedConfig {
  zk: ZkConfig;
  projects_root: string;
  commands: CommandsConfig;
  git: GitConfig;
  hooks: readonly HookCommand[];
  init_status: readonly InitStatusEntry[];
  instance_id: InstanceId | null;
  name: string | null;
  role: InstanceRole | null;
  debug: boolean;
}
