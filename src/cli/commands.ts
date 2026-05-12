import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ZkClient } from "../zk/client.js";
import { InstanceRegistry } from "../modules/registry.js";
import { TaskQueue } from "../modules/task-queue.js";
import { MessageRouter } from "../modules/message-router.js";
import { loadConfig, loadInstanceConfig, saveInstanceConfig, saveInstanceId, loadInstanceId, loadGlobalConfig, resolveInstanceId, expandHomeDir } from "../config.js";
import { output } from "../utils/output.js";
import { WorkerWatcher } from "../worker/watcher.js";

const VALID_ROLES = ["planner", "builder", "verifier", "reviewer", "accepter", "leader"] as const;

async function withZk<T>(
  hosts: string,
  fn: (clients: {
    zk: ZkClient;
    registry: InstanceRegistry;
    taskQueue: TaskQueue;
    messageRouter: MessageRouter;
  }) => Promise<T>
): Promise<T> {
  const zk = new ZkClient(hosts);
  await zk.connect();
  const registry = new InstanceRegistry(zk);
  const taskQueue = new TaskQueue(zk);
  const messageRouter = new MessageRouter(zk);
  try {
    return await fn({ zk, registry, taskQueue, messageRouter });
  } finally {
    await zk.disconnect();
  }
}

export async function cmdRegister(zkHosts: string): Promise<void> {
  // Read from project config only — no CLI args, no global fallback
  const projectConfig = loadInstanceConfig();
  const name = projectConfig.name;
  const role = projectConfig.role;

  if (!name) {
    output({ error: "name is required in .claude-orchestrator/config.json" }, true);
    return;
  }
  if (!role || !(VALID_ROLES as readonly string[]).includes(role)) {
    output({
      error: `invalid role '${role || "(missing)"}', must be one of: ${VALID_ROLES.join(", ")}`,
    }, true);
    return;
  }

  const resolvedConfig = loadConfig({});
  const instanceId = projectConfig.instance_id || undefined;

  const zk = new ZkClient(zkHosts);
  await zk.connect();
  const registry = new InstanceRegistry(zk);

  const instance = await registry.register(name, role, instanceId);
  saveInstanceId(instance.id);
  if (!projectConfig.instance_id) {
    saveInstanceConfig({ name, role, instance_id: instance.id });
  }
  output(instance);

  // Resolve leader instance ID for CACHE_DIR path
  const leaderData = await zk.getLeader();
  const leaderInstanceId = (leaderData?.instance_id as string) ?? instance.id;

  const watcher = new WorkerWatcher(
    zk,
    instance.id,
    process.cwd(),
    resolvedConfig.cliCommand,
    resolvedConfig.cacheDir,
    leaderInstanceId,
  );

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
}

export async function cmdPushTask(
  zkHosts: string,
  cliInstanceId: string | undefined,
  title: string,
  description: string,
  priority: number,
  assignee?: string,
  link?: string,
  chainId?: string,
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = cliInstanceId ?? "";
    const task = await taskQueue.push(title, description, priority, instanceId, assignee, undefined, undefined, link ?? null, chainId ?? null);
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

export async function cmdPollTask(
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

export async function cmdPollMessage(
  zkHosts: string,
  cliInstanceId: string | undefined
): Promise<void> {
  await withZk(zkHosts, async ({ messageRouter }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const messages = await messageRouter.poll(instanceId);
    output(messages);
  });
}

export async function cmdDeleteMessage(
  zkHosts: string,
  cliInstanceId: string | undefined,
  messageId: string
): Promise<void> {
  await withZk(zkHosts, async ({ messageRouter }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    await messageRouter.dismissMessage(instanceId, messageId);
    output({ status: "deleted", message_id: messageId });
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

  const resolvedRole = leader ? "leader" : (role || "builder");
  const resolvedName = name || (leader ? "Leader" : undefined);

  const defaultCliCommand = "claude --dangerously-skip-permissions --permission-mode dontAsk";
  const defaultCacheDir = "~/.claude-orchestrator/sessions";

  // ── Write global config ──
  const existingGlobal = loadGlobalConfig();
  const globalZk = existingGlobal.zookeeper || { url: "127.0.0.1:2181", root_path: "/claude-orchestrator", auth: null };
  const prevCommands = existingGlobal.commands;
  saveInstanceConfig(
    {
      commands: {
        "claude-cli": command || prevCommands?.["claude-cli"] || defaultCliCommand,
        "leader-sync": prevCommands?.["leader-sync"] ?? null,
      },
      cache_dir: cacheDir || existingGlobal.cache_dir || defaultCacheDir,
      zookeeper: {
        url: globalZk.url || "127.0.0.1:2181",
        root_path: globalZk.root_path || "/claude-orchestrator",
        auth: globalZk.auth ?? null,
      },
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
    "leader-decompose.md": path.join(templateDir, "leader-decompose.md"),
    "leader-decide.md": path.join(templateDir, "leader-decide.md"),
    "worker.md": path.join(templateDir, "worker.md"),
    "worker-plan.md": path.join(templateDir, "worker-plan.md"),
    "worker-build.md": path.join(templateDir, "worker-build.md"),
    "worker-verify.md": path.join(templateDir, "worker-verify.md"),
    "worker-review.md": path.join(templateDir, "worker-review.md"),
    "worker-accept.md": path.join(templateDir, "worker-accept.md"),
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
