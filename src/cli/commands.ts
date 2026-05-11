import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { ZkClient } from "../zk/client.js";
import * as paths from "../zk/paths.js";
import { InstanceRegistry } from "../modules/registry.js";
import { TaskQueue } from "../modules/task-queue.js";
import { MessageRouter } from "../modules/message-router.js";
import { ContextStore } from "../modules/context-store.js";
import { resolveInstanceId, saveInstanceId, saveInstanceConfig, loadInstanceConfig, loadInstanceId, loadGlobalConfig, expandHomeDir, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE } from "../config.js";
import { output } from "../utils/output.js";
import { TaskPriorityName } from "../models/schemas.js";
import { WorkerWatcher } from "../worker/watcher.js";

async function withZk<T>(
  hosts: string,
  fn: (clients: {
    zk: ZkClient;
    registry: InstanceRegistry;
    taskQueue: TaskQueue;
    messageRouter: MessageRouter;
    contextStore: ContextStore;
  }) => Promise<T>
): Promise<T> {
  const zk = new ZkClient(hosts);
  await zk.connect();
  const registry = new InstanceRegistry(zk);
  const taskQueue = new TaskQueue(zk);
  const messageRouter = new MessageRouter(zk);
  const contextStore = new ContextStore(zk);
  try {
    return await fn({ zk, registry, taskQueue, messageRouter, contextStore });
  } finally {
    await zk.disconnect();
  }
}

export async function cmdStatus(zkHosts: string): Promise<void> {
  await withZk(zkHosts, async ({ zk, registry }) => {
    const connected = zk.connected;
    const instances = await registry.listAll();
    output({
      status: connected ? "healthy" : "degraded",
      zookeeper: connected ? "connected" : "disconnected",
      instances_online: instances.length,
    });
  });
}

export async function cmdRegister(
  zkHosts: string,
  instanceId: string | undefined,
  name?: string,
  role?: string,
  workDir?: string
): Promise<void> {
  const config = loadInstanceConfig();
  const resolvedName = name || config.name;
  if (!resolvedName) {
    output({ error: "No instance name provided. Use --name or run 'claude-orchestrator setup --name <name>' first." }, true);
    return;
  }
  const resolvedRole = role || config.role || "general";
  const resolvedId = instanceId || loadInstanceId() || undefined;

  // ── Mode 1: with work_dir → persistent local watcher ──
  if (workDir) {
    const zk = new ZkClient(zkHosts);
    await zk.connect();
    const registry = new InstanceRegistry(zk);

    const instance = await registry.register(resolvedName, resolvedRole, resolvedId);
    saveInstanceId(instance.id);
    saveInstanceConfig({ name: resolvedName, role: resolvedRole });
    output(instance);

    // Resolve leader instance ID for CACHE_DIR path
    const leaderData = await zk.getLeader();
    const leaderInstanceId = (leaderData?.instance_id as string) ?? instance.id;

    // Get config defaults
    const globalConfig = loadGlobalConfig();
    const command = globalConfig.command || "claude --dangerously-skip-permissions -v";
    const cacheDir = globalConfig.cache_dir || "~/.claude-orchestrator/sessions";

    const watcher = new WorkerWatcher(zk, instance.id, workDir, command, cacheDir, leaderInstanceId);

    const onSigint = () => {
      watcher.stop();
    };
    process.on("SIGINT", onSigint);

    await watcher.start();

    // Block until stopped
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (watcher.stopped) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });

    await registry.unregister(instance.id);
    await zk.disconnect();
    process.removeListener("SIGINT", onSigint);
    console.log("Unregistered. Goodbye.");
    return;
  }

  // ── Mode 2: no work_dir → one-shot register ──

  await withZk(zkHosts, async ({ registry }) => {
    const instance = await registry.register(resolvedName, resolvedRole, resolvedId);
    saveInstanceId(instance.id);
    saveInstanceConfig({ name: resolvedName, role: resolvedRole });
    output(instance);
  });
}

export async function cmdHeartbeat(
  zkHosts: string,
  cliInstanceId: string | undefined,
  currentTask?: string
): Promise<void> {
  await withZk(zkHosts, async ({ registry }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    await registry.heartbeat(instanceId, currentTask);
    output({ status: "ok", instance_id: instanceId });
  });
}

export async function cmdListInstances(zkHosts: string): Promise<void> {
  await withZk(zkHosts, async ({ registry }) => {
    const instances = await registry.listAll();
    output(instances);
  });
}

export async function cmdPushTask(
  zkHosts: string,
  cliInstanceId: string | undefined,
  title: string,
  description: string,
  priority: number,
  assignee?: string
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = cliInstanceId ?? "";
    const task = await taskQueue.push(title, description, priority, instanceId, assignee);
    output(task);
  });
}

export async function cmdClaimTask(
  zkHosts: string,
  cliInstanceId: string | undefined
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const task = await taskQueue.claim(instanceId);
    if (!task) {
      output({ status: "no_tasks", message: "No pending tasks available." });
    } else {
      output(task);
    }
  });
}

export async function cmdCompleteTask(
  zkHosts: string,
  cliInstanceId: string | undefined,
  taskId: string,
  result: string
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const task = await taskQueue.complete(instanceId, taskId, result);
    output(task);
  });
}

export async function cmdListTasks(
  zkHosts: string,
  statusFilter?: string
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const tasks = await taskQueue.listTasks(statusFilter);
    output(tasks);
  });
}

export async function cmdSendMessage(
  zkHosts: string,
  cliInstanceId: string | undefined,
  content: string,
  toInstance?: string,
  broadcast: boolean = false,
  toName?: string
): Promise<void> {
  await withZk(zkHosts, async ({ registry, messageRouter }) => {
    const instanceId = cliInstanceId || loadInstanceId() || "";
    let fromName: string;
    if (instanceId) {
      const inst = await registry.get(instanceId);
      fromName = inst?.name ?? instanceId.slice(0, 8);
    } else {
      fromName = "CLI";
    }
    const messages = await messageRouter.send(
      instanceId,
      fromName,
      content,
      toInstance,
      broadcast,
      toName
    );
    const targets = messages.map((m) => m.to_instance);
    output({ sent_to: targets, message_count: targets.length });
  });
}

export async function cmdPollMessages(
  zkHosts: string,
  cliInstanceId: string | undefined
): Promise<void> {
  await withZk(zkHosts, async ({ messageRouter }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const messages = await messageRouter.poll(instanceId);
    output(messages);
  });
}

export async function cmdWaitForMessage(
  zkHosts: string,
  cliInstanceId: string | undefined,
  timeout: number
): Promise<void> {
  await withZk(zkHosts, async ({ messageRouter }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const messages = await messageRouter.waitForMessage(instanceId, timeout);
    output(messages.length > 0 ? messages : { status: "timeout", message: "No messages received." });
  });
}

export async function cmdDismissMessage(
  zkHosts: string,
  cliInstanceId: string | undefined,
  messageId: string
): Promise<void> {
  await withZk(zkHosts, async ({ messageRouter }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    await messageRouter.dismissMessage(instanceId, messageId);
    output({ status: "dismissed", message_id: messageId });
  });
}

export async function cmdRequestHelp(
  zkHosts: string,
  cliInstanceId: string | undefined,
  question: string,
  ctx?: string
): Promise<void> {
  await withZk(zkHosts, async ({ registry, messageRouter }) => {
    const instanceId = cliInstanceId || loadInstanceId() || "";
    let fromName: string;
    if (instanceId) {
      const inst = await registry.get(instanceId);
      fromName = inst?.name ?? instanceId.slice(0, 8);
    } else {
      fromName = "CLI";
    }
    const messages = await messageRouter.requestHelp(instanceId, fromName, question, ctx);
    const targets = messages.map((m) => m.to_instance);
    output({ sent_to: targets, message_count: targets.length });
  });
}

export async function cmdSetContext(
  zkHosts: string,
  cliInstanceId: string | undefined,
  key: string,
  value: string
): Promise<void> {
  await withZk(zkHosts, async ({ contextStore }) => {
    const instanceId = cliInstanceId ?? "";
    const entry = await contextStore.set(key, value, instanceId);
    output(entry);
  });
}

export async function cmdGetContext(
  zkHosts: string,
  key: string
): Promise<void> {
  await withZk(zkHosts, async ({ contextStore }) => {
    const value = await contextStore.get(key);
    if (value === null) {
      output({ key, value: null, status: "not_found" });
    } else {
      output({ key, value });
    }
  });
}

export async function cmdDeleteContext(
  zkHosts: string,
  key: string
): Promise<void> {
  await withZk(zkHosts, async ({ contextStore }) => {
    await contextStore.delete(key);
    output({ key, status: "deleted" });
  });
}

export async function cmdListContextKeys(zkHosts: string): Promise<void> {
  await withZk(zkHosts, async ({ contextStore }) => {
    const keys = await contextStore.listKeys();
    output({ keys, count: keys.length });
  });
}

export async function cmdWatchContext(
  zkHosts: string,
  key: string
): Promise<void> {
  await withZk(zkHosts, async ({ zk }) => {
    const value = await zk.watchContextKey(key, (newData) => {
      output({ key, value: newData?.value ?? null, event: "changed" });
      process.exit(0);
    });
    if (value === null) {
      output({ key, value: null, message: `Watching key '${key}' for changes... (Ctrl+C to stop)` });
    } else {
      output({ key, value: value.value, message: `Watching key '${key}' for changes... (Ctrl+C to stop)` });
    }
    // Keep process alive waiting for watch callback
    await new Promise(() => {});
  });
}

export async function cmdWatchTasks(zkHosts: string): Promise<void> {
  await withZk(zkHosts, async ({ zk }) => {
    const children = await zk.watchPendingTasks((newChildren) => {
      output({ event: "tasks_changed", pending_count: newChildren.length, tasks: newChildren });
      process.exit(0);
    });
    output({
      pending_count: children.length,
      message: "Watching for new tasks... (Ctrl+C to stop)",
    });
    await new Promise(() => {});
  });
}

export async function cmdUnregister(
  zkHosts: string,
  cliInstanceId: string | undefined
): Promise<void> {
  const instanceId = resolveInstanceId(cliInstanceId);

  await withZk(zkHosts, async ({ registry }) => {
    await registry.unregister(instanceId);
    output({ status: "unregistered", instance_id: instanceId });
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function cmdSetup(options: {
  leader: boolean;
  name?: string;
  role?: string;
  cacheDir?: string;
  command?: string;
  global: boolean;
  instanceId?: string;
}): Promise<void> {
  const { leader, name, role, cacheDir, command, global: isGlobal } = options;

  const resolvedRole = leader ? "leader" : (role || "general");
  const resolvedName = name || (leader ? "Leader" : undefined);

  const defaultCommand = "claude --dangerously-skip-permissions -v";
  const defaultCacheDir = "~/.claude-orchestrator/sessions";

  // ── Write global config with command and cache_dir ──
  const existingGlobal = loadGlobalConfig();
  saveInstanceConfig(
    {
      command: command || existingGlobal.command || defaultCommand,
      cache_dir: cacheDir || existingGlobal.cache_dir || defaultCacheDir,
    },
    true
  );

  if (isGlobal) {
    output({
      status: "configured",
      global: true,
      config: loadGlobalConfig(),
      message: "Global config written. Run with --leader or in a project to create templates and project config.",
    });
    return;
  }

  // ── Write project config ──
  const projectConfig: Record<string, unknown> = {};
  if (resolvedName) projectConfig["name"] = resolvedName;
  projectConfig["role"] = resolvedRole;
  saveInstanceConfig(projectConfig, false);

  // ── Copy templates to .claude-orchestrator/agents/ ──
  const templateDir = path.join(__dirname, "..", "templates");
  const agentsDir = path.join(process.cwd(), ".claude-orchestrator", "agents");

  const templates: Record<string, string> = {
    "leader.md": path.join(templateDir, "leader.md"),
    "worker.md": path.join(templateDir, "worker.md"),
  };

  const written: string[] = [];
  const skipped: string[] = [];

  for (const [filename, srcPath] of Object.entries(templates)) {
    const destPath = path.join(agentsDir, filename);
    fs.mkdirSync(agentsDir, { recursive: true });

    if (fs.existsSync(destPath)) {
      skipped.push(filename);
    } else {
      const content = fs.readFileSync(srcPath, "utf-8");
      fs.writeFileSync(destPath, content);
      written.push(filename);
    }
  }

  const result: Record<string, unknown> = {
    status: "configured",
    project_config: path.join(process.cwd(), ".claude-orchestrator", "config.json"),
    templates_dir: agentsDir,
  };
  if (written.length > 0) result["templates_written"] = written;
  if (skipped.length > 0) result["templates_skipped"] = skipped;
  if (!resolvedName) result["warning"] = "No name provided. Use --name to set instance name.";

  output(result);
}

export async function cmdTaskBlock(
  zkHosts: string,
  cliInstanceId: string | undefined,
  taskId: string,
  reason: string,
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const task = await taskQueue.block(instanceId, taskId, reason);
    output(task);
  });
}

export async function cmdTaskFail(
  zkHosts: string,
  cliInstanceId: string | undefined,
  taskId: string,
  reason: string,
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const task = await taskQueue.fail(instanceId, taskId, reason);
    output(task);
  });
}

export async function cmdTaskRetry(
  zkHosts: string,
  _cliInstanceId: string | undefined,
  taskId: string,
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const task = await taskQueue.retry(taskId);
    output(task);
  });
}
