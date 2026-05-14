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
  | { type: "debug_info"; message: string }
  | {
      type: "stream_chunk";
      instance_id: InstanceId;
      chunk: string;
    };

export type LeaderEventType = LeaderEvent["type"];

export function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}
