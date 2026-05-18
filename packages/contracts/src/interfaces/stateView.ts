import type { InstanceId, MessageId, TaskId, WorktreeName } from "../ids.js";
import type {
  InstanceRole,
  InstanceStatus,
  TaskLink,
} from "../enums.js";
import type { Task } from "../schemas/task.js";
import type { LeaderEvent } from "../events.js";

export interface WorkerMessageEntry {
  readonly message_id: MessageId;
  readonly content: string;
  readonly link: TaskLink | null;
  readonly timestamp: string;
}

export interface WorkerInfo {
  readonly id: InstanceId;
  readonly name: string;
  readonly preset_role: InstanceRole;
  readonly current_role: InstanceRole | null;
  readonly status: InstanceStatus | "failed";
  readonly current_task_id: TaskId | null;
  readonly worktree_name: WorktreeName | null;
  readonly worktree_path: string | null;
  readonly worktree_branch: string | null;
  readonly pid: number | null;
  readonly current_message: string | null;
  readonly current_message_link: TaskLink | null;
  readonly current_message_time: string | null;
  readonly message_history: readonly WorkerMessageEntry[];
  readonly last_completed_task: TaskId | null;
}

export interface ILeaderStateView {
  readonly workers: readonly WorkerInfo[];
  readonly pending_tasks: readonly Task[];
  readonly in_progress_tasks: readonly Task[];
  readonly events: readonly LeaderEvent[];
  readonly selected_worker_index: number;
  // v0.7 NEW — surfaced for the TUI [MAGIC] badge.
  readonly magic_mode: boolean;
  readonly magic_max_chains: number | null;
}
