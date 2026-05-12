import { EventEmitter } from "node:events";

export type LeaderEventType =
  | "worker_joined"
  | "worker_left"
  | "worker_status_changed"
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
  | "debug_info";

export interface LeaderEvent {
  type: LeaderEventType;
  [key: string]: unknown;
}

const ALL_EVENT_TYPES: LeaderEventType[] = [
  "worker_joined", "worker_left", "worker_status_changed",
  "task_created", "task_claimed", "task_completed", "task_blocked", "task_failed", "task_recovered",
  "message_received", "message_processed", "chain_activated", "chain_closed", "debug_info",
];

export class LeaderEventBus {
  private emitter = new EventEmitter();

  onAll(handler: (event: LeaderEvent) => void): void {
    for (const t of ALL_EVENT_TYPES) {
      this.emitter.on(t, handler);
    }
  }

  emit(event: LeaderEvent): void {
    this.emitter.emit(event.type, event);
  }

  on(type: LeaderEventType, handler: (event: LeaderEvent) => void): void {
    this.emitter.on(type, handler);
  }
}
