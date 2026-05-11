import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".claude-orchestrator");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

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

export function saveInstanceConfig(config: InstanceConfig): void {
  const existing = loadInstanceConfig();
  const merged = { ...existing, ...config };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

export function loadInstanceConfig(): InstanceConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {
    // ignore corrupt config
  }
  return {};
}

export function saveInstanceId(instanceId: string): void {
  saveInstanceConfig({ instance_id: instanceId });
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
