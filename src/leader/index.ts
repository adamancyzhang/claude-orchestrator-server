import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { ZkClient, isNodeExists } from "../zk/client.js";
import { InstanceRegistry } from "../modules/registry.js";
import { LeaderEventBus } from "./event-bus.js";
import { LeaderState } from "./state.js";
import { WorkerMonitor } from "./monitor.js";
import { TaskOrchestrator } from "./orchestrator.js";
import { TaskRecovery } from "./recovery.js";
import { LeaderWatcher } from "./watcher.js";
import { expandHomeDir, loadGlobalConfig, loadInstanceConfig, saveInstanceId } from "../config.js";
import { LeaderTui } from "./tui.js";

export async function startLeader(config: {
  zkHosts: string;
  name?: string;
  instanceId?: string;
  command?: string;
  cacheDir?: string;
}): Promise<void> {
  const zk = new ZkClient(config.zkHosts);
  await zk.connect();

  const instanceConfig = loadInstanceConfig();
  const globalConfig = loadGlobalConfig();
  const leaderName = config.name || instanceConfig.name || "Leader";
  const command = config.command || globalConfig.command?.["claude-cli"] || "claude --dangerously-skip-permissions --permission-mode dontAsk";
  const cacheDir = config.cacheDir || globalConfig.cache_dir || "~/.claude-orchestrator/sessions";

  // Create /leader EPHEMERAL node
  const leaderId = crypto.randomUUID().replace(/-/g, "");
  try {
    await zk.createLeader({
      instance_id: leaderId,
      name: leaderName,
      role: "leader",
      started_at: new Date().toISOString(),
      host: os.hostname(),
      pid: process.pid,
      version: "0.3.0",
    });
  } catch (err) {
    if (isNodeExists(err)) {
      console.error("Another leader is already running.");
      process.exit(1);
    }
    throw err;
  }

  // Register own instance
  const registry = new InstanceRegistry(zk);
  const instance = await registry.register(leaderName, "leader", leaderId);
  saveInstanceId(instance.id);

  // Initialize CACHE_DIR
  const resolvedCache = expandHomeDir(cacheDir);
  const myCacheDir = path.join(resolvedCache, instance.id);
  await fs.promises.mkdir(myCacheDir, { recursive: true });

  // Initialize EventBus + State
  const eventBus = new LeaderEventBus();
  const state = new LeaderState();
  state.leaderName = leaderName;
  state.leaderInstanceId = instance.id;
  state.cacheDir = resolvedCache;

  eventBus.onAll((event) => state.apply(event));

  // Start subsystems
  const leaderWatcher = new LeaderWatcher(zk, eventBus, instance.id, command, resolvedCache);
  await leaderWatcher.start();

  const monitor = new WorkerMonitor(zk, eventBus);
  await monitor.start();

  const orchestrator = new TaskOrchestrator(zk, eventBus);
  await orchestrator.start();

  const recovery = new TaskRecovery(zk, eventBus);
  recovery.start();

  // Initialize TUI
  const tui = new LeaderTui();
  eventBus.onAll(() => tui.render(state));
  tui.render(state);

  // Block on SIGINT
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      tui.destroy();
      resolve();
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });

  // Shutdown: stop watchers first, then disconnect
  leaderWatcher.stop();
  monitor.stop();
  orchestrator.stop();
  await new Promise(r => setTimeout(r, 100)); // let pending callbacks drain
  await zk.disconnect();
}
