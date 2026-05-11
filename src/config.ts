import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".claude-orchestrator");
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");

function projectConfigDir(): string {
  return path.join(process.cwd(), ".claude-orchestrator");
}

function projectConfigFile(): string {
  return path.join(projectConfigDir(), "config.json");
}

export interface InstanceConfig {
  instance_id?: string;
  name?: string;
  role?: string;
  port?: string;
  host?: string;
}

export interface Config {
  zkHosts: string;
  port: number;
  host: string;
  instanceId?: string;
}

export function loadConfig(cliOpts: {
  zookeeper?: string;
  port?: string;
  host?: string;
  instanceId?: string;
}): Config {
  const zkHosts =
    cliOpts.zookeeper ||
    process.env.ZK_HOSTS ||
    "127.0.0.1:2181";

  const port = parseInt(
    cliOpts.port || process.env.ORCHESTRATOR_PORT || "3100",
    10
  );

  const host =
    cliOpts.host || process.env.ORCHESTRATOR_HOST || "127.0.0.1";

  const instanceId = cliOpts.instanceId || loadInstanceId() || undefined;

  return { zkHosts, port, host, instanceId };
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
  const project = readConfigFile(projectConfigFile());
  const global = readConfigFile(GLOBAL_CONFIG_FILE);
  return { ...global, ...project };
}

export function saveInstanceId(instanceId: string, global = false): void {
  saveInstanceConfig({ instance_id: instanceId }, global);
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
