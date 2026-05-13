#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, loadInstanceConfig } from "./config.js";
import { Logger } from "./utils/logger.js";
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

// ── Main entry ──

async function main() {
  program.parse();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
