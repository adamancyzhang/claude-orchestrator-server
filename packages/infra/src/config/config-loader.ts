import * as os from "node:os";
import * as path from "node:path";
import {
  asInstanceId,
  type CommandsConfig,
  type GitConfig,
  type HookCommand,
  type InitStatusEntry,
  type InstanceRole,
  type ResolvedConfig,
  type ZkConfig,
} from "@co/contracts";
import { readJson, writeJsonAtomic } from "../utils/fs-json.js";

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".claude-orchestrator");
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");

interface RawConfig {
  instance_id?: string;
  name?: string;
  role?: InstanceRole;
  projects_root?: string;
  /** @deprecated use projects_root; retained for legacy override */
  cache_dir?: string;
  zookeeper?: Partial<ZkConfig>;
  commands?: Partial<CommandsConfig>;
  git?: Partial<GitConfig>;
  hooks?: readonly HookCommand[];
  init_status?: readonly InitStatusEntry[];
  debug?: boolean;
}

export interface LoadConfigInput {
  cli_zookeeper?: string;
  cli_debug?: boolean;
}

function defaultZk(): ZkConfig {
  return { hosts: "127.0.0.1:2181", session_timeout_ms: 30000 };
}

function defaultCommands(): CommandsConfig {
  return {
    claude_cli: "claude --dangerously-skip-permissions --permission-mode dontAsk",
    git: "git",
  };
}

function defaultGit(): GitConfig {
  return {
    merge_target_branch: null,
    remote: "origin",
    auto_commit_init_files: true,
    auto_commit_init_files_branch: null,
  };
}

function defaultProjectsRoot(): string {
  return path.join(os.homedir(), ".claude-orchestrator", "projects");
}

function projectConfigFile(): string {
  return path.join(process.cwd(), ".claude-orchestrator", "config.json");
}

function expandHomeDir(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(input: LoadConfigInput = {}): ResolvedConfig {
  const global = readJson<RawConfig>(GLOBAL_CONFIG_FILE) ?? {};
  const project = readJson<RawConfig>(projectConfigFile()) ?? {};

  const zk: ZkConfig = {
    ...defaultZk(),
    ...(global.zookeeper ?? {}),
    ...(project.zookeeper ?? {}),
  };
  if (input.cli_zookeeper) zk.hosts = input.cli_zookeeper;
  else if (process.env.ZK_HOSTS) zk.hosts = process.env.ZK_HOSTS;

  const projectsRoot = path.resolve(
    process.cwd(),
    expandHomeDir(
      project.projects_root ??
        global.projects_root ??
        project.cache_dir ??
        global.cache_dir ??
        defaultProjectsRoot(),
    ),
  );
  if (
    (project.cache_dir || global.cache_dir) &&
    !(project.projects_root || global.projects_root)
  ) {
    console.warn(
      "[config] `cache_dir` is deprecated; please rename to `projects_root` (default ~/.claude-orchestrator/projects).",
    );
  }

  const commands: CommandsConfig = {
    ...defaultCommands(),
    ...(global.commands ?? {}),
    ...(project.commands ?? {}),
  };

  const git: GitConfig = {
    ...defaultGit(),
    ...(global.git ?? {}),
    ...(project.git ?? {}),
  };

  const hooks = (project.hooks ?? global.hooks ?? []) as readonly HookCommand[];
  const initStatus = (global.init_status ?? []) as readonly InitStatusEntry[];

  return {
    zk,
    projects_root: projectsRoot,
    commands,
    git,
    hooks,
    init_status: initStatus,
    instance_id: project.instance_id ? asInstanceId(project.instance_id) : null,
    name: project.name ?? null,
    role: project.role ?? null,
    debug: Boolean(input.cli_debug ?? project.debug ?? global.debug ?? false),
  };
}

export function saveInstanceId(instanceId: string): void {
  const filePath = projectConfigFile();
  const existing = readJson<RawConfig>(filePath) ?? {};
  writeJsonAtomic(filePath, { ...existing, instance_id: instanceId });
}

export function saveInitStatus(entries: readonly InitStatusEntry[]): void {
  const existing = readJson<RawConfig>(GLOBAL_CONFIG_FILE) ?? {};
  writeJsonAtomic(GLOBAL_CONFIG_FILE, { ...existing, init_status: entries });
}

export function loadInitStatus(): readonly InitStatusEntry[] {
  const global = readJson<RawConfig>(GLOBAL_CONFIG_FILE) ?? {};
  return global.init_status ?? [];
}

export function saveProjectInitStatus(entries: readonly InitStatusEntry[]): void {
  const filePath = projectConfigFile();
  const existing = readJson<RawConfig>(filePath) ?? {};
  writeJsonAtomic(filePath, { ...existing, init_status: entries });
}

export function loadProjectInitStatus(): readonly InitStatusEntry[] {
  const project = readJson<RawConfig>(projectConfigFile()) ?? {};
  return project.init_status ?? [];
}

export interface WorktreeEntry {
  name: string;
  role: InstanceRole;
  path: string;
  branch: string;
  instance_id: string;
}

export function loadProjectWorktreeConfig(): Record<string, WorktreeEntry> {
  const project =
    readJson<RawConfig & { worktree?: Record<string, WorktreeEntry> }>(
      projectConfigFile(),
    ) ?? {};
  return project.worktree ?? {};
}

export function saveProjectWorktreeConfig(
  entries: Record<string, WorktreeEntry>,
): void {
  const filePath = projectConfigFile();
  const existing =
    readJson<RawConfig & { worktree?: Record<string, WorktreeEntry> }>(filePath) ??
    {};
  writeJsonAtomic(filePath, { ...existing, worktree: entries });
}
