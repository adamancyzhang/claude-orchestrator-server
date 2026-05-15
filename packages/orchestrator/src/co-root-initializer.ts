import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ILogger, InstanceId } from "@co/contracts";

export interface EnsureCoRootInput {
  projects_root: string;
  leader_instance_id: InstanceId;
  git_command?: string;
  logger: ILogger;
}

const GITIGNORE_ENTRIES = [
  "tasks/*/exec-*.log",
  "tasks/*/eval-*.log",
  "tasks/*/commit.log",
  "messages/*/inbound.log",
  "*.tmp",
];

/**
 * Ensures `${projects_root}/${leader_instance_id}/` exists as an independent
 * git repository, separate from the user's project repo. This is where all CO
 * runtime state (chains/, tasks/, messages/, docs/) is persisted.
 *
 * Idempotent: if `.git/` already exists, no-op.
 */
export async function ensureCoRoot(input: EnsureCoRootInput): Promise<string> {
  const root = path.join(input.projects_root, input.leader_instance_id);
  const gitDir = path.join(root, ".git");
  await fs.promises.mkdir(root, { recursive: true });

  if (fs.existsSync(gitDir)) {
    input.logger.debug("co-root already initialized", { path: root });
    return root;
  }

  const gitCmd = input.git_command ?? "git";
  const run = (args: string) =>
    execSync(`${gitCmd} ${args}`, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

  run("init -q");
  await fs.promises.writeFile(
    path.join(root, ".gitignore"),
    GITIGNORE_ENTRIES.join("\n") + "\n",
    "utf-8",
  );
  await fs.promises.writeFile(
    path.join(root, "README.md"),
    `# claude-orchestrator state — leader ${input.leader_instance_id}\n\n` +
      `Created ${new Date().toISOString()}\n\n` +
      "This directory holds non-source-code CO runtime state " +
      "(chains/, tasks/, messages/, docs/). Worktrees and project " +
      "config remain in the user project under " +
      "`<project>/.claude-orchestrator/`.\n",
    "utf-8",
  );

  try {
    run("add .gitignore README.md");
    run('commit -q -m "init: co-root for leader"');
  } catch (err) {
    input.logger.warn("co-root init commit skipped", { error: String(err) });
  }
  input.logger.info("co-root initialized", { path: root });
  return root;
}
