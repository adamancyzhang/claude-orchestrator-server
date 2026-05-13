import * as os from "node:os";
import { ZkClient, isNodeExists } from "../zk/client.js";
import { InstanceRegistry } from "../modules/registry.js";
import { LeaderEventBus } from "./event-bus.js";
import { LeaderState } from "./state.js";
import { WorkerMonitor } from "./monitor.js";
import { TaskOrchestrator } from "./orchestrator.js";
import { TaskRecovery } from "./recovery.js";
import { LeaderWatcher } from "./watcher.js";
import { ChainRouter } from "./chain-router.js";
import { MergeValidator } from "./merge-validator.js";
import { TaskQueue } from "../modules/task-queue.js";
import { MessageRouter } from "../modules/message-router.js";
import { ClaudeRunner } from "../executor/runner.js";
import { loadInstanceConfig, saveInstanceId } from "../config.js";
import { Logger } from "../utils/logger.js";
import { LeaderTui } from "./tui.js";

export async function startLeader(config: {
  zkHosts: string;
  name?: string;
  instanceId?: string;
  debug?: boolean;
  worktreeConfigs?: Array<{ name: string; role: string; worktreePath: string; branch: string; instanceId: string }>;
}): Promise<void> {
  const logger = new Logger("Leader");

  const zk = new ZkClient(config.zkHosts);
  await zk.connect();

  const instanceConfig = loadInstanceConfig();
  const leaderName = config.name || instanceConfig.name || "Leader";

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
      version: "0.4.0",
    });
  } catch (err) {
    if (isNodeExists(err)) {
      logger.error("Another leader is already running.");
      process.exit(1);
    }
    throw err;
  }

  // Register own instance
  const registry = new InstanceRegistry(zk);
  const instance = await registry.register(leaderName, "leader", leaderId);
  saveInstanceId(instance.id);

  // Initialize cache runner for path management (leader doesn't call claude-cli)
  const cacheRunner = new ClaudeRunner(
    "", // command unused by leader
    "~/.claude-orchestrator/sessions",
    instance.id,
    process.cwd(),
  );

  // Initialize EventBus + State
  const eventBus = new LeaderEventBus();
  const state = new LeaderState();
  state.leaderName = leaderName;
  state.leaderInstanceId = instance.id;
  state.cacheDir = "~/.claude-orchestrator/sessions";

  eventBus.onAll((event) => state.apply(event));

  // Initialize TaskQueue, MessageRouter, and ChainRouter
  const taskQueue = new TaskQueue(zk);
  const messageRouter = new MessageRouter(zk);

  // Initialize MergeValidator
  const mergeValidator = new MergeValidator(process.cwd(), cacheRunner, eventBus);

  const chainRouter = new ChainRouter(zk, taskQueue, messageRouter, eventBus, instance.id, leaderName, cacheRunner, mergeValidator);

  // Start subsystems
  const leaderWatcher = new LeaderWatcher(zk, eventBus, instance.id, chainRouter);
  await leaderWatcher.start();

  const monitor = new WorkerMonitor(zk, eventBus);
  await monitor.start();

  const orchestrator = new TaskOrchestrator(zk, eventBus);
  await orchestrator.start();

  const recovery = new TaskRecovery(zk, eventBus);
  recovery.start();
  await recovery.scanOrphans();

  // Initialize TUI
  const tui = new LeaderTui();
  eventBus.onAll(() => tui.render(state));
  tui.render(state);

  // Wire TUI input to send messages to leader's own queue for processing
  tui.onInput(async (text) => {
    try {
      await zk.createMessage(instance.id, {
        type: "direct",
        from_instance: instance.id,
        from_name: leaderName,
        to_instance: instance.id,
        content: text,
        created_at: new Date().toISOString(),
        read: false,
      });
    } catch (err) {
      // Best effort — message will be lost if ZK is down
    }
  });

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
