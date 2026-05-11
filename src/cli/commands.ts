import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { ZkClient } from "../zk/client.js";
import { InstanceRegistry } from "../modules/registry.js";
import { TaskQueue } from "../modules/task-queue.js";
import { MessageRouter } from "../modules/message-router.js";
import { ContextStore } from "../modules/context-store.js";
import { resolveInstanceId, saveInstanceId, saveInstanceConfig, loadInstanceConfig, loadInstanceId } from "../config.js";
import { output } from "../utils/output.js";
import { TaskPriorityName } from "../models/schemas.js";

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

function registerViaHttp(
  host: string,
  port: string,
  name: string,
  role: string,
  instanceId?: string
): Promise<{ id: string; name: string; role: string }> {
  const body = JSON.stringify({ name, role, instance_id: instanceId });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port: parseInt(port, 10),
        path: "/register",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON response: ${data}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

function unregisterViaHttp(
  host: string,
  port: string,
  instanceId: string
): Promise<void> {
  const body = JSON.stringify({ instance_id: instanceId });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port: parseInt(port, 10),
        path: "/unregister",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${data}`)));
        }
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
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
  role?: string
): Promise<void> {
  const config = loadInstanceConfig();
  const resolvedName = name || config.name;
  if (!resolvedName) {
    output({ error: "No instance name provided. Use --name or run 'claude-orchestrator setup --name <name>' first." }, true);
    return;
  }
  const resolvedRole = role || config.role || "general";
  const resolvedId = instanceId || loadInstanceId() || undefined;

  // Try MCP server REST endpoint first (uses server's persistent ZK connection)
  const host = config.host || "127.0.0.1";
  const port = config.port || "3100";
  try {
    const instance = await registerViaHttp(host, port, resolvedName, resolvedRole, resolvedId);
    saveInstanceId(instance.id);
    saveInstanceConfig({ name: resolvedName, role: resolvedRole });
    output(instance);
    return;
  } catch {
    // Server not reachable — fall back to direct ZK
  }

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
  broadcast: boolean = false
): Promise<void> {
  await withZk(zkHosts, async ({ registry, messageRouter }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const inst = await registry.get(instanceId);
    const fromName = inst?.name ?? instanceId.slice(0, 8);
    const messages = await messageRouter.send(
      instanceId,
      fromName,
      content,
      toInstance,
      broadcast
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
    const instanceId = resolveInstanceId(cliInstanceId);
    const inst = await registry.get(instanceId);
    const fromName = inst?.name ?? instanceId.slice(0, 8);
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

  // Try MCP server REST endpoint first
  const config = loadInstanceConfig();
  const host = config.host || "127.0.0.1";
  const port = config.port || "3100";
  try {
    await unregisterViaHttp(host, port, instanceId);
    output({ status: "unregistered", instance_id: instanceId });
    return;
  } catch {
    // Server not reachable — fall back to direct ZK
  }

  await withZk(zkHosts, async ({ registry }) => {
    await registry.unregister(instanceId);
    output({ status: "unregistered", instance_id: instanceId });
  });
}

export async function cmdSetup(options: {
  port: string;
  host: string;
  name?: string;
  role?: string;
  global: boolean;
  withHook: boolean;
}): Promise<void> {
  const { port, host, name, role, global: isGlobal, withHook } = options;

  const claudeDir = isGlobal
    ? path.join(os.homedir(), ".claude")
    : path.join(process.cwd(), ".claude");

  const mcpFile = path.join(claudeDir, "mcp.json");

  const entry: Record<string, unknown> = {
    type: "http",
    url: `http://${host}:${port}/mcp`,
  };

  if (name) {
    const headers: Record<string, string> = {
      "X-Instance-Name": name,
    };
    if (role) {
      headers["X-Instance-Role"] = role;
    }
    entry["headers"] = headers;
  }

  // Write .claude/mcp.json
  let mcpConfig: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(mcpFile)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpFile, "utf-8"));
    } catch {
      output({ error: `Failed to parse existing ${mcpFile}` }, true);
      return;
    }
  }

  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  mcpConfig.mcpServers["orchestrator"] = entry;

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2) + "\n");

  // Save instance config for auto-registration
  if (name || role) {
    saveInstanceConfig({ name, role, port, host }, isGlobal);
  }

  // Optionally create SessionStart + Stop hooks
  if (withHook) {
    const settingsFile = path.join(claudeDir, "settings.json");
    let settings: { hooks?: Record<string, unknown[]> } = {};
    if (fs.existsSync(settingsFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      } catch {
        output({ error: `Failed to parse existing ${settingsFile}` }, true);
        return;
      }
    }
    settings.hooks = settings.hooks || {};

    const addHook = (hookType: string, command: string) => {
      const existing = (settings.hooks![hookType] || []) as unknown[];
      const alreadyExists = existing.some(
        (h: unknown) => {
          const hooks = (h as Record<string, unknown>)?.hooks as Array<Record<string, unknown>> | undefined;
          return hooks?.[0]?.command === command;
        }
      );
      if (!alreadyExists) {
        existing.push({ matcher: "", hooks: [{ type: "command", command }] });
        settings.hooks![hookType] = existing;
      }
    };

    addHook("SessionStart", "claude-orchestrator register");
    addHook("Stop", "claude-orchestrator unregister");

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  }

  output({
    status: "configured",
    file: mcpFile,
    entry,
    ...(withHook ? { hooks: ["SessionStart: claude-orchestrator register", "Stop: claude-orchestrator unregister"] } : {}),
    ...(name ? { instance_config: `saved to ${isGlobal ? "~/.claude-orchestrator" : ".claude-orchestrator"}/config.json` } : {}),
  });
}
