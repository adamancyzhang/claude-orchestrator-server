#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, output } from "@co/infra";
import { PROTOCOL_VERSION } from "@co/contracts";
import { runOrchestrator } from "@co/orchestrator";

const program = new Command();

program
  .name("claude-orchestrator")
  .description("Multi-agent orchestration CLI backed by ZooKeeper")
  .version(`0.7.0 (protocol ${PROTOCOL_VERSION})`)
  .option("-z, --zookeeper <hosts>", "ZooKeeper connection string (env: ZK_HOSTS)")
  .option("-d, --debug", "Enable debug mode");

program
  .command("run")
  .description("One-shot orchestration: setup environment, start TUI, fork Workers")
  .option(
    "--worker <n>",
    "Number of Workers (must be >= 6)",
    (raw) => {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 6) {
        throw new Error("`--worker` must be an integer >= 6");
      }
      return n;
    },
    6,
  )
  .option(
    "--magic",
    "Enable autonomous loop (Explorer + spawn_chain). The 6th worker is " +
      "assigned the explorer role and the chain gains an explore link.",
  )
  .option(
    "--magic-max-chains <m>",
    "Hard cap on chain_forest depth (env: CO_MAGIC_MAX_CHAINS). Omit for unlimited.",
    (raw) => {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error("`--magic-max-chains` must be a positive integer");
      }
      return n;
    },
  )
  .option("-y, --yes", "Skip interactive prompts, auto-approve based on history")
  .option(
    "--enabled-zookeeper",
    "Use real ZooKeeper for message routing (default: in-memory)",
  )
  .action(async function (this: Command) {
    const opts = this.opts() as {
      worker: number;
      yes?: boolean;
      magic?: boolean;
      magicMaxChains?: number;
      enabledZookeeper?: boolean;
    };
    const debug = Boolean(this.optsWithGlobals().debug);
    const zk = (this.optsWithGlobals().zookeeper as string | undefined);
    await runOrchestrator({
      zk_hosts: zk ?? process.env.ZK_HOSTS ?? "127.0.0.1:2181",
      worker_count: opts.worker,
      debug,
      y_flag: Boolean(opts.yes),
      magic: Boolean(opts.magic),
      magic_max_chains: opts.magicMaxChains ?? null,
      enabled_zookeeper: Boolean(opts.enabledZookeeper),
    });
  });

program
  .command("config")
  .description("Show current configuration")
  .action(async function (this: Command) {
    const zk = (this.optsWithGlobals().zookeeper as string | undefined);
    const debug = Boolean(this.optsWithGlobals().debug);
    const config = loadConfig({ cli_zookeeper: zk, cli_debug: debug });
    output({
      protocol_version: PROTOCOL_VERSION,
      zookeeper: config.zk,
      projects_root: config.projects_root,
      commands: config.commands,
      hooks: config.hooks,
      project: {
        name: config.name ?? "(not set)",
        role: config.role ?? "(not set)",
        instance_id: config.instance_id ?? "(not set)",
      },
    });
  });

program.parseAsync().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
