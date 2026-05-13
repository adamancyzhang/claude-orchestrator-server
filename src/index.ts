#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, loadInstanceConfig } from "./config.js";
import { Logger } from "./utils/logger.js";
import {
  cmdPushTask,
  cmdClaimTask,
  cmdCompleteTask,
  cmdPollTask,
  cmdSendMessage,
  cmdPollMessage,
  cmdDeleteMessage,
  cmdUnregister,
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
  )
  .option("-d, --debug", "Enable debug mode (trace prompts and execution details)");

function getZkHosts(cmd: Command): string {
  return cmd.optsWithGlobals().zookeeper || "127.0.0.1:2181";
}

function getDebug(cmd: Command): boolean {
  return !!cmd.optsWithGlobals().debug;
}

// ── Commands ──

// ── Control Commands ──

program
  .command("run")
  .description("One-shot orchestration: setup environment, start TUI, register Workers")
  .requiredOption("--worker <n>", "Number of Workers", parseInt)
  .option("-y, --yes", "Skip interactive prompts, auto-approve based on history")
  .action(async function (this: Command) {
    const { worker, yes } = this.opts() as { worker: number; yes?: boolean };
    const debug = getDebug(this);
    if (debug) Logger.enableDebug();
    const config = loadConfig({ zookeeper: getZkHosts(this) });
    const { runOrchestrator } = await import("./orchestrator/run.js");
    await runOrchestrator({
      zkHosts: config.zk.url,
      workerCount: worker,
      name: undefined,
      debug,
      yFlag: !!yes,
    });
  });

program
  .command("unregister")
  .description("Explicitly unregister an instance")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
      const { instanceId } = this.opts() as { instanceId?: string };
      await cmdUnregister(getZkHosts(this), instanceId);
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
        hooks: config.hooks,
      },
      project: {
        name: projectConfig.name || "(not set)",
        role: projectConfig.role || "(not set)",
        instance_id: projectConfig.instance_id || "(not set)",
      },
    });
  });

// ── Message Commands ──

program
  .command("send-message")
  .description("Send a message to the leader instance")
  .requiredOption("--content <text>", "Message content")
  .option("--instance-id <id>", "Sender instance ID (default from project config)")
  .action(async function (this: Command) {
      const { content, instanceId } = this.opts() as {
        content: string;
        instanceId?: string;
      };
      await cmdSendMessage(getZkHosts(this), instanceId, content);
  });

program
  .command("poll-message")
  .description("Check for new messages")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
      const { instanceId } = this.opts() as { instanceId?: string };
      await cmdPollMessage(getZkHosts(this), instanceId);
  });

program
  .command("delete-message")
  .description("Delete a message")
  .requiredOption("--message-id <id>", "Message ID to delete")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
      const { messageId, instanceId } = this.opts() as { messageId: string; instanceId?: string };
      await cmdDeleteMessage(getZkHosts(this), instanceId, messageId);
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
      const { title, description, priority, assignee, link, chainId, dependsOn, blockedBy, instanceId } = this.opts() as {
        title: string;
        description: string;
        priority: string;
        assignee?: string;
        link?: string;
        chainId?: string;
        dependsOn?: string;
        blockedBy?: string;
        instanceId?: string;
      };
      const dependsOnArr = dependsOn ? dependsOn.split(",").map(s => s.trim()).filter(Boolean) : undefined;
      const blockedByArr = blockedBy ? blockedBy.split(",").map(s => s.trim()).filter(Boolean) : undefined;
      await cmdPushTask(getZkHosts(this), instanceId, title, description, parseInt(priority), assignee, link, chainId, dependsOnArr, blockedByArr);
  });

program
  .command("poll-task")
  .description("List tasks, optionally filtered by status")
  .option("--status <status>", "Filter: pending, claimed, completed, blocked, failed")
  .action(async function (this: Command) {
      const { status } = this.opts() as { status?: string };
      await cmdPollTask(getZkHosts(this), status);
  });

program
  .command("claim-task")
  .description("Claim the highest-priority pending task")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
      const { instanceId } = this.opts() as { instanceId?: string };
      await cmdClaimTask(getZkHosts(this), instanceId);
  });

program
  .command("complete-task")
  .description("Mark a claimed task as completed")
  .requiredOption("--task-id <id>", "Task ID to complete")
  .requiredOption("--result <text>", "Summary of what was accomplished")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
      const { taskId, result, instanceId } = this.opts() as { taskId: string; result: string; instanceId?: string };
      await cmdCompleteTask(getZkHosts(this), instanceId, taskId, result);
  });

program
  .command("task-block")
  .description("Mark a claimed task as blocked")
  .requiredOption("--task-id <id>", "Task ID")
  .requiredOption("--reason <text>", "Blocking reason")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
      const { taskId, reason, instanceId } = this.opts() as { taskId: string; reason: string; instanceId?: string };
      await cmdTaskBlock(getZkHosts(this), instanceId, taskId, reason);
  });

program
  .command("task-fail")
  .description("Mark a claimed task as failed")
  .requiredOption("--task-id <id>", "Task ID")
  .requiredOption("--reason <text>", "Failure reason")
  .option("--instance-id <id>", "Instance ID (default from project config)")
  .action(async function (this: Command) {
      const { taskId, reason, instanceId } = this.opts() as { taskId: string; reason: string; instanceId?: string };
      await cmdTaskFail(getZkHosts(this), instanceId, taskId, reason);
  });

program
  .command("task-retry")
  .description("Re-queue a failed task for retry")
  .requiredOption("--task-id <id>", "Task ID to retry")
  .action(async function (this: Command) {
      const { taskId } = this.opts() as { taskId: string };
      await cmdTaskRetry(getZkHosts(this), undefined, taskId);
  });

// ── Main entry ──

async function main() {
  program.parse();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
