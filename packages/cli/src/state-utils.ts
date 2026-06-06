import * as fs from "node:fs";
import * as path from "node:path";

export interface StateData {
  workers: Array<{
    id: string;
    name: string;
    status: string;
    current_task_id: string | null;
    current_role: string | null;
    worktree_name: string | null;
    message_history: Array<{
      message_id: string;
      content: string;
      link: string | null;
      timestamp: string;
    }>;
    activity_history: Array<{
      phase: string;
      action: string;
      detail: string;
      timestamp: string;
    }>;
  }>;
  pending_tasks: Array<{
    id: string;
    description: string;
    status: string;
    link: string | null;
  }>;
  in_progress_tasks: Array<{
    id: string;
    description: string;
    status: string;
    claimed_by: string | null;
    link: string | null;
  }>;
  events: Array<{
    type: string;
    timestamp: string;
    [key: string]: unknown;
  }>;
}

export function readState(stateDir: string): StateData {
  const statePath = path.join(stateDir, "state.json");
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Is the orchestrator running?`);
  }
  const raw = fs.readFileSync(statePath, "utf-8");
  return JSON.parse(raw) as StateData;
}

export function getStateDir(globalOpts: { stateDir?: string }): string {
  return globalOpts.stateDir ?? path.join(".claude-orchestrator", "state");
}
