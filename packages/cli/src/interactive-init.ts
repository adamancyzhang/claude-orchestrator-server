import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

export interface InitConfig {
  /** Project name */
  name?: string;
  /** ZooKeeper hosts */
  zk_hosts?: string;
  /** Number of workers */
  worker_count?: number;
  /** Projects root directory */
  projects_root?: string;
}

export interface InitResult {
  success: boolean;
  config_path?: string;
  message: string;
}

/**
 * Create a readline interface for interactive prompts.
 */
function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Ask a question and return the user's answer.
 */
function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

/**
 * Run the interactive init flow.
 * Guides the user through basic configuration setup.
 */
export async function runInteractiveInit(options: {
  /** Skip prompts and use defaults */
  defaults?: boolean;
  /** Working directory */
  cwd?: string;
} = {}): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const configDir = path.join(cwd, ".claude-orchestrator");
  const configPath = path.join(configDir, "config.json");

  // Check if config already exists
  if (fs.existsSync(configPath)) {
    const existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    console.log("\nConfiguration already exists at:", configPath);
    console.log("Current configuration:", JSON.stringify(existing, null, 2));
    console.log("\nTo reconfigure, delete the existing config file first.");
    return {
      success: true,
      config_path: configPath,
      message: "Configuration already exists",
    };
  }

  if (options.defaults) {
    // Use defaults without prompting
    const config: InitConfig = {
      name: "my-orchestrator",
      zk_hosts: "127.0.0.1:2181",
      worker_count: 6,
    };

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    return {
      success: true,
      config_path: configPath,
      message: "Configuration created with defaults",
    };
  }

  // Interactive mode
  const rl = createInterface();

  console.log("\n=== Claude Orchestrator Setup ===\n");
  console.log("This wizard will guide you through the initial configuration.\n");

  try {
    const config: InitConfig = {};

    // Project name
    config.name = await ask(rl, "Project name", "my-orchestrator");

    // ZooKeeper hosts
    config.zk_hosts = await ask(rl, "ZooKeeper hosts", "127.0.0.1:2181");

    // Worker count
    const workerCountStr = await ask(rl, "Number of workers (minimum 6)", "6");
    const workerCount = parseInt(workerCountStr, 10);
    if (Number.isFinite(workerCount) && workerCount >= 6) {
      config.worker_count = workerCount;
    } else {
      console.log("Invalid worker count, using default (6)");
      config.worker_count = 6;
    }

    // Projects root
    config.projects_root = await ask(rl, "Projects root directory", "~/.claude-orchestrator/projects");

    // Confirm
    console.log("\n=== Configuration Summary ===\n");
    console.log(JSON.stringify(config, null, 2));
    console.log();

    const confirm = await ask(rl, "Save this configuration? (y/n)", "y");
    if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
      return {
        success: false,
        message: "Configuration cancelled by user",
      };
    }

    // Save config
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    // Display next steps
    console.log("\n=== Setup Complete ===\n");
    console.log("Configuration saved to:", configPath);
    console.log("\nNext steps:");
    console.log("  1. Review your configuration: claude-orchestrator config");
    console.log("  2. Start the orchestrator: claude-orchestrator run");
    console.log("  3. For help: claude-orchestrator --help");
    console.log();

    return {
      success: true,
      config_path: configPath,
      message: "Configuration created successfully",
    };
  } finally {
    rl.close();
  }
}

/**
 * Display next steps after init.
 */
export function displayNextSteps(configPath: string): void {
  console.log("\n=== Next Steps ===\n");
  console.log("1. Review your configuration:");
  console.log("   claude-orchestrator config");
  console.log("\n2. Start the orchestrator:");
  console.log("   claude-orchestrator run");
  console.log("\n3. For help:");
  console.log("   claude-orchestrator --help");
  console.log("\n4. Enable shell completion:");
  console.log("   claude-orchestrator completion bash --install");
  console.log();
}
