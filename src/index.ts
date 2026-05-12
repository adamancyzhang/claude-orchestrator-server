#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, loadInstanceConfig } from "./config.js";
import {
  cmdRegister,
  cmdPushTask,
  cmdClaimTask,
  cmdCompleteTask,
  cmdPollTask,
  cmdSendMessage,
  cmdPollMessage,
  cmdDeleteMessage,
  cmdUnregister,
  cmdSetup,
  cmdTaskBlock,
  cmdTaskFail,
  cmdTaskRetry,
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
  );

function getZkHosts(cmd: Command): string {
  return cmd.optsWithGlobals().zookeeper || "127.0.0.1:2181";
}

function getSubOpts<T>(cmd: Command): T {
  return cmd.opts() as T;
}

// ── Commands ──

// ── Control Commands ──

program
  .command("leader")
  .description("Start Leader node (TUI orchestration console)")
  .option("--name <name>", "Leader display name")
  .action(async function (this: Command) {
    const { name } = getSubOpts<{ name?: string }>(this);
    const config = loadConfig({ zookeeper: getZkHosts(this) });
    const { startLeader } = await import("./leader/index.js");
    await startLeader({
      zkHosts: config.zk.url,
      name,
      instanceId: config.instanceId,
      command: config.cliCommand,
      cacheDir: config.cacheDir,
    });
  });

program
  .command("register")
  .description("Register as Worker and listen for messages (Ctrl+C to stop)")
  .action(async function (this: Command) {
    try {
      await cmdRegister(getZkHosts(this));
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("unregister")
  .description("Explicitly unregister an instance")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
    try {
      const { instanceId } = getSubOpts<{ instanceId?: string }>(this);
      await cmdUnregister(getZkHosts(this), instanceId);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("config")
  .description("Show current configuration")
  .action(async function (this: Command) {
    const config = loadConfig({ zookeeper: getZkHosts(this) });
    const projectConfig = loadInstanceConfig();
    output({
      zookeeper: config.zk,
      global: {
        cache_dir: config.cacheDir,
        "commands.claude-cli": config.cliCommand,
        "commands.leader-sync": config.leaderSync,
      },
      project: {
        name: projectConfig.name || "(not set)",
        role: projectConfig.role || "(not set)",
        instance_id: projectConfig.instance_id || "(not set)",
      },
    });
  });

program
  .command("setup")
  .description("Initialize orchestrator environment and agent templates")
  .option("--leader", "Initialize as Leader environment", false)
  .option("--name <name>", "Instance display name")
  .option("--role <role>", "Instance role (planner/builder/verifier/reviewer/accepter)")
  .option("--cache-dir <path>", "Shared cache directory (default: ~/.claude-orchestrator/sessions)")
  .option("--command <cmd>", "Claude CLI command (default: claude --dangerously-skip-permissions -v)")
  .option("--global", "Write config only to ~/.claude-orchestrator/", false)
  .action(async function (this: Command) {
    const { leader, name, role, cacheDir, command, global: isGlobal } = getSubOpts<{
      leader: boolean;
      name?: string;
      role?: string;
      cacheDir?: string;
      command?: string;
      global: boolean;
    }>(this);
    await cmdSetup({ leader, name, role, cacheDir, command, global: isGlobal, instanceId: undefined });
  });

// ── Message Commands ──

program
  .command("send-message")
  .description("Send a message to another instance or broadcast to all")
  .requiredOption("--content <text>", "Message content")
  .option("--to <id>", "Recipient instance ID")
  .option("--to-name <name>", "Recipient instance name (e.g. @Tom, @All)")
  .option("--broadcast", "Send to all instances", false)
  .option("--request-help", "Send as a help request", false)
  .option("--instance-id <id>", "Sender instance ID (default from project config)")
  .action(async function (this: Command) {
    try {
      const { content, to, toName, broadcast, requestHelp, instanceId } = getSubOpts<{
        content: string;
        to?: string;
        toName?: string;
        broadcast: boolean;
        requestHelp: boolean;
        instanceId?: string;
      }>(this);
      if (!to && !toName && !broadcast && !requestHelp) {
        throw new Error("Must specify --to, --to-name, --broadcast, or --request-help");
      }
      await cmdSendMessage(getZkHosts(this), instanceId, content, to, broadcast, toName, requestHelp);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("poll-message")
  .description("Check for new messages")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
    try {
      const { instanceId } = getSubOpts<{ instanceId?: string }>(this);
      await cmdPollMessage(getZkHosts(this), instanceId);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("delete-message")
  .description("Delete a message")
  .requiredOption("--message-id <id>", "Message ID to delete")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
    try {
      const { messageId, instanceId } = getSubOpts<{ messageId: string; instanceId?: string }>(this);
      await cmdDeleteMessage(getZkHosts(this), instanceId, messageId);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

// ── Task Commands ──

program
  .command("push-task")
  .description("Create and push a new task to the queue")
  .requiredOption("--title <title>", "Task title")
  .option("--description <text>", "Task description", "")
  .option("--priority <n>", "Priority: 0=HIGH, 1=MEDIUM, 2=LOW", "1")
  .option("--assignee <id>", "Target instance ID")
  .option("--link <link>", "Responsibility chain link: plan, build, verify, review, accept")
  .option("--chain-id <id>", "Chain identifier for grouping related tasks")
  .option("--depends-on <ids>", "Comma-separated task IDs this task depends on")
  .option("--blocked-by <ids>", "Comma-separated task IDs blocking this task")
  .option("--instance-id <id>", "Creator instance ID (default from project config)")
  .action(async function (this: Command) {
    try {
      const { title, description, priority, assignee, link, chainId, dependsOn, blockedBy, instanceId } = getSubOpts<{
        title: string;
        description: string;
        priority: string;
        assignee?: string;
        link?: string;
        chainId?: string;
        dependsOn?: string;
        blockedBy?: string;
        instanceId?: string;
      }>(this);
      const dependsOnArr = dependsOn ? dependsOn.split(",").map(s => s.trim()).filter(Boolean) : undefined;
      const blockedByArr = blockedBy ? blockedBy.split(",").map(s => s.trim()).filter(Boolean) : undefined;
      await cmdPushTask(getZkHosts(this), instanceId, title, description, parseInt(priority), assignee, link, chainId, dependsOnArr, blockedByArr);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("poll-task")
  .description("List tasks, optionally filtered by status")
  .option("--status <status>", "Filter: pending, claimed, completed, blocked, failed")
  .action(async function (this: Command) {
    try {
      const { status } = getSubOpts<{ status?: string }>(this);
      await cmdPollTask(getZkHosts(this), status);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("claim-task")
  .description("Claim the highest-priority pending task")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
    try {
      const { instanceId } = getSubOpts<{ instanceId?: string }>(this);
      await cmdClaimTask(getZkHosts(this), instanceId);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("complete-task")
  .description("Mark a claimed task as completed")
  .requiredOption("--task-id <id>", "Task ID to complete")
  .requiredOption("--result <text>", "Summary of what was accomplished")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
    try {
      const { taskId, result, instanceId } = getSubOpts<{ taskId: string; result: string; instanceId?: string }>(this);
      await cmdCompleteTask(getZkHosts(this), instanceId, taskId, result);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("task-block")
  .description("Mark a claimed task as blocked")
  .requiredOption("--task-id <id>", "Task ID")
  .requiredOption("--reason <text>", "Blocking reason")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
    try {
      const { taskId, reason, instanceId } = getSubOpts<{ taskId: string; reason: string; instanceId?: string }>(this);
      await cmdTaskBlock(getZkHosts(this), instanceId, taskId, reason);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("task-fail")
  .description("Mark a claimed task as failed")
  .requiredOption("--task-id <id>", "Task ID")
  .requiredOption("--reason <text>", "Failure reason")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
    try {
      const { taskId, reason, instanceId } = getSubOpts<{ taskId: string; reason: string; instanceId?: string }>(this);
      await cmdTaskFail(getZkHosts(this), instanceId, taskId, reason);
    } catch (e) {
      output({ error: String(e) }, true);
    }
  });

program
  .command("task-retry")
  .description("Re-queue a failed task for retry")
  .requiredOption("--task-id <id>", "Task ID to retry")
  .action(async function (this: Command) {
    try {
      const { taskId } = getSubOpts<{ taskId: string }>(this);
      await cmdTaskRetry(getZkHosts(this), undefined, taskId);
    } catch (e) {
      output({ error: String(e) }, true);
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
