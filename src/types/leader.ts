export type { WorkerInfo, WorkerMessageEntry, EventLogEntry } from "../leader/state.js";
export type { MergeDecision } from "../leader/merge-validator.js";

export type LeaderEventType =
  | "worker_joined"
  | "worker_left"
  | "worker_status_changed"
  | "worker_message_received"
  | "task_created"
  | "task_claimed"
  | "task_completed"
  | "task_blocked"
  | "task_failed"
  | "task_recovered"
  | "message_received"
  | "message_processed"
  | "chain_activated"
  | "chain_closed"
  | "debug_info"
  | "stream_start"
  | "stream_chunk"
  | "stream_end";

export type LeaderEvent =
  | { type: "worker_joined"; instance: unknown; instanceId: string; name: string }
  | { type: "worker_left"; instanceId: string; name: string }
  | { type: "worker_status_changed"; instanceId: string; instance: string; name: string; status: string; currentTaskId?: string }
  | { type: "worker_message_received"; instanceId: string; name: string; content: string; link: string | null; timestamp: string; messageId: string }
  | { type: "task_created"; task: unknown; taskId: string }
  | { type: "task_claimed"; instanceId: string; taskId: string; link?: string }
  | { type: "task_completed"; instanceId?: string; taskId: string; task?: unknown }
  | { type: "task_blocked"; taskId: string; reason: string }
  | { type: "task_failed"; instanceId?: string; taskId: string; reason: string }
  | { type: "task_recovered"; taskId: string; newTaskId: string; retryCount: number }
  | { type: "message_received"; from: string; content: string; msgId: string }
  | { type: "message_processed"; msgId: string }
  | { type: "chain_activated"; chainId: string }
  | { type: "chain_closed"; chainId: string }
  | { type: "debug_info"; message: string }
  | { type: "stream_start"; instanceId: string; logPath: string; taskId?: string }
  | { type: "stream_chunk"; instanceId: string; line: string }
  | { type: "stream_end"; instanceId: string; logPath?: string };
