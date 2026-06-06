#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, output } from "@co/infra";
import { PROTOCOL_VERSION } from "@co/contracts";
import { runOrchestrator } from "@co/orchestrator";
import { readState, getStateDir, type StateData } from "./state-utils.js";

const program = new Command();

function parseIntOption(min: number, label: string) {
  return (raw: string) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min) {
      throw new Error(`\`--${label}\` must be an integer >= ${min}`);
    }
    return n;
  };
}

program
  .name("claude-orchestrator")
  .description("Multi-agent orchestration CLI (in-memory or ZooKeeper)")
  .version(`0.7.0 (protocol ${PROTOCOL_VERSION})`)
  .option("-z, --zookeeper <hosts>", "ZooKeeper connection string (env: ZK_HOSTS)")
  .option("-d, --debug", "Enable debug mode")
  .option("--state-dir <dir>", "State directory path (default: .claude-orchestrator/state)");

program
  .command("run")
  .description("One-shot orchestration: setup environment, start TUI, fork Workers")
  .option(
    "--worker <n>",
    "Number of Workers (must be >= 6)",
    parseIntOption(6, "worker"),
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
    parseIntOption(1, "magic-max-chains"),
  )
  .option("-y, --yes", "Skip interactive prompts, auto-approve based on history")
  .option(
    "--enabled-zookeeper",
    "Use real ZooKeeper for message routing (default: in-memory)",
  )
  .option(
    "--headless",
    "Run without TUI — serialize state to state.json for CLI inspection",
  )
  .action(async function (this: Command) {
    const opts = this.opts() as {
      worker: number;
      yes?: boolean;
      magic?: boolean;
      magicMaxChains?: number;
      enabledZookeeper?: boolean;
      headless?: boolean;
    };
    const debug = Boolean(this.optsWithGlobals().debug);
    const zk = (this.optsWithGlobals().zookeeper as string | undefined);
    const stateDir = this.optsWithGlobals().stateDir as string | undefined;
    await runOrchestrator({
      zk_hosts: zk ?? process.env.ZK_HOSTS ?? "127.0.0.1:2181",
      worker_count: opts.worker,
      debug,
      y_flag: Boolean(opts.yes),
      magic: Boolean(opts.magic),
      magic_max_chains: opts.magicMaxChains ?? null,
      enabled_zookeeper: Boolean(opts.enabledZookeeper),
      headless: Boolean(opts.headless),
      state_dir: stateDir,
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

// --- State inspection commands ---

program
  .command("send <message>")
  .description("Send a message to the orchestrator (headless mode)")
  .action(async function (this: Command, message: string) {
    const stateDir = getStateDir(this.optsWithGlobals());
    const commandsPath = path.join(stateDir, "commands.jsonl");
    const command = {
      type: "send",
      content: message,
      timestamp: new Date().toISOString(),
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(commandsPath, JSON.stringify(command) + "\n");
    console.log("Command sent.");
  });

program
  .command("status")
  .description("Display full orchestrator state")
  .action(async function (this: Command) {
    const stateDir = getStateDir(this.optsWithGlobals());
    const state = readState(stateDir);
    output(state);
  });

program
  .command("workers")
  .description("Display workers table")
  .action(async function (this: Command) {
    const stateDir = getStateDir(this.optsWithGlobals());
    const state = readState(stateDir);
    if (state.workers.length === 0) {
      console.log("No workers connected.");
      return;
    }
    console.table(
      state.workers.map((w) => ({
        ID: w.id,
        Name: w.name,
        Status: w.status,
        Task: w.current_task_id ?? "-",
        Role: w.current_role ?? "-",
        Worktree: w.worktree_name ?? "-",
      })),
    );
  });

program
  .command("tasks")
  .description("Display pending and in-progress tasks")
  .action(async function (this: Command) {
    const stateDir = getStateDir(this.optsWithGlobals());
    const state = readState(stateDir);
    const all = [
      ...state.pending_tasks.map((t) => ({ ...t, queue: "pending" })),
      ...state.in_progress_tasks.map((t) => ({ ...t, queue: "in_progress" })),
    ];
    if (all.length === 0) {
      console.log("No tasks.");
      return;
    }
    console.table(
      all.map((t) => ({
        ID: t.id,
        Queue: t.queue,
        Status: t.status,
        Link: t.link ?? "-",
        ClaimedBy: "claimed_by" in t ? (t.claimed_by ?? "-") : "-",
        Description: t.description.slice(0, 80),
      })),
    );
  });

program
  .command("events")
  .description("Display event log")
  .option("--tail <n>", "Number of recent events to show", "20")
  .action(async function (this: Command) {
    const stateDir = getStateDir(this.optsWithGlobals());
    const state = readState(stateDir);
    const tail = parseInt(this.opts().tail, 10);
    if (!Number.isFinite(tail) || tail < 1) {
      console.error("--tail must be a positive integer");
      process.exit(1);
    }
    const events = state.events.slice(-tail);
    if (events.length === 0) {
      console.log("No events.");
      return;
    }
    for (const e of events) {
      const ts = e.timestamp ? `[${e.timestamp}]` : "";
      const detail = JSON.stringify(e);
      console.log(`${ts} ${detail}`);
    }
  });

program
  .command("chains")
  .description("Display active and completed chains")
  .action(async function (this: Command) {
    const stateDir = getStateDir(this.optsWithGlobals());
    const state = readState(stateDir);

    // Extract chain info from events.
    const activated = new Map<string, string>(); // chain_id → timestamp
    const closed = new Set<string>();
    const spawned = new Map<string, { parent: string; depth: number }>();
    const mergeFailed = new Set<string>();

    for (const e of state.events) {
      if (e.type === "chain_activated") {
        activated.set(e.chain_id as string, e.timestamp as string);
      } else if (e.type === "chain_closed") {
        closed.add(e.chain_id as string);
      } else if (e.type === "chain_spawned") {
        spawned.set(e.child_chain_id as string, {
          parent: e.parent_chain_id as string,
          depth: e.chain_depth as number,
        });
      } else if (e.type === "chain_merge_failed") {
        mergeFailed.add(e.chain_id as string);
      }
    }

    // Collect all chain_ids from tasks.
    const allTasks = [...state.pending_tasks, ...state.in_progress_tasks];
    const chainIds = new Set<string>(activated.keys());
    for (const t of allTasks) {
      if (t.chain_id) chainIds.add(t.chain_id);
    }

    if (chainIds.size === 0) {
      console.log("No chains.");
      return;
    }

    const rows = Array.from(chainIds).map((cid) => {
      const isActive = activated.has(cid) && !closed.has(cid);
      const tasks = allTasks.filter((t) => t.chain_id === cid);
      const currentLink = tasks.find((t) => t.status === "in_progress")?.link ?? "-";
      const workers = tasks
        .filter((t) => t.assigned_to_name)
        .map((t) => t.assigned_to_name)
        .filter(Boolean);
      const uniqueWorkers = [...new Set(workers)];
      const spawnInfo = spawned.get(cid);

      return {
        ChainID: cid,
        Status: mergeFailed.has(cid)
          ? "merge_failed"
          : isActive
            ? "active"
            : "closed",
        SpawnedFrom: spawnInfo?.parent ?? "-",
        Depth: spawnInfo?.depth ?? "-",
        CurrentLink: currentLink,
        Workers: uniqueWorkers.length > 0 ? uniqueWorkers.join(", ") : "-",
        Tasks: tasks.length,
      };
    });

    console.table(rows);
  });

program
  .command("messages <worker>")
  .description("Display message history for a worker")
  .action(async function (this: Command, workerId: string) {
    const stateDir = getStateDir(this.optsWithGlobals());
    const state = readState(stateDir);
    const worker = state.workers.find((w) => w.id === workerId);
    if (!worker) {
      console.error(`Worker not found: ${workerId}`);
      process.exit(1);
    }
    if (worker.message_history.length === 0) {
      console.log(`No messages for worker ${workerId}.`);
      return;
    }
    for (const m of worker.message_history) {
      console.log(`[${m.timestamp}] ${m.content}`);
    }
  });

program
  .command("wait")
  .description("Poll state.json until a condition is met")
  .option("--task <id>", "Wait for task to complete")
  .option("--chain <id>", "Wait for chain to close")
  .option("--timeout <s>", "Timeout in seconds", "30")
  .action(async function (this: Command) {
    const stateDir = getStateDir(this.optsWithGlobals());
    const opts = this.opts() as { task?: string; chain?: string; timeout?: string };
    const timeoutMs = (parseInt(opts.timeout ?? "30", 10)) * 1000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const state = readState(stateDir);

        if (opts.task) {
          const found = state.in_progress_tasks.find((t) => t.id === opts.task);
          if (!found) {
            console.log(`Task ${opts.task} completed or not found.`);
            return;
          }
        }

        if (opts.chain) {
          const chainEvent = state.events.find(
            (e) => e.type === "chain_closed" && e.chain_id === opts.chain,
          );
          if (chainEvent) {
            console.log(`Chain ${opts.chain} closed.`);
            return;
          }
        }

        if (!opts.task && !opts.chain) {
          console.log("Specify --task or --chain to wait for.");
          return;
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("State file not found")) {
          // State file may not exist yet, continue polling
        } else {
          throw err;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.error("Timeout waiting for condition.");
    process.exit(1);
  });

program.parseAsync().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
