import type { LeaderEvent } from "./event-bus.js";

export interface WorkerInfo {
  id: string;
  name: string;
  role: string;
  status: string;
  currentTaskId: string | null;
}

export interface EventLogEntry {
  timestamp: string;
  message: string;
}

export class LeaderState {
  workers: WorkerInfo[] = [];
  pendingTasks: Record<string, unknown>[] = [];
  claimedTasks: Record<string, unknown>[] = [];
  completedTasks: Record<string, unknown>[] = [];
  events: EventLogEntry[] = [];
  leaderName = "";
  leaderInstanceId = "";
  cacheDir = "";

  apply(event: LeaderEvent): void {
    const time = new Date().toLocaleTimeString();
    switch (event.type) {
      case "worker_joined": {
        const inst = event.instance as Record<string, unknown>;
        if (!inst) return;
        this.workers.push({
          id: (event.instanceId as string) ?? (inst.id as string),
          name: inst.name as string,
          role: inst.role as string,
          status: inst.status as string,
          currentTaskId: (inst.current_task_id as string) ?? null,
        });
        this.events.push({ timestamp: time, message: `${inst.name} joined (${inst.role})` });
        break;
      }
      case "worker_left":
        this.workers = this.workers.filter(w => w.id !== event.instanceId);
        this.events.push({ timestamp: time, message: `${event.name} left` });
        break;
      case "worker_status_changed": {
        const w = this.workers.find(w => w.id === event.instanceId);
        if (w) {
          w.status = event.status as string;
          w.currentTaskId = (event.currentTaskId as string) ?? null;
        }
        this.events.push({ timestamp: time, message: `${event.name}: ${event.status}` });
        break;
      }
      case "task_created": {
        const task = event.task as Record<string, unknown>;
        if (task) this.pendingTasks.push(task);
        this.events.push({ timestamp: time, message: `Task created: ${task?.title ?? event.taskId}` });
        break;
      }
      case "task_claimed": {
        const t = this.pendingTasks.find(t => t.id === event.taskId);
        if (t) {
          t.status = "claimed";
          this.claimedTasks.push(t);
          this.pendingTasks = this.pendingTasks.filter(t => t.id !== event.taskId);
        }
        this.events.push({ timestamp: time, message: `Task ${event.taskId} claimed by ${event.instanceId}` });
        break;
      }
      case "task_completed":
        this.claimedTasks = this.claimedTasks.filter(t => t.id !== event.taskId);
        if (event.task) this.completedTasks.push(event.task as Record<string, unknown>);
        this.events.push({ timestamp: time, message: `Task ${event.taskId} completed` });
        break;
      case "task_blocked":
        this.events.push({ timestamp: time, message: `Task ${event.taskId} blocked: ${event.reason}` });
        break;
      case "task_failed":
        this.claimedTasks = this.claimedTasks.filter(t => t.id !== event.taskId);
        this.events.push({ timestamp: time, message: `Task ${event.taskId} failed: ${event.reason}` });
        break;
      case "task_recovered":
        this.events.push({ timestamp: time, message: `Task ${event.taskId} recovered → ${event.newTaskId} (retry ${event.retryCount})` });
        break;
      case "message_received":
        this.events.push({ timestamp: time, message: `Message from ${event.from}: ${(event.content as string)?.slice(0, 60)}...` });
        break;
      case "message_processed":
        this.events.push({ timestamp: time, message: `Message ${event.msgId} processed` });
        break;
    }
    // Keep event log to last 100 entries
    if (this.events.length > 100) this.events.shift();
  }
}
