import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".claude-orchestrator");
export const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");

export interface ZkConfig {
  url: string;
  root_path: string;
  auth: string | null;
}

export interface CommandConfig {
  "claude-cli"?: string;
  "leader-sync"?: string | null;
}

export interface InstanceConfig {
  instance_id?: string;
  name?: string;
  role?: string;
  command?: CommandConfig | string;
  cache_dir?: string;
  zookeeper?: ZkConfig;
}

export interface ResolvedConfig {
  zk: ZkConfig;
  cacheDir: string;
  cliCommand: string;
  leaderSync: string | null;
  instanceId?: string;
  name?: string;
  role?: string;
}

function projectConfigDir(): string {
  return path.join(process.cwd(), ".claude-orchestrator");
}

function projectConfigFile(): string {
  return path.join(projectConfigDir(), "config.json");
}

function defaultZkConfig(): ZkConfig {
  return { url: "127.0.0.1:2181", root_path: "/claude-orchestrator", auth: null };
}

function defaultCacheDir(): string {
  return "~/.claude-orchestrator/sessions";
}

function defaultCliCommand(): string {
  return "claude --dangerously-skip-permissions --permission-mode dontAsk";
}

function resolveCommandConfig(raw: InstanceConfig["command"]): { cliCommand: string; leaderSync: string | null } {
  if (typeof raw === "string") {
    return { cliCommand: raw, leaderSync: null };
  }
  return {
    cliCommand: raw?.["claude-cli"] || defaultCliCommand(),
    leaderSync: raw?.["leader-sync"] ?? null,
  };
}

export function loadConfig(cliOpts: {
  zookeeper?: string;
}): ResolvedConfig {
  const global = loadGlobalConfig();
  const project = loadProjectConfig();

  // ZK config from global, with CLI/env override for url
  const zk: ZkConfig = {
    ...defaultZkConfig(),
    ...global.zookeeper,
  };
  if (cliOpts.zookeeper) {
    zk.url = cliOpts.zookeeper;
  } else if (process.env.ZK_HOSTS) {
    zk.url = process.env.ZK_HOSTS;
  }

  const cacheDir = global.cache_dir || defaultCacheDir();

  // Command: project overrides global; supports both old flat string and new nested object
  const mergedCommand = project.command || global.command;
  const { cliCommand, leaderSync } = resolveCommandConfig(mergedCommand);

  const instanceId = project.instance_id;
  const name = project.name;
  const role = project.role;

  return { zk, cacheDir, cliCommand, leaderSync, instanceId, name, role };
}

function readConfigFile(filePath: string): InstanceConfig {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // ignore corrupt config
  }
  return {};
}

function writeConfigFile(filePath: string, config: InstanceConfig): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
}

export function saveInstanceConfig(config: InstanceConfig, global = false): void {
  const filePath = global ? GLOBAL_CONFIG_FILE : projectConfigFile();
  const existing = readConfigFile(filePath);
  writeConfigFile(filePath, { ...existing, ...config });
}

export function loadInstanceConfig(): InstanceConfig {
  const project = loadProjectConfig();
  const global = loadGlobalConfig();
  return { ...global, ...project };
}

export function loadGlobalConfig(): InstanceConfig {
  return readConfigFile(GLOBAL_CONFIG_FILE);
}

function loadProjectConfig(): InstanceConfig {
  return readConfigFile(projectConfigFile());
}

export function saveInstanceId(instanceId: string): void {
  saveInstanceConfig({ instance_id: instanceId }, false);
}

export function loadInstanceId(): string | null {
  const config = loadInstanceConfig();
  return config.instance_id || null;
}

export function resolveInstanceId(cliInstanceId?: string): string {
  const resolved = cliInstanceId || loadInstanceId();
  if (!resolved) {
    throw new Error(
      "No instance_id found. Run 'claude-orchestrator register' first, " +
        "or pass --instance-id."
    );
  }
  return resolved;
}

export function expandHomeDir(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}
