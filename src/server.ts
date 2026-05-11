import { z } from "zod";
import express from "express";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ZkClient } from "./zk/client.js";
import { InstanceRegistry } from "./modules/registry.js";
import { TaskQueue } from "./modules/task-queue.js";
import { MessageRouter } from "./modules/message-router.js";
import { ContextStore } from "./modules/context-store.js";
import {
  InstanceSchema,
  TaskSchema,
  MessageSchema,
  ContextEntrySchema,
  TaskPriorityName,
} from "./models/schemas.js";
import type { Config } from "./config.js";

// ── Tool callback types ──

type ToolCallback<Args> = (
  args: Args,
  extra: { requestId?: string }
) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

// ── Start server ──

export async function startServer(config: Config): Promise<void> {
  const zk = new ZkClient(config.zkHosts);
  await zk.connect();

  const registry = new InstanceRegistry(zk);
  const taskQueue = new TaskQueue(zk);
  const messageRouter = new MessageRouter(zk);
  const contextStore = new ContextStore(zk);

  // ── Setup MCP Server ──

  const mcp = new McpServer(
    {
      name: "ClaudeMCP",
      version: "0.2.1",
    },
    {
      capabilities: {
        resources: { subscribe: true },
      },
    }
  );

  // ── Register Tools (18) ──

  // 1. server_status
  mcp.tool("server_status", async () => {
    const zkOk = zk.connected;
    return {
      content: [
        {
          type: "text",
          text: `Server: running\nZooKeeper: ${zkOk ? "connected" : "DISCONNECTED"}\nPort: ${config.port}`,
        },
      ],
    };
  });

  // 2. register_instance
  mcp.tool(
    "register_instance",
    {
      name: z.string().min(1),
      role: z.string().default("general"),
      instance_id: z.string().optional(),
    },
    async ({ name, role, instance_id }) => {
      if (!zk.connected) {
        return { content: [{ type: "text", text: "Error: ZooKeeper is not connected." }] };
      }
      const instance = await registry.register(name, role, instance_id);
      const action = instance_id && instance.id === instance_id ? "re-registered" : "registered";
      return {
        content: [
          {
            type: "text",
            text: `Instance ${action}:\n${JSON.stringify(instance, null, 2)}`,
          },
        ],
      };
    }
  );

  // 3. heartbeat
  mcp.tool(
    "heartbeat",
    {
      instance_id: z.string(),
      current_task: z.string().optional(),
    },
    async ({ instance_id, current_task }) => {
      await registry.heartbeat(instance_id, current_task);
      return { content: [{ type: "text", text: "ok" }] };
    }
  );

  // 4. list_instances
  mcp.tool("list_instances", async () => {
    const instances = await registry.listAll();
    const n = instances.length;
    const header = `${n} active instance${n !== 1 ? "s" : ""}:\n`;
    const lines = instances.map(
      (i) =>
        `  [${i.role}] ${i.name} (${i.id.slice(0, 8)}...) status=${i.status}`
    );
    return { content: [{ type: "text", text: header + lines.join("\n") }] };
  });

  // 5. push_task
  mcp.tool(
    "push_task",
    {
      title: z.string().min(1),
      description: z.string().default(""),
      priority: z.number().int().min(0).max(2).default(1),
      instance_id: z.string().default(""),
      assignee: z.string().optional(),
    },
    async ({ title, description, priority, instance_id, assignee }) => {
      const task = await taskQueue.push(title, description, priority, instance_id, assignee);
      const prioName = TaskPriorityName[task.priority] ?? "MEDIUM";
      return {
        content: [
          {
            type: "text",
            text: `Task ${task.id} created:\n  title: ${task.title}\n  priority: ${prioName}`,
          },
        ],
      };
    }
  );

  // 6. claim_task
  mcp.tool("claim_task", { instance_id: z.string() }, async ({ instance_id }) => {
    const task = await taskQueue.claim(instance_id);
    if (!task) {
      return { content: [{ type: "text", text: "No pending tasks available." }] };
    }
    return {
      content: [
        {
          type: "text",
          text: `Claimed task ${task.id}\n  title: ${task.title}\n  description: ${task.description}`,
        },
      ],
    };
  });

  // 7. complete_task
  mcp.tool(
    "complete_task",
    {
      instance_id: z.string(),
      task_id: z.string(),
      result: z.string(),
    },
    async ({ instance_id, task_id, result: resultText }) => {
      const task = await taskQueue.complete(instance_id, task_id, resultText);
      return { content: [{ type: "text", text: `Task ${task.id} completed.` }] };
    }
  );

  // 8. list_tasks
  mcp.tool("list_tasks", { status: z.string().optional() }, async ({ status }) => {
    const tasks = await taskQueue.listTasks(status);
    if (tasks.length === 0) {
      return { content: [{ type: "text", text: "No tasks found." }] };
    }
    const lines = [`${tasks.length} task(s):`];
    for (const t of tasks) {
      lines.push(`  [${t.status}] ${t.id}: ${t.title || "(no title)"}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // 9. send_message
  mcp.tool(
    "send_message",
    {
      instance_id: z.string(),
      content: z.string().min(1),
      to_instance: z.string().optional(),
      broadcast: z.boolean().default(false),
    },
    async ({ instance_id, content, to_instance, broadcast }) => {
      const inst = await registry.get(instance_id);
      const fromName = inst?.name ?? instance_id.slice(0, 8);
      const messages = await messageRouter.send(
        instance_id,
        fromName,
        content,
        to_instance,
        broadcast
      );
      const targets = messages.map((m) => m.to_instance);
      return {
        content: [{ type: "text", text: `Message sent to: ${JSON.stringify(targets)}` }],
      };
    }
  );

  // 10. poll_messages
  mcp.tool("poll_messages", { instance_id: z.string() }, async ({ instance_id }) => {
    const messages = await messageRouter.poll(instance_id);
    if (messages.length === 0) {
      return { content: [{ type: "text", text: "No messages." }] };
    }
    const lines = [`${messages.length} message(s):`];
    for (const m of messages) {
      const readMark = m.read ? " [read]" : "";
      lines.push(
        `  [${m.type}] from ${m.from_name}: ${m.content.slice(0, 100)}${readMark}`
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // 11. wait_for_message
  mcp.tool(
    "wait_for_message",
    {
      instance_id: z.string(),
      timeout_seconds: z.number().int().min(1).default(30),
    },
    async ({ instance_id, timeout_seconds }) => {
      const messages = await messageRouter.waitForMessage(instance_id, timeout_seconds);
      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No messages received within timeout." }] };
      }
      const lines = [`${messages.length} message(s):`];
      for (const m of messages) {
        lines.push(`  [${m.type}] from ${m.from_name}: ${m.content.slice(0, 200)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // 12. mark_read
  mcp.tool(
    "mark_read",
    {
      instance_id: z.string(),
      message_id: z.string(),
    },
    async ({ instance_id, message_id }) => {
      await messageRouter.markRead(instance_id, message_id);
      return { content: [{ type: "text", text: `Message ${message_id} marked as read.` }] };
    }
  );

  // 13. dismiss_message
  mcp.tool(
    "dismiss_message",
    {
      instance_id: z.string(),
      message_id: z.string(),
    },
    async ({ instance_id, message_id }) => {
      await messageRouter.dismissMessage(instance_id, message_id);
      return { content: [{ type: "text", text: `Message ${message_id} dismissed.` }] };
    }
  );

  // 14. request_help
  mcp.tool(
    "request_help",
    {
      instance_id: z.string(),
      question: z.string().min(1),
      context: z.string().optional(),
    },
    async ({ instance_id, question, context }) => {
      const inst = await registry.get(instance_id);
      const fromName = inst?.name ?? instance_id.slice(0, 8);
      const messages = await messageRouter.requestHelp(
        instance_id,
        fromName,
        question,
        context
      );
      const targets = messages.map((m) => m.to_instance);
      return {
        content: [
          {
            type: "text",
            text: `Help request broadcast to ${targets.length} instance(s): ${JSON.stringify(targets)}`,
          },
        ],
      };
    }
  );

  // 15. set_context
  mcp.tool(
    "set_context",
    {
      key: z.string().min(1),
      value: z.string(),
      instance_id: z.string().default(""),
    },
    async ({ key, value, instance_id }) => {
      await contextStore.set(key, value, instance_id);
      return { content: [{ type: "text", text: `Context set: ${key} = ${value}` }] };
    }
  );

  // 16. get_context
  mcp.tool("get_context", { key: z.string() }, async ({ key }) => {
    const value = await contextStore.get(key);
    if (value === null) {
      return { content: [{ type: "text", text: `No context found for key: ${key}` }] };
    }
    return { content: [{ type: "text", text: `${key} = ${value}` }] };
  });

  // 17. delete_context
  mcp.tool("delete_context", { key: z.string() }, async ({ key }) => {
    await contextStore.delete(key);
    return { content: [{ type: "text", text: `Context deleted: ${key}` }] };
  });

  // 18. list_context_keys
  mcp.tool("list_context_keys", async () => {
    const keys = await contextStore.listKeys();
    if (keys.length === 0) {
      return { content: [{ type: "text", text: "No context keys found." }] };
    }
    return { content: [{ type: "text", text: `${keys.length} key(s):\n${keys.join("\n")}` }] };
  });

  // ── Register Resources (5) ──

  // 1. orchestrator://instances
  mcp.resource(
    "instances",
    "orchestrator://instances",
    { description: "All active instances" },
    async () => {
      const instances = await registry.listAll();
      return {
        contents: [
          {
            uri: "orchestrator://instances",
            mimeType: "application/json",
            text: JSON.stringify(instances, null, 2),
          },
        ],
      };
    }
  );

  // 2. orchestrator://tasks/pending
  mcp.resource(
    "tasks-pending",
    "orchestrator://tasks/pending",
    { description: "Pending tasks" },
    async () => {
      const tasks = await taskQueue.listTasks("pending");
      return {
        contents: [
          {
            uri: "orchestrator://tasks/pending",
            mimeType: "application/json",
            text: JSON.stringify(tasks, null, 2),
          },
        ],
      };
    }
  );

  // 3. orchestrator://tasks/in-progress
  mcp.resource(
    "tasks-in-progress",
    "orchestrator://tasks/in-progress",
    { description: "Claimed tasks in progress" },
    async () => {
      const tasks = await taskQueue.listTasks("claimed");
      return {
        contents: [
          {
            uri: "orchestrator://tasks/in-progress",
            mimeType: "application/json",
            text: JSON.stringify(tasks, null, 2),
          },
        ],
      };
    }
  );

  // 4. orchestrator://messages/{instance_id} (supports subscription)
  mcp.resource(
    "messages",
    new ResourceTemplate("orchestrator://messages/{instance_id}", {
      list: undefined,
    }),
    { description: "Messages for a specific instance" },
    async (uri) => {
      const instanceId = uri.searchParams.get("instance_id") ?? "";
      const messages = await messageRouter.poll(instanceId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(messages, null, 2),
          },
        ],
      };
    }
  );

  // 5. orchestrator://context/{key} (supports subscription)
  mcp.resource(
    "context",
    new ResourceTemplate("orchestrator://context/{key}", {
      list: undefined,
    }),
    { description: "Shared context value by key" },
    async (uri) => {
      const key = uri.searchParams.get("key") ?? "";
      const value = await contextStore.get(key);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(value !== null ? { key, value } : { key, value: null }, null, 2),
          },
        ],
      };
    }
  );

  // ── Register Prompts (2) ──

  // 1. orchestrate-task
  mcp.prompt(
    "orchestrate-task",
    "Help break down a goal into assignable tasks",
    {
      goal: z.string().describe("The goal or objective to break down"),
      context: z.string().optional().describe("Additional context about team state"),
    },
    async ({ goal, context: ctx }) => {
      const instances = await registry.listAll();
      const pendingTasks = await taskQueue.listTasks("pending");
      const members = instances
        .map((i) => `- ${i.name} (${i.id.slice(0, 8)}...) [${i.role}] status=${i.status}`)
        .join("\n");

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Goal: ${goal}\n\n` +
                `Team members:\n${members}\n\n` +
                `Pending tasks: ${pendingTasks.length}\n` +
                (ctx ? `Additional context: ${ctx}\n\n` : "") +
                `Please break this goal down into specific, assignable tasks. For each task, suggest:\n` +
                `1. A clear title\n` +
                `2. A brief description\n` +
                `3. Priority (HIGH=0, MEDIUM=1, LOW=2)\n` +
                `4. Which team member should handle it\n\n` +
                `Output the tasks in a format ready to assign.`,
            },
          },
        ],
      };
    }
  );

  // 2. team-status
  mcp.prompt("team-status", "Summarize current team state", async () => {
    const instances = await registry.listAll();
    const pending = await taskQueue.listTasks("pending");
    const claimed = await taskQueue.listTasks("claimed");

    const members = instances
      .map((i) => `- ${i.name} (${i.id.slice(0, 8)}...) [${i.role}] status=${i.status}`)
      .join("\n");

    const pendingList = pending
      .map((t) => `- [${TaskPriorityName[t.priority]}] ${t.title} (${t.id})`)
      .join("\n");

    const claimedList = claimed
      .map((t) => `- ${t.title} by ${t.claimed_by?.slice(0, 8)}... (${t.id})`)
      .join("\n");

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# Team Status\n\n` +
              `## Members (${instances.length})\n${members}\n\n` +
              `## Pending Tasks (${pending.length})\n${pendingList || "(none)"}\n\n` +
              `## In Progress (${claimed.length})\n${claimedList || "(none)"}`,
          },
        },
      ],
    };
  });

  // ── Start HTTP server with MCP transport ──

  const app = express();
  app.use(express.json());

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  // Connect MCP server to transport
  await mcp.connect(transport);

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP request handling failed" });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP request handling failed" });
      }
    }
  });

  app.delete("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP request handling failed" });
      }
    }
  });

  // REST endpoint for CLI-based registration (uses server's persistent ZK connection)
  app.post("/register", async (req, res) => {
    try {
      const { name, role, instance_id } = req.body;
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!zk.connected) {
        res.status(503).json({ error: "ZooKeeper is not connected" });
        return;
      }
      const instance = await registry.register(
        name,
        typeof role === "string" ? role : "general",
        typeof instance_id === "string" ? instance_id : undefined
      );
      res.json(instance);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // REST endpoint for CLI-based unregistration
  app.post("/unregister", async (req, res) => {
    try {
      const { instance_id } = req.body;
      if (!instance_id || typeof instance_id !== "string") {
        res.status(400).json({ error: "instance_id is required" });
        return;
      }
      if (!zk.connected) {
        res.status(503).json({ error: "ZooKeeper is not connected" });
        return;
      }
      await registry.unregister(instance_id);
      res.json({ status: "unregistered", instance_id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", zookeeper: zk.connected ? "connected" : "disconnected" });
  });

  return new Promise((resolve) => {
    app.listen(config.port, config.host, () => {
      console.log(`MCP server listening on ${config.host}:${config.port}`);
      console.log(`MCP endpoint:  http://${config.host}:${config.port}/mcp`);
      console.log(`Register CLI:  http://${config.host}:${config.port}/register`);
      console.log(`Health check:  http://${config.host}:${config.port}/health`);
      resolve();
    });
  });
}
