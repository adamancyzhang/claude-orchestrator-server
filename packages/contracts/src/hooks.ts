import type {
  ChainId,
  InstanceId,
  MessageId,
  TaskId,
} from "./ids.js";
import type { MergeDecisionKind, TaskLink } from "./enums.js";

export interface LeaderMessageEnv {
  CO_LEADER_ID: InstanceId;
  CO_MESSAGE_ID: MessageId;
  CO_LINK: TaskLink | "";
  CO_LOG_PATH: string;
}

export interface WorkerMessageEnv {
  CO_WORKER_NAME: string;
  CO_WORKER_ID: InstanceId;
  CO_WORKER_ROLE: string;
  CO_LEADER_ID: InstanceId;
  CO_MESSAGE_ID: MessageId | "";
  CO_TASK_ID: TaskId | "";
  CO_LINK: TaskLink | "";
  CO_CHAIN_ID: ChainId | "";
  CO_LOG_PATH: string;
  CO_RESULT_PATH: string;
}

export interface TaskHookEnv {
  CO_WORKER_NAME: string;
  CO_WORKER_ID: InstanceId;
  CO_WORKER_ROLE: string;
  CO_LEADER_ID: InstanceId;
  CO_MESSAGE_ID: MessageId | "";
  CO_TASK_ID: TaskId;
  CO_LINK: TaskLink | "";
  CO_CHAIN_ID: ChainId | "";
}

export type HookEvent =
  | { type: "leader_message_start"; env: LeaderMessageEnv }
  | {
      type: "leader_message_end";
      env: LeaderMessageEnv & { exit_code: number };
    }
  | { type: "worker_message_start"; env: WorkerMessageEnv }
  | {
      type: "worker_message_end";
      env: WorkerMessageEnv & { exit_code: number };
    }
  | { type: "task_claimed"; env: TaskHookEnv }
  | {
      type: "task_completed";
      env: TaskHookEnv & { duration_seconds: number | null };
    }
  | { type: "chain_activated"; env: { CO_CHAIN_ID: ChainId } }
  | {
      type: "merge_decision_made";
      env: {
        CO_DECISION: MergeDecisionKind;
        CO_BRANCH: string;
        CO_REASON: string;
      };
    };

export type HookEventType = HookEvent["type"];

export const HOOK_EVENT_TYPES: readonly HookEventType[] = [
  "leader_message_start",
  "leader_message_end",
  "worker_message_start",
  "worker_message_end",
  "task_claimed",
  "task_completed",
  "chain_activated",
  "merge_decision_made",
];
