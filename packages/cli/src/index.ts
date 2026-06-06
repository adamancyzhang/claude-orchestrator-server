#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, output } from "@co/infra";
import { PROTOCOL_VERSION } from "@co/contracts";
import { runOrchestrator } from "@co/orchestrator";
import { readState, getStateDir, type StateData } from "./state-utils.js";
import { jsonOutput, jsonError } from "./json-output.js";
import { createProgress } from "./progress.js";
import { runInteractiveInit, displayNextSteps } from "./interactive-init.js";

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

function outputResult(data: unknown, jsonMode: boolean, error = false): void {
  if (jsonMode) {
    const result = error ? jsonError("ERROR", String(data)) : jsonOutput(data);
    console.log(JSON.stringify(result, null, 2));
    if (error) {
      process.exit(1);
    }
  } else {
    output(data, error);
  }
}

function outputError(jsonMode: boolean, code: string, message: string): void {
  if (jsonMode) {
    console.log(JSON.stringify(jsonError(code, message), null, 2));
    process.exit(1);
  } else {
    console.error(message);
    process.exit(1);
  }
}

program
  .name("claude-orchestrator")
  .description(`Multi-agent orchestration CLI for Claude
A multi-agent orchestration system that coordinates multiple Claude instances
to work on complex tasks through a pipeline of planning, execution, verification,
and review stages.

Quick Start:
  $ claude-orchestrator init          # Set up configuration
  $ claude-orchestrator run           # Start orchestration
  $ claude-orchestrator status        # Check orchestrator state

For more information, visit: https://github.com/adamancyzhang/claude-orchestrator-server`)
  .version(`0.7.0 (protocol ${PROTOCOL_VERSION})`)
  .option("-z, --zookeeper <hosts>", "ZooKeeper connection string (env: ZK_HOSTS). Use 'in-memory' for local testing without ZooKeeper.")
  .option("-d, --debug", "Enable debug mode with verbose logging output")
  .option("--state-dir <dir>", "State directory path (default: .claude-orchestrator/state). Stores orchestrator state, commands, and task history.")
  .option("--json", "Output in JSON format for machine-readable responses. All commands support this flag.");

program
  .command("run")
  .description(`Start a one-shot orchestration session
Sets up the environment, starts the terminal UI (TUI), and forks worker
processes to handle tasks through the pipeline. Workers automatically
claim tasks, execute them, and report results back to the leader.

The orchestration pipeline follows this flow:
  Plan → Execute → Verify → Review → Accept

Each stage is handled by a specialized worker role. The leader coordinates
the flow and ensures tasks move through the pipeline correctly.

Examples:
  $ claude-orchestrator run                          # Start with defaults
  $ claude-orchestrator run --worker 8               # Use 8 workers
  $ claude-orchestrator run --magic                  # Enable autonomous mode
  $ claude-orchestrator run --headless               # Run without TUI
  $ claude-orchestrator run -y                       # Skip prompts`)
  .option(
    "--worker <n>",
    "Number of Workers to spawn (must be >= 6). Each worker handles a specific role in the pipeline.",
    parseIntOption(6, "worker"),
    6,
  )
  .option(
    "--magic",
    "Enable autonomous loop mode with Explorer role. The 6th worker becomes an Explorer that can spawn new chains for parallel task execution.",
  )
  .option(
    "--magic-max-chains <m>",
    "Hard cap on chain_forest depth (env: CO_MAGIC_MAX_CHAINS). Limits how many nested chains can be spawned. Omit for unlimited depth.",
    parseIntOption(1, "magic-max-chains"),
  )
  .option("-y, --yes", "Skip interactive prompts and auto-approve based on history. Useful for automated pipelines.")
  .option(
    "--enabled-zookeeper",
    "Use real ZooKeeper for message routing (default: in-memory). Required for multi-machine deployments.",
  )
  .option(
    "--headless",
    "Run without TUI — serialize state to state.json for CLI inspection. Ideal for background execution and CI/CD pipelines.",
  )
  .option(
    "--no-progress",
    "Disable progress indicator. Useful when piping output or in CI environments.",
  )
  .action(async function (this: Command) {
    const opts = this.opts() as {
      worker: number;
      yes?: boolean;
      magic?: boolean;
      magicMaxChains?: number;
      enabledZookeeper?: boolean;
      headless?: boolean;
      progress?: boolean;
    };
    const globalOpts = this.optsWithGlobals();
    const debug = Boolean(globalOpts.debug);
    const zk = (globalOpts.zookeeper as string | undefined);
    const stateDir = globalOpts.stateDir as string | undefined;
    const jsonMode = Boolean(globalOpts.json);
    const progressDisabled = jsonMode || opts.progress === false;

    const progress = createProgress("Starting orchestrator...", progressDisabled);
    progress.start();

    try {
      progress.updateMessage("Initializing orchestrator...");
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
      progress.stop("Orchestration completed");
      if (jsonMode) {
        outputResult({ message: "Orchestration completed" }, jsonMode);
      }
    } catch (err) {
      progress.stop("Orchestration failed");
      outputError(jsonMode, "RUN_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("config")
  .description(`Display current configuration settings
Shows the active configuration including ZooKeeper connection, project
settings, and command aliases. Useful for debugging configuration issues
and verifying settings before starting orchestration.

Examples:
  $ claude-orchestrator config            # Show config in human-readable format
  $ claude-orchestrator config --json     # Show config as JSON`)
  .action(async function (this: Command) {
    const globalOpts = this.optsWithGlobals();
    const zk = (globalOpts.zookeeper as string | undefined);
    const debug = Boolean(globalOpts.debug);
    const jsonMode = Boolean(globalOpts.json);
    const config = loadConfig({ cli_zookeeper: zk, cli_debug: debug });
    const data = {
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
    };
    outputResult(data, jsonMode);
  });

program
  .command("init")
  .description(`Initialize configuration with interactive wizard
Guides you through setting up the orchestrator configuration including:
  - Project name and description
  - ZooKeeper connection settings
  - Worker roles and counts
  - Git repository settings
  - Hook scripts for task lifecycle events

The wizard creates a .claude-orchestrator/config.yaml file in your project.

Examples:
  $ claude-orchestrator init              # Interactive setup
  $ claude-orchestrator init --defaults   # Use all default values`)
  .option("--defaults", "Use default values without prompting. Quick setup for testing.")
  .action(async function (this: Command) {
    const opts = this.opts() as { defaults?: boolean };
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);

    try {
      const result = await runInteractiveInit({
        defaults: Boolean(opts.defaults),
        cwd: process.cwd(),
      });

      if (jsonMode) {
        outputResult({
          success: result.success,
          config_path: result.config_path,
          message: result.message,
        }, jsonMode);
      } else if (result.success && result.config_path) {
        displayNextSteps(result.config_path);
      }
    } catch (err) {
      outputError(jsonMode, "INIT_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

// --- State inspection commands ---

program
  .command("send <message>")
  .description(`Send a message to the orchestrator in headless mode
Appends a command to the commands.jsonl file that the orchestrator monitors.
Only works when the orchestrator is running in headless mode (--headless flag).

Messages are processed in order and can include task requests, status queries,
or control commands.

Examples:
  $ claude-orchestrator send "Fix the authentication bug"
  $ claude-orchestrator send "Show me the current tasks"
  $ claude-orchestrator send --json "Status check"`)
  .action(async function (this: Command, message: string) {
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);
    try {
      const stateDir = getStateDir(globalOpts);
      const commandsPath = path.join(stateDir, "commands.jsonl");
      const command = {
        type: "send",
        content: message,
        timestamp: new Date().toISOString(),
      };
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(commandsPath, JSON.stringify(command) + "\n");
      outputResult({ message: "Command sent" }, jsonMode);
    } catch (err) {
      outputError(jsonMode, "SEND_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("status")
  .description(`Display full orchestrator state
Shows comprehensive information about the running orchestrator including:
  - Connected workers and their status
  - Pending and in-progress tasks
  - Recent events and activity
  - Chain execution status

This is the primary command for monitoring orchestrator health and progress.

Examples:
  $ claude-orchestrator status            # Show state in human-readable format
  $ claude-orchestrator status --json     # Show state as JSON for scripting`)
  .action(async function (this: Command) {
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);
    try {
      const stateDir = getStateDir(globalOpts);
      const state = readState(stateDir);
      outputResult(state, jsonMode);
    } catch (err) {
      outputError(jsonMode, "STATUS_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("workers")
  .description(`Display connected workers
Shows a table of all connected worker instances with their:
  - Worker ID and name
  - Current status (idle/busy)
  - Assigned task (if any)
  - Worker role (planner, executor, verifier, etc.)
  - Worktree name

Useful for monitoring worker health and task distribution.

Examples:
  $ claude-orchestrator workers           # Show workers table
  $ claude-orchestrator workers --json    # Show workers as JSON`)
  .action(async function (this: Command) {
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);
    try {
      const stateDir = getStateDir(globalOpts);
      const state = readState(stateDir);
      if (state.workers.length === 0) {
        if (jsonMode) {
          outputResult({ workers: [], message: "No workers connected" }, jsonMode);
        } else {
          console.log("No workers connected.");
        }
        return;
      }
      const workers = state.workers.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        current_task_id: w.current_task_id,
        current_role: w.current_role,
        worktree_name: w.worktree_name,
      }));
      if (jsonMode) {
        outputResult({ workers }, jsonMode);
      } else {
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
      }
    } catch (err) {
      outputError(jsonMode, "WORKERS_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("tasks")
  .description(`Display pending and in-progress tasks
Shows all tasks in the system, organized by queue:
  - Pending: Tasks waiting to be claimed by workers
  - In Progress: Tasks currently being executed

Each task shows its ID, status, link type, and description.
Useful for tracking pipeline progress and identifying bottlenecks.

Examples:
  $ claude-orchestrator tasks             # Show tasks table
  $ claude-orchestrator tasks --json      # Show tasks as JSON`)
  .action(async function (this: Command) {
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);
    try {
      const stateDir = getStateDir(globalOpts);
      const state = readState(stateDir);
      const all = [
        ...state.pending_tasks.map((t) => ({ ...t, queue: "pending" })),
        ...state.in_progress_tasks.map((t) => ({ ...t, queue: "in_progress" })),
      ];
      if (all.length === 0) {
        if (jsonMode) {
          outputResult({ tasks: [], message: "No tasks" }, jsonMode);
        } else {
          console.log("No tasks.");
        }
        return;
      }
      const tasks = all.map((t) => ({
        id: t.id,
        queue: t.queue,
        status: t.status,
        link: t.link,
        claimed_by: "claimed_by" in t ? t.claimed_by : null,
        description: t.description,
      }));
      if (jsonMode) {
        outputResult({ tasks }, jsonMode);
      } else {
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
      }
    } catch (err) {
      outputError(jsonMode, "TASKS_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("events")
  .description(`Display event log
Shows recent orchestrator events including:
  - Worker join/leave events
  - Task lifecycle events (created, claimed, completed, failed)
  - Chain activation and completion
  - Message routing events

Events are displayed in chronological order with timestamps.
Useful for debugging and understanding orchestrator behavior.

Examples:
  $ claude-orchestrator events            # Show last 20 events
  $ claude-orchestrator events --tail 50  # Show last 50 events
  $ claude-orchestrator events --json     # Show events as JSON`)
  .option("--tail <n>", "Number of recent events to show (default: 20)", "20")
  .action(async function (this: Command) {
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);
    try {
      const stateDir = getStateDir(globalOpts);
      const state = readState(stateDir);
      const tail = parseInt(this.opts().tail, 10);
      if (!Number.isFinite(tail) || tail < 1) {
        outputError(jsonMode, "INVALID_TAIL", "--tail must be a positive integer");
      }
      const events = state.events.slice(-tail);
      if (events.length === 0) {
        if (jsonMode) {
          outputResult({ events: [], message: "No events" }, jsonMode);
        } else {
          console.log("No events.");
        }
        return;
      }
      if (jsonMode) {
        outputResult({ events }, jsonMode);
      } else {
        for (const e of events) {
          const ts = e.timestamp ? `[${e.timestamp}]` : "";
          const detail = JSON.stringify(e);
          console.log(`${ts} ${detail}`);
        }
      }
    } catch (err) {
      outputError(jsonMode, "EVENTS_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("chains")
  .description(`Display active and completed chains
Shows all task chains (pipelines) and their current status:
  - Active chains currently being processed
  - Completed chains that have finished
  - Failed chains with merge conflicts

Each chain shows its ID, status, current stage, assigned workers,
and task count. Chains represent the full lifecycle of a complex task
that passes through multiple pipeline stages.

Examples:
  $ claude-orchestrator chains            # Show chains table
  $ claude-orchestrator chains --json     # Show chains as JSON`)
  .action(async function (this: Command) {
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);
    try {
      const stateDir = getStateDir(globalOpts);
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
        if (jsonMode) {
          outputResult({ chains: [], message: "No chains" }, jsonMode);
        } else {
          console.log("No chains.");
        }
        return;
      }

      const chains = Array.from(chainIds).map((cid) => {
        const isActive = activated.has(cid) && !closed.has(cid);
        const tasks = allTasks.filter((t) => t.chain_id === cid);
        const currentLink = tasks.find((t) => t.status === "in_progress")?.link ?? null;
        const workers = tasks
          .filter((t) => t.assigned_to_name)
          .map((t) => t.assigned_to_name)
          .filter(Boolean);
        const uniqueWorkers = [...new Set(workers)];
        const spawnInfo = spawned.get(cid);

        return {
          chain_id: cid,
          status: mergeFailed.has(cid)
            ? "merge_failed"
            : isActive
              ? "active"
              : "closed",
          spawned_from: spawnInfo?.parent ?? null,
          depth: spawnInfo?.depth ?? null,
          current_link: currentLink,
          workers: uniqueWorkers,
          task_count: tasks.length,
        };
      });

      if (jsonMode) {
        outputResult({ chains }, jsonMode);
      } else {
        console.table(
          chains.map((c) => ({
            ChainID: c.chain_id,
            Status: c.status,
            SpawnedFrom: c.spawned_from ?? "-",
            Depth: c.depth ?? "-",
            CurrentLink: c.current_link ?? "-",
            Workers: c.workers.length > 0 ? c.workers.join(", ") : "-",
            Tasks: c.task_count,
          })),
        );
      }
    } catch (err) {
      outputError(jsonMode, "CHAINS_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("messages <worker>")
  .description(`Display message history for a specific worker
Shows the message history for the specified worker ID. Messages include
task assignments, status updates, and completion reports.

Use the 'workers' command to see available worker IDs.

Examples:
  $ claude-orchestrator messages worker-1       # Show messages for worker-1
  $ claude-orchestrator messages worker-1 --json # Show messages as JSON`)
  .action(async function (this: Command, workerId: string) {
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);
    try {
      const stateDir = getStateDir(globalOpts);
      const state = readState(stateDir);
      const worker = state.workers.find((w) => w.id === workerId);
      if (!worker) {
        outputError(jsonMode, "WORKER_NOT_FOUND", `Worker not found: ${workerId}`);
      }
      if (worker.message_history.length === 0) {
        if (jsonMode) {
          outputResult({ messages: [], worker_id: workerId, message: `No messages for worker ${workerId}` }, jsonMode);
        } else {
          console.log(`No messages for worker ${workerId}.`);
        }
        return;
      }
      if (jsonMode) {
        outputResult({ messages: worker.message_history, worker_id: workerId }, jsonMode);
      } else {
        for (const m of worker.message_history) {
          console.log(`[${m.timestamp}] ${m.content}`);
        }
      }
    } catch (err) {
      outputError(jsonMode, "MESSAGES_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("wait")
  .description(`Poll state.json until a condition is met
Waits for a specific task to complete or a chain to close. Useful for
scripting and automation where you need to wait for orchestration to
finish before proceeding.

The command polls the state file every second until the condition is
met or the timeout is reached.

Examples:
  $ claude-orchestrator wait --task task-123           # Wait for task to complete
  $ claude-orchestrator wait --chain chain-456         # Wait for chain to close
  $ claude-orchestrator wait --task task-123 --timeout 60  # Wait with 60s timeout`)
  .option("--task <id>", "Wait for the specified task to complete or be removed from in_progress")
  .option("--chain <id>", "Wait for the specified chain to emit a chain_closed event")
  .option("--timeout <s>", "Timeout in seconds (default: 30)", "30")
  .action(async function (this: Command) {
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);
    const stateDir = getStateDir(globalOpts);
    const opts = this.opts() as { task?: string; chain?: string; timeout?: string };
    const timeoutMs = (parseInt(opts.timeout ?? "30", 10)) * 1000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const state = readState(stateDir);

        if (opts.task) {
          const found = state.in_progress_tasks.find((t) => t.id === opts.task);
          if (!found) {
            if (jsonMode) {
              outputResult({ task_id: opts.task, status: "completed", message: `Task ${opts.task} completed or not found` }, jsonMode);
            } else {
              console.log(`Task ${opts.task} completed or not found.`);
            }
            return;
          }
        }

        if (opts.chain) {
          const chainEvent = state.events.find(
            (e) => e.type === "chain_closed" && e.chain_id === opts.chain,
          );
          if (chainEvent) {
            if (jsonMode) {
              outputResult({ chain_id: opts.chain, status: "closed", message: `Chain ${opts.chain} closed` }, jsonMode);
            } else {
              console.log(`Chain ${opts.chain} closed.`);
            }
            return;
          }
        }

        if (!opts.task && !opts.chain) {
          outputError(jsonMode, "INVALID_ARGS", "Specify --task or --chain to wait for.");
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
    outputError(jsonMode, "TIMEOUT", "Timeout waiting for condition.");
  });

// --- Shell completion ---

program
  .command("completion")
  .description(`Generate shell completion scripts
Creates tab-completion scripts for bash, zsh, or fish shells. These scripts
enable automatic command and option completion when pressing Tab.

Use the --install flag to automatically install the script to the
appropriate location for your shell.

Examples:
  $ claude-orchestrator completion bash           # Output bash completion script
  $ claude-orchestrator completion zsh            # Output zsh completion script
  $ claude-orchestrator completion fish           # Output fish completion script
  $ claude-orchestrator completion bash --install # Install bash completion`)
  .argument("[shell]", "Shell type: bash, zsh, or fish (default: bash)", "bash")
  .option("--install", "Install completion script automatically to the appropriate directory")
  .action(async function (this: Command, shell: string) {
    const globalOpts = this.optsWithGlobals();
    const jsonMode = Boolean(globalOpts.json);
    const opts = this.opts() as { install?: boolean };

    const validShells = ["bash", "zsh", "fish"];
    if (!validShells.includes(shell)) {
      outputError(jsonMode, "INVALID_SHELL", `Invalid shell type: ${shell}. Must be one of: ${validShells.join(", ")}`);
    }

    const script = generateCompletionScript(shell);

    if (opts.install) {
      try {
        const installPath = getCompletionInstallPath(shell);
        const dir = path.dirname(installPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(installPath, script, "utf-8");
        outputResult({
          message: `Completion script installed to ${installPath}`,
          shell,
          install_path: installPath,
          instructions: getCompletionInstructions(shell),
        }, jsonMode);
      } catch (err) {
        outputError(jsonMode, "INSTALL_FAILED", `Failed to install completion script: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      outputResult({ shell, script }, jsonMode);
    }
  });

function generateCompletionScript(shell: string): string {
  const commandName = "claude-orchestrator";

  switch (shell) {
    case "bash":
      return `#!/bin/bash
# Bash completion for ${commandName}
_${commandName.replace(/-/g, "_")}_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="run config send status workers tasks events chains messages wait completion"

  if [[ \${cur} == -* ]] ; then
    COMPREPLY=( $(compgen -W "--worker --magic --magic-max-chains --yes --enabled-zookeeper --headless --no-progress --json --zookeeper --debug --state-dir --help --version" -- \${cur}) )
    return 0
  fi

  if [[ \${COMP_CWORD} -eq 1 ]] ; then
    COMPREPLY=( $(compgen -W "\${commands}" -- \${cur}) )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish --install" -- \${cur}) )
      ;;
    events)
      COMPREPLY=( $(compgen -W "--tail" -- \${cur}) )
      ;;
    wait)
      COMPREPLY=( $(compgen -W "--task --chain --timeout" -- \${cur}) )
      ;;
  esac

  return 0
}
complete -F _${commandName.replace(/-/g, "_")}_completions ${commandName}
`;

    case "zsh":
      return `#compdef ${commandName}

# Zsh completion for ${commandName}
_${commandName.replace(/-/g, "_")}_completions() {
  local -a commands
  commands=(
    'run:One-shot orchestration: setup environment, start TUI, fork Workers'
    'config:Show current configuration'
    'send:Send a message to the orchestrator (headless mode)'
    'status:Display full orchestrator state'
    'workers:Display workers table'
    'tasks:Display pending and in-progress tasks'
    'events:Display event log'
    'chains:Display active and completed chains'
    'messages:Display message history for a worker'
    'wait:Poll state.json until a condition is met'
    'completion:Generate shell completion scripts'
  )

  _arguments -C \\
    '--worker[Number of Workers (must be >= 6)]:number' \\
    '--magic[Enable autonomous loop]' \\
    '--magic-max-chains[Hard cap on chain_forest depth]:number' \\
    '-y[Skip interactive prompts]' \\
    '--yes[Skip interactive prompts]' \\
    '--enabled-zookeeper[Use real ZooKeeper for message routing]' \\
    '--headless[Run without TUI]' \\
    '--no-progress[Disable progress indicator]' \\
    '--json[Output in JSON format]' \\
    '-z[ZooKeeper connection string]:hosts' \\
    '--zookeeper[ZooKeeper connection string]:hosts' \\
    '-d[Enable debug mode]' \\
    '--debug[Enable debug mode]' \\
    '--state-dir[State directory path]:dir' \\
    '1:command:->commands' \\
    '*::arg:->args' && return

  case $state in
    commands)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        completion)
          _arguments \\
            '1:shell:(bash zsh fish)' \\
            '--install[Install completion script automatically]'
          ;;
        events)
          _arguments '--tail[Number of recent events to show]:number'
          ;;
        wait)
          _arguments \\
            '--task[Wait for task to complete]:task id' \\
            '--chain[Wait for chain to close]:chain id' \\
            '--timeout[Timeout in seconds]:seconds'
          ;;
      esac
      ;;
  esac
}

_${commandName.replace(/-/g, "_")}_completions "$@"
`;

    case "fish":
      return `# Fish completion for ${commandName}

function __${commandName.replace(/-/g, "_")}_no_subcommand
  set -l cmd (commandline -opc)
  if test (count $cmd) -eq 1
    return 0
  end
  return 1
end

function __${commandName.replace(/-/g, "_")}_using_command
  set -l cmd (commandline -opc)
  set -l found 0
  for arg in $cmd
    switch $arg
      case $argv[1]
        set found 1
    end
  end
  test $found -eq 1
end

complete -c ${commandName} -f
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a run -d 'One-shot orchestration'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a config -d 'Show current configuration'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a send -d 'Send a message to the orchestrator'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a status -d 'Display full orchestrator state'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a workers -d 'Display workers table'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a tasks -d 'Display pending and in-progress tasks'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a events -d 'Display event log'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a chains -d 'Display active and completed chains'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a messages -d 'Display message history for a worker'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a wait -d 'Poll state.json until a condition is met'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_no_subcommand -a completion -d 'Generate shell completion scripts'

# Global options
complete -c ${commandName} -s z -l zookeeper -d 'ZooKeeper connection string'
complete -c ${commandName} -s d -l debug -d 'Enable debug mode'
complete -c ${commandName} -l state-dir -d 'State directory path'
complete -c ${commandName} -l json -d 'Output in JSON format'

# Run options
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:run -l worker -d 'Number of Workers'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:run -l magic -d 'Enable autonomous loop'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:run -l magic-max-chains -d 'Hard cap on chain_forest depth'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:run -s y -l yes -d 'Skip interactive prompts'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:run -l enabled-zookeeper -d 'Use real ZooKeeper'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:run -l headless -d 'Run without TUI'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:run -l no-progress -d 'Disable progress indicator'

# Events options
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:events -l tail -d 'Number of recent events to show'

# Wait options
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:wait -l task -d 'Wait for task to complete'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:wait -l chain -d 'Wait for chain to close'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:wait -l timeout -d 'Timeout in seconds'

# Completion options
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:completion -a 'bash zsh fish' -d 'Shell type'
complete -c ${commandName} -n __${commandName.replace(/-/g, "_")}_using_command\\:completion -l install -d 'Install completion script automatically'
`;

    default:
      throw new Error(`Unsupported shell: ${shell}`);
  }
}

function getCompletionInstallPath(shell: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";

  switch (shell) {
    case "bash":
      return path.join(home, ".bash_completion.d", "claude-orchestrator");
    case "zsh":
      return path.join(home, ".zsh", "completions", "_claude-orchestrator");
    case "fish":
      return path.join(home, ".config", "fish", "completions", "claude-orchestrator.fish");
    default:
      throw new Error(`Unsupported shell: ${shell}`);
  }
}

function getCompletionInstructions(shell: string): string {
  switch (shell) {
    case "bash":
      return `To enable completion, add the following to your ~/.bashrc or ~/.bash_profile:
  source ~/.bash_completion.d/claude-orchestrator

Or run:
  echo 'source ~/.bash_completion.d/claude-orchestrator' >> ~/.bashrc`;
    case "zsh":
      return `To enable completion, ensure your $fpath includes the completions directory:
  fpath=(~/.zsh/completions $fpath)
  autoload -Uz compinit && compinit

Or run:
  echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc
  echo 'autoload -Uz compinit && compinit' >> ~/.zshrc`;
    case "fish":
      return `Completion is automatically enabled for fish.
The script has been installed to ~/.config/fish/completions/`;
    default:
      return "";
  }
}

program.parseAsync().catch((err) => {
  const jsonMode = program.opts().json;
  if (jsonMode) {
    console.log(JSON.stringify(jsonError("FATAL", err instanceof Error ? err.message : String(err)), null, 2));
  } else {
    console.error("Fatal error:", err);
  }
  process.exit(1);
});
