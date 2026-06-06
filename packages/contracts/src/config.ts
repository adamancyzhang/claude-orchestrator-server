import { z } from "zod";
import type { InstanceId, ProjectId } from "./ids.js";
import { InstanceRoleSchema, type InstanceRole } from "./enums.js";
import { HOOK_EVENT_TYPES, type HookEventType } from "./hooks.js";

// --- Zod Schemas for config validation ---

export const ZkConfigSchema = z.object({
  hosts: z.string().min(1, "zk.hosts must not be empty"),
  session_timeout_ms: z.number().int().positive("zk.session_timeout_ms must be a positive integer"),
});

export const CommandsConfigSchema = z.object({
  claude_cli: z.string().min(1, "commands.claude_cli must not be empty"),
  git: z.string().min(1, "commands.git must not be empty"),
});

export const HookCommandSchema = z.object({
  event: z.enum(HOOK_EVENT_TYPES as [string, ...string[]]),
  command: z.string().min(1, "hook command must not be empty"),
  enabled: z.boolean(),
});

export const GitConfigSchema = z.object({
  merge_target_branch: z.string().nullable(),
  remote: z.string().nullable(),
  auto_commit_init_files: z.boolean(),
  auto_commit_init_files_branch: z.string().nullable(),
});

export const InitStatusLevelSchema = z.enum(["Safe", "Caution", "Danger"]);
export const InitStatusDecisionSchema = z.enum(["approved", "skipped", "auto"]);

export const InitStatusEntrySchema = z.object({
  step_id: z.string(),
  level: InitStatusLevelSchema,
  decided_at: z.string(),
  decision: InitStatusDecisionSchema,
});

/**
 * Schema for validating a single config file (global or project).
 * All fields are optional because each file only needs to set the
 * values it overrides.
 */
export const RawConfigSchema = z.object({
  instance_id: z.string().optional(),
  name: z.string().optional(),
  role: InstanceRoleSchema.optional(),
  projects_root: z.string().optional(),
  /** @deprecated use projects_root */
  cache_dir: z.string().optional(),
  zookeeper: ZkConfigSchema.partial().optional(),
  commands: CommandsConfigSchema.partial().optional(),
  git: GitConfigSchema.partial().optional(),
  hooks: z.array(HookCommandSchema).optional(),
  init_status: z.array(InitStatusEntrySchema).optional(),
  debug: z.boolean().optional(),
});

export type RawConfig = z.infer<typeof RawConfigSchema>;

// --- Interfaces (unchanged) ---

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

// --- Validation ---

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly source: "global" | "project",
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }

  /**
   * Human-readable summary of all validation issues, suitable for
   * displaying to the user at startup.
   */
  formatIssues(): string {
    const lines = this.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
    );
    return `${this.source} config validation failed:\n${lines.join("\n")}`;
  }
}

/**
 * Validate a raw config object (from global or project config file)
 * against the Zod schema. Returns the parsed result on success, or
 * throws ConfigValidationError with detailed per-field errors.
 */
export function validateRawConfig(
  data: unknown,
  source: "global" | "project",
): RawConfig {
  const result = RawConfigSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigValidationError(
      `${source} config file has invalid entries`,
      source,
      result.error.issues,
    );
  }
  return result.data;
}
