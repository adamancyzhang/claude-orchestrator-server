import * as os from "node:os";
import * as path from "node:path";
import {
  asInstanceId,
  type CommandsConfig,
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
  cache_dir?: string;
  zookeeper?: Partial<ZkConfig>;
  commands?: Partial<CommandsConfig>;
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

function defaultCacheDir(): string {
  return path.join(process.cwd(), ".claude-orchestrator", "sessions");
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

  const cacheDir = path.resolve(
    process.cwd(),
    expandHomeDir(project.cache_dir ?? global.cache_dir ?? defaultCacheDir()),
  );

  const commands: CommandsConfig = {
    ...defaultCommands(),
    ...(global.commands ?? {}),
    ...(project.commands ?? {}),
  };

  const hooks = (project.hooks ?? global.hooks ?? []) as readonly HookCommand[];
  const initStatus = (global.init_status ?? []) as readonly InitStatusEntry[];

  return {
    zk,
    cache_dir: cacheDir,
    commands,
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
