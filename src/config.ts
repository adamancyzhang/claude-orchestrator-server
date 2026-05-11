import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".claude-orchestrator");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

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

export function saveInstanceId(instanceId: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ instance_id: instanceId }, null, 2)
  );
}

export function loadInstanceId(): string | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return data.instance_id || null;
    }
  } catch {
    // ignore corrupt config
  }
  return null;
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
