import type {
  ChainId,
  InstanceId,
  MessageId,
  TaskId,
} from "./ids.js";
import type {
  InstanceStatus,
  MessageType,
  TaskLink,
} from "./enums.js";
import type { Instance } from "./schemas/instance.js";
import type { Task } from "./schemas/task.js";

export type WorkerPhase =
  | "claim"
  | "rebase"
  | "generate"
  | "validate"
  | "commit"
  | "docs_commit"
  | "evaluate"
  | "report";

export type WorkerAction =
  | "phase_start"
  | "phase_end"
  | "retry"
  | "tool_use"
  | "thinking"
  | "text"
  | "error";

// Wire-level shape sent by the Worker to the Leader inside a
// `worker_activity` message. Multiple payloads are batched into a
// single message (see WorkerActivityReporter); the Leader fans them
// out to N `worker_activity` LeaderEvents on the bus.
export interface WorkerActivityPayload {
  phase: WorkerPhase;
  action: WorkerAction;
  detail: string;
  next: string | null;
  link: TaskLink | null;
  task_id: TaskId | null;
  timestamp: string;
}

export type LeaderEvent =
  | { type: "worker_joined"; instance: Instance }
  | { type: "worker_left"; instance_id: InstanceId; name: string }
  | {
      type: "worker_status_changed";
      instance_id: InstanceId;
      status: InstanceStatus;
      current_task_id?: TaskId | null;
    }
  | {
      type: "worker_message_received";
      instance_id: InstanceId;
      message_id: MessageId;
      content: string;
      link: TaskLink | null;
      timestamp: string;
    }
  | { type: "task_created"; task: Task }
  | { type: "task_claimed"; task_id: TaskId; instance_id: InstanceId }
  | {
      type: "task_completed";
      task_id: TaskId;
      instance_id: InstanceId;
      duration_seconds: number | null;
    }
  | { type: "task_blocked"; task_id: TaskId; reason: string }
  | { type: "task_failed"; task_id: TaskId; reason: string }
  | { type: "task_recovered"; task_id: TaskId; retry_count: number }
  | { type: "task_dependency_resolved"; task_id: TaskId }
  | {
      type: "message_sent";
      from: InstanceId;
      to: InstanceId | null;
      message_type: MessageType;
    }
  | {
      type: "message_received";
      from: InstanceId;
      message_id: MessageId;
      content: string;
    }
  | { type: "message_processed"; message_id: MessageId; log_path: string }
  | { type: "chain_activated"; chain_id: ChainId }
  | { type: "chain_closed"; chain_id: ChainId }
  | {
      type: "chain_merge_failed";
      chain_id: ChainId;
      failures: ReadonlyArray<{
        link: TaskLink;
        sha: string;
        branch: string;
        message: string;
        error: string;
      }>;
    }
  // Explorer's spawn_chain decision closed the parent and
  // opened the child chain.
  | {
      type: "chain_spawned";
      parent_chain_id: ChainId;
      child_chain_id: ChainId;
      chain_depth: number;
    }
  // A spawn_chain decision was blocked by --magic-max-chains
  // and demoted to close_chain.
  | {
      type: "magic_depth_exhausted";
      chain_id: ChainId;
      chain_depth: number;
      max_chains: number;
    }
  // Leader broadcasts the configured magic-mode flags so the
  // TUI can render the [MAGIC] badge.
  | {
      type: "magic_mode_configured";
      magic_mode: boolean;
      magic_max_chains: number | null;
    }
  | { type: "debug_info"; message: string }
  | {
      type: "stream_chunk";
      instance_id: InstanceId;
      chunk: string;
    }
  // Worker self-reports a pipeline step. `phase` is the stage (rebase,
  // generate, commit, evaluate, …); `action` is the sub-event (start /
  // end / retry / tool_use / text / thinking / error). `detail` is a
  // short human-readable label. High-frequency actions (tool_use, text,
  // thinking) update WorkerInfo current_* fields but are excluded from
  // LeaderState._events ring buffer to keep the event log scannable.
  | {
      type: "worker_activity";
      instance_id: InstanceId;
      task_id: TaskId | null;
      link: TaskLink | null;
      phase: WorkerPhase;
      action: WorkerAction;
      detail: string;
      next: string | null;
      timestamp: string;
    }
  // Health monitor detected a worker heartbeat timeout.
  | {
      type: "worker_health_timeout";
      instance_id: InstanceId;
      name: string;
      last_heartbeat: string | null;
      seconds_since_heartbeat: number;
    };

export type LeaderEventType = LeaderEvent["type"];

export function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}
