#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, loadInstanceId } from "./config.js";
import {
  cmdStatus,
  cmdRegister,
  cmdHeartbeat,
  cmdListInstances,
  cmdPushTask,
  cmdClaimTask,
  cmdCompleteTask,
  cmdListTasks,
  cmdSendMessage,
  cmdPollMessages,
  cmdWaitForMessage,
  cmdDismissMessage,
  cmdRequestHelp,
  cmdSetContext,
  cmdGetContext,
  cmdDeleteContext,
  cmdListContextKeys,
  cmdWatchContext,
  cmdWatchTasks,
  cmdUnregister,
  cmdSetup,
} from "./cli/commands.js";
import { output } from "./utils/output.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("claude-orchestrator")
  .description("Multi-agent orchestration CLI backed by ZooKeeper")
  .version(pkg.version)
  .option(
    "-z, --zookeeper <hosts>",
    "ZooKeeper connection string (env: ZK_HOSTS)",
    "127.0.0.1:2181"
  )
  .option(
    "-i, --instance-id <id>",
    "Instance ID (reads from .claude-orchestrator/config.json or ~/.claude-orchestrator/config.json if omitted)"
  )
  .hook("preAction", (thisCmd: Command) => {
    const opts = thisCmd.opts();
    if (process.env.ZK_HOSTS && (!opts.zookeeper || opts.zookeeper === "127.0.0.1:2181")) {
      thisCmd.setOptionValue("zookeeper", process.env.ZK_HOSTS);
    }
  });

// Helper to extract typed options from a Command
function getOpts(cmd: Command): {
  zookeeper: string;
  instanceId?: string;
} {
  return cmd.optsWithGlobals() as { zookeeper: string; instanceId?: string };
}

function getSubOpts<T>(cmd: Command): T {
  return cmd.opts() as T;
}

// ── Commands ──

program
  .command("status")
  .description("Check server connection and ZooKeeper health")
  .action(async function (this: Command) {
    try {
      await cmdStatus(getOpts(this).zookeeper);
    } catch (e) {
      output({ status: "error", zookeeper: String(e), instances_online: 0 }, true);
    }
  });

program
  .command("register")
  .description("Register this instance with the orchestrator")
  .option("--name <name>", "Display name (reads from config if omitted)")
  .option("--role <role>", "Instance role (reads from config if omitted)")
  .action(async function (this: Command) {
    try {
      const { name, role } = getSubOpts<{ name?: string; role?: string }>(this);
      const { zookeeper, instanceId } = getOpts(this);
      await cmdRegister(zookeeper, instanceId, name, role);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("heartbeat")
  .description("Send heartbeat to keep registration alive")
  .option("--current-task <id>", "Current task title (omit to clear)")
  .action(async function (this: Command) {
    try {
      const { currentTask } = getSubOpts<{ currentTask?: string }>(this);
      const { zookeeper, instanceId } = getOpts(this);
      await cmdHeartbeat(zookeeper, instanceId, currentTask);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("list-instances")
  .description("List all active instances")
  .action(async function (this: Command) {
    try {
      await cmdListInstances(getOpts(this).zookeeper);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("push-task")
  .description("Create and push a new task to the queue")
  .requiredOption("--title <title>", "Task title")
  .option("--description <text>", "Task description", "")
  .option("--priority <n>", "Priority: 0=HIGH, 1=MEDIUM, 2=LOW", "1")
  .option("--assignee <id>", "Target instance ID")
  .action(async function (this: Command) {
    try {
      const { title, description, priority, assignee } = getSubOpts<{
        title: string;
        description: string;
        priority: string;
        assignee?: string;
      }>(this);
      const { zookeeper, instanceId } = getOpts(this);
      await cmdPushTask(zookeeper, instanceId, title, description, parseInt(priority), assignee);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("claim-task")
  .description("Claim the highest-priority pending task")
  .action(async function (this: Command) {
    try {
      const { zookeeper, instanceId } = getOpts(this);
      await cmdClaimTask(zookeeper, instanceId);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("complete-task")
  .description("Mark a claimed task as completed")
  .requiredOption("--task-id <id>", "Task ID to complete")
  .requiredOption("--result <text>", "Summary of what was accomplished")
  .action(async function (this: Command) {
    try {
      const { taskId, result } = getSubOpts<{ taskId: string; result: string }>(this);
      const { zookeeper, instanceId } = getOpts(this);
      await cmdCompleteTask(zookeeper, instanceId, taskId, result);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("list-tasks")
  .description("List tasks, optionally filtered by status")
  .option("--status <status>", "Filter: pending, claimed, completed")
  .action(async function (this: Command) {
    try {
      const { status } = getSubOpts<{ status?: string }>(this);
      await cmdListTasks(getOpts(this).zookeeper, status);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("send-message")
  .description("Send a message to another instance or broadcast to all")
  .requiredOption("--content <text>", "Message content")
  .option("--to <id>", "Recipient instance ID")
  .option("--broadcast", "Send to all instances", false)
  .action(async function (this: Command) {
    try {
      const { content, to, broadcast } = getSubOpts<{
        content: string;
        to?: string;
        broadcast: boolean;
      }>(this);
      if (!to && !broadcast) {
        throw new Error("Must specify --to or --broadcast");
      }
      const { zookeeper, instanceId } = getOpts(this);
      await cmdSendMessage(zookeeper, instanceId, content, to, broadcast);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("poll-messages")
  .description("Check for new messages")
  .action(async function (this: Command) {
    try {
      const { zookeeper, instanceId } = getOpts(this);
      await cmdPollMessages(zookeeper, instanceId);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("wait-for-message")
  .description("Wait for new messages (long poll)")
  .option("--timeout <seconds>", "Timeout in seconds", "30")
  .action(async function (this: Command) {
    try {
      const { timeout } = getSubOpts<{ timeout: string }>(this);
      const { zookeeper, instanceId } = getOpts(this);
      await cmdWaitForMessage(zookeeper, instanceId, parseInt(timeout));
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("dismiss-message")
  .description("Dismiss (delete) a message")
  .requiredOption("--message-id <id>", "Message ID to dismiss")
  .action(async function (this: Command) {
    try {
      const { messageId } = getSubOpts<{ messageId: string }>(this);
      const { zookeeper, instanceId } = getOpts(this);
      await cmdDismissMessage(zookeeper, instanceId, messageId);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("request-help")
  .description("Broadcast a help request to all online instances")
  .requiredOption("--question <text>", "Your question or problem description")
  .option("--context <text>", "Additional context (stack traces, logs)")
  .action(async function (this: Command) {
    try {
      const { question, context } = getSubOpts<{
        question: string;
        context?: string;
      }>(this);
      const { zookeeper, instanceId } = getOpts(this);
      await cmdRequestHelp(zookeeper, instanceId, question, context);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("set-context")
  .description("Store a shared context key-value pair")
  .requiredOption("--key <key>", "Context key")
  .requiredOption("--value <value>", "Context value")
  .action(async function (this: Command) {
    try {
      const { key, value } = getSubOpts<{ key: string; value: string }>(this);
      const { zookeeper, instanceId } = getOpts(this);
      await cmdSetContext(zookeeper, instanceId, key, value);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("get-context")
  .description("Retrieve a shared context value by key")
  .requiredOption("--key <key>", "Context key to retrieve")
  .action(async function (this: Command) {
    try {
      const { key } = getSubOpts<{ key: string }>(this);
      await cmdGetContext(getOpts(this).zookeeper, key);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("delete-context")
  .description("Delete a shared context key")
  .requiredOption("--key <key>", "Context key to delete")
  .action(async function (this: Command) {
    try {
      const { key } = getSubOpts<{ key: string }>(this);
      await cmdDeleteContext(getOpts(this).zookeeper, key);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("list-context-keys")
  .description("List all shared context keys")
  .action(async function (this: Command) {
    try {
      await cmdListContextKeys(getOpts(this).zookeeper);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("watch-context")
  .description("Watch a context key for changes (blocks until change)")
  .requiredOption("--key <key>", "Context key to watch")
  .action(async function (this: Command) {
    try {
      const { key } = getSubOpts<{ key: string }>(this);
      await cmdWatchContext(getOpts(this).zookeeper, key);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("watch-tasks")
  .description("Watch for new tasks (blocks until change)")
  .action(async function (this: Command) {
    try {
      await cmdWatchTasks(getOpts(this).zookeeper);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("unregister")
  .description("Explicitly unregister an instance")
  .action(async function (this: Command) {
    try {
      const { zookeeper, instanceId } = getOpts(this);
      await cmdUnregister(zookeeper, instanceId);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("config")
  .description("Show current configuration")
  .action(async function (this: Command) {
    const opts = getOpts(this);
    const resolvedId = opts.instanceId || loadInstanceId();
    output({
      zookeeper: opts.zookeeper,
      instance_id: resolvedId || "(not set)",
      config_dir: "~/.claude-orchestrator/",
    });
  });

program
  .command("setup")
  .description("Configure Claude Code MCP connection in the working directory")
  .option("--port <port>", "Orchestrator server port (default: 3100)", "3100")
  .option("--host <host>", "Orchestrator server host (default: 127.0.0.1)", "127.0.0.1")
  .option("--name <name>", "Instance name for X-Instance-Name header")
  .option("--role <role>", "Instance role for X-Instance-Role header")
  .option("--global", "Write to ~/.claude/mcp.json instead of local .claude/mcp.json", false)
  .option("--with-hook", "Add SessionStart hook to auto-register on Claude Code startup", false)
  .action(async function (this: Command) {
    const { port, host, name, role, global: isGlobal, withHook } = getSubOpts<{
      port: string;
      host: string;
      name?: string;
      role?: string;
      global: boolean;
      withHook: boolean;
    }>(this);
    await cmdSetup({ port, host, name, role, global: isGlobal, withHook });
  });

program
  .command("server")
  .description("Start MCP server")
  .option("--port <port>", "Server port (env: ORCHESTRATOR_PORT)", process.env.ORCHESTRATOR_PORT || "3100")
  .option("--host <host>", "Server host (env: ORCHESTRATOR_HOST)", process.env.ORCHESTRATOR_HOST || "127.0.0.1")
  .option("--name <name>", "Instance name for the server")
  .option("--role <role>", "Instance role for the server")
  .action(async function (this: Command) {
    const { port, host, name, role } = getSubOpts<{
      port: string;
      host: string;
      name?: string;
      role?: string;
    }>(this);
    const { zookeeper } = getOpts(this);

    const { startServer } = await import("./server.js");
    const config = loadConfig({ zookeeper, port, host });

    try {
      await startServer(config);
    } catch (e) {
      console.error("Failed to start server:", e);
      process.exit(1);
    }
  });

// ── Main entry ──

async function main() {
  program.parse();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
