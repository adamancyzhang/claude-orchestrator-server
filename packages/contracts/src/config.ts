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

export interface ResolvedConfig {
  zk: ZkConfig;
  projects_root: string;
  commands: CommandsConfig;
  hooks: readonly HookCommand[];
  init_status: readonly InitStatusEntry[];
  instance_id: InstanceId | null;
  name: string | null;
  role: InstanceRole | null;
  debug: boolean;
}
