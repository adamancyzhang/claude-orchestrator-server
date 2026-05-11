import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { spawn } from "child_process";
import { ZkClient } from "../zk/client.js";
import * as paths from "../zk/paths.js";
import { InstanceRegistry } from "../modules/registry.js";
import { TaskQueue } from "../modules/task-queue.js";
import { MessageRouter } from "../modules/message-router.js";
import { ContextStore } from "../modules/context-store.js";
import { resolveInstanceId, saveInstanceId, saveInstanceConfig, loadInstanceConfig, loadInstanceId } from "../config.js";
import { output } from "../utils/output.js";
import { TaskPriorityName, MessageSchema } from "../models/schemas.js";

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

    console.log(`\nWatching for messages on instance ${instance.id.slice(0, 8)}...`);
    console.log(`Work dir: ${workDir}`);
    console.log("Press Ctrl+C to stop.\n");

    const inFlight = new Set<string>();
    let stopped = false;

    const onSigint = () => {
      stopped = true;
      console.log("\nShutting down...");
    };
    process.on("SIGINT", onSigint);

    const processMessage = async (msgId: string) => {
      if (inFlight.has(msgId)) return;
      const data = await zk.getMessage(instance.id, msgId);
      if (!data) return;
      const msg = MessageSchema.parse({ ...data, id: msgId });
      if (msg.read) return;

      inFlight.add(msgId);

      const fromLabel = msg.from_name || msg.from_instance?.slice(0, 8) || "unknown";
      const timestamp = new Date().toLocaleTimeString();

      console.log(`[${timestamp}] 📨 Message from ${fromLabel} (${msg.type}):`);
      console.log(`  ${msg.content}\n`);

      // Spawn claude -p
      const prompt = `[${msg.type} from ${fromLabel}] ${msg.content}`;
      console.log(`[${timestamp}] 🔄 Processing with claude -p...`);

      try {
        const child = spawn("claude", ["--session-id", instance.id, "-p", prompt], {
          cwd: workDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

        const { code, error } = await new Promise<{ code: number; error: Error | null }>((resolve) => {
          child.on("exit", (code) => resolve({ code: code ?? -1, error: null }));
          child.on("error", (err) => resolve({ code: -1, error: err }));
        });

        if (error) {
          console.error(`[${timestamp}] ❌ claude failed: ${error.message}\n`);
        } else if (code !== 0) {
          console.error(`[${timestamp}] ❌ claude exited ${code}\n`);
          if (stderr) console.error(`  stderr: ${stderr.slice(0, 500)}\n`);
        } else {
          console.log(`[${timestamp}] ✅ Response:`);
          console.log(`  ${stdout.slice(0, 2000)}\n`);
        }
      } catch (err) {
        console.error(`[${timestamp}] ❌ Unexpected error: ${String(err)}\n`);
      }

      // Mark as read
      try {
        msg.read = true;
        await zk.updateMessage(instance.id, msgId, msg as unknown as Record<string, unknown>);
      } catch {
        // best effort
      }

      inFlight.delete(msgId);
    };

    const watchLoop = async () => {
      if (stopped) return;
      try {
        const children = await zk.watchMessageDir(instance.id, async (newChildren: string[]) => {
          for (const cid of newChildren) {
            await processMessage(cid);
          }
          watchLoop();
        });
        for (const cid of children) {
          await processMessage(cid);
        }
      } catch {
        if (!stopped) watchLoop();
      }
    };

    await zk.mkdirp(paths.messageDirPath(instance.id));
    watchLoop();

    // Block until SIGINT
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (stopped) {
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
}): Promise<void> {
  const { port, host, name, role, global: isGlobal } = options;

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

  output({
    status: "configured",
    file: mcpFile,
    entry,
    ...(name ? { instance_config: `saved to ${isGlobal ? "~/.claude-orchestrator" : ".claude-orchestrator"}/config.json` } : {}),
  });
}
