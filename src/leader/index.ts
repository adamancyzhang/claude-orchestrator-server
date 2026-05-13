import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { TemplateEngine } from "../executor/template.js";
import { loadInstanceConfig, saveInstanceId, loadConfig } from "../config.js";
import { Logger } from "../utils/logger.js";
import { captureConsoleToFile, restoreConsole } from "../utils/console-capture.js";
import { LeaderTui } from "./tui.js";
import { StreamTailer } from "./stream-tailer.js";

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
      version: "0.4.1",
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

  // Resolve cache dir from config (defaults to project-local .claude-orchestrator/sessions)
  const resolvedConfig = loadConfig({ zookeeper: config.zkHosts });

  // Redirect all console output to file so TUI controls the screen
  captureConsoleToFile(resolvedConfig.cacheDir);

  // Initialize EventBus + State
  const eventBus = new LeaderEventBus();
  const state = new LeaderState();
  state.leaderName = leaderName;
  state.leaderInstanceId = instance.id;
  state.cacheDir = resolvedConfig.cacheDir;
  eventBus.onAll((event) => state.apply(event));

  // Initialize TemplateEngine first — needed for identity and merge templates
  const projectRoot = process.cwd();
  const distTemplateDir = path.join(projectRoot, "dist", "templates");
  const srcTemplateDir = path.join(projectRoot, "templates");
  const templateDir = fs.existsSync(distTemplateDir) ? distTemplateDir : srcTemplateDir;
  const agentsDir = path.join(templateDir, "agents");
  const templateEngine = new TemplateEngine(agentsDir);
  await templateEngine.loadAll();
  const identityTemplate = await templateEngine.loadFile("worker-identity.md");
  const mergeDecisionTemplate = await templateEngine.loadFile("worker-merge-decision.md");

  // Initialize ClaudeRunner with streaming callback for TUI
  const leaderIdentity = {
    name: leaderName,
    role: "leader",
    worktreePath: process.cwd(),
    worktreeBranch: "",
    instanceId: instance.id,
  };
  const cacheRunner = new ClaudeRunner(
    resolvedConfig.cliCommand,
    resolvedConfig.cacheDir,
    instance.id,
    process.cwd(),
    leaderIdentity,
    identityTemplate,
    (line: string) => {
      eventBus.emit({
        type: "stream_chunk",
        instanceId: instance.id,
        line,
      });
    },
  );

  // StreamTailer for cross-process file-based streaming
  const streamTailer = new StreamTailer();

  // When a worker claims a task, start tailing its log file
  eventBus.on("task_claimed", (event) => {
    if (event.type !== "task_claimed") return;
    const workerId = event.instanceId;
    const taskId = event.taskId;
    if (!workerId || !taskId) return;

    const logPath = cacheRunner.logPath(taskId);
    eventBus.emit({
      type: "stream_start",
      instanceId: workerId,
      logPath,
      taskId,
    });
    streamTailer.start(logPath, (line) => {
      eventBus.emit({
        type: "stream_chunk",
        instanceId: workerId,
        line,
      });
    });
  });

  // When a task completes, stop tailing
  eventBus.on("task_completed", (event) => {
    if (event.type !== "task_completed") return;
    const workerId = event.instanceId;
    if (workerId && streamTailer.isActive) {
      streamTailer.stop();
      eventBus.emit({
        type: "stream_end",
        instanceId: workerId,
        logPath: "",
      });
    }
  });

  // Initialize TaskQueue, MessageRouter, and ChainRouter
  const taskQueue = new TaskQueue(zk);
  const messageRouter = new MessageRouter(zk);

  // Initialize MergeValidator
  const mergeValidator = new MergeValidator(process.cwd(), cacheRunner, eventBus, mergeDecisionTemplate);

  const chainRouter = new ChainRouter(zk, taskQueue, messageRouter, eventBus, instance.id, leaderName, cacheRunner, templateEngine, mergeValidator);

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

  // Add leader as visible worker for in-process streaming display
  eventBus.emit({
    type: "worker_joined",
    instance: {
      id: instance.id,
      name: leaderName,
      role: "leader",
      status: "idle",
    },
    instanceId: instance.id,
    name: leaderName,
  });

  // Initialize TUI
  const tui = new LeaderTui();
  eventBus.onAll((event) => {
    if (event.type === "stream_chunk") {
      tui.requestRender();
    } else {
      tui.render(state);
    }
  });
  tui.render(state);

  // Wire TUI input to send messages to leader's own queue for processing
  tui.onInput(async (text) => {
    await zk.createMessage(instance.id, {
      type: "direct",
      from_instance: instance.id,
      from_name: leaderName,
      to_instance: instance.id,
      content: text,
      created_at: new Date().toISOString(),
      read: false,
    });
  });

  // Block on SIGINT
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      tui.destroy();
      restoreConsole();
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
