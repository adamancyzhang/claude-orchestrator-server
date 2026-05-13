import type { LeaderEvent } from "./event-bus.js";

function taskLinkToRole(link: string): string {
  const map: Record<string, string> = {
    plan: "planner",
    build: "builder",
    verify: "verifier",
    review: "reviewer",
    accept: "accepter",
  };
  return map[link] ?? link;
}

export interface WorkerMessageEntry {
  timestamp: string;
  content: string;
  contentFull: string;
  link: string | null;
  messageId: string;
}

export interface WorkerInfo {
  id: string;
  name: string;
  presetRole: string;
  currentRole: string | null;
  status: string;
  currentTaskId: string | null;
  worktreeName: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  pid: number | null;
  currentMessage: string | null;
  currentMessageLink: string | null;
  currentMessageTime: string | null;
  messageHistory: WorkerMessageEntry[];
  lastCompletedTask: string | null;
  streamBuffer: string[];
  streamActive: boolean;
  streamLogPath: string | null;
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
  selectedWorkerIndex = 0;

  apply(event: LeaderEvent): void {
    const time = new Date().toLocaleTimeString();
    switch (event.type) {
      case "worker_joined": {
        const inst = event.instance as Record<string, unknown>;
        if (!inst) return;
        this.workers.push({
          id: (event.instanceId as string) ?? (inst.id as string),
          name: inst.name as string,
          presetRole: inst.role as string,
          currentRole: null,
          status: inst.status as string,
          currentTaskId: (inst.current_task_id as string) ?? null,
          worktreeName: (inst.worktree_name as string) ?? null,
          worktreePath: (inst.worktree_path as string) ?? null,
          worktreeBranch: (inst.worktree_branch as string) ?? null,
          pid: (inst.pid as number) ?? null,
          currentMessage: null,
          currentMessageLink: null,
          currentMessageTime: null,
          messageHistory: [],
          lastCompletedTask: null,
          streamBuffer: [],
          streamActive: false,
          streamLogPath: null,
        });
        this.events.push({ timestamp: time, message: `${inst.name} joined (${inst.role})` });
        break;
      }
      case "worker_left": {
        const leftIdx = this.workers.findIndex(w => w.id === event.instanceId);
        this.workers = this.workers.filter(w => w.id !== event.instanceId);
        if (leftIdx === this.selectedWorkerIndex) {
          this.selectedWorkerIndex = Math.min(this.selectedWorkerIndex, this.workers.length - 1);
          if (this.selectedWorkerIndex < 0) this.selectedWorkerIndex = 0;
        } else if (leftIdx < this.selectedWorkerIndex && this.selectedWorkerIndex > 0) {
          this.selectedWorkerIndex--;
        }
        this.events.push({ timestamp: time, message: `${event.name} left` });
        break;
      }
      case "worker_message_received": {
        const w = this.workers.find(w => w.id === event.instanceId);
        if (w) {
          const rawContent = (event.content as string) ?? "";
          const timestamp = (event.timestamp as string) ?? time;
          w.currentMessage = rawContent;
          w.currentMessageLink = (event.link as string) ?? null;
          w.currentMessageTime = timestamp;
          w.messageHistory.push({
            timestamp,
            content: rawContent,
            contentFull: rawContent,
            link: (event.link as string) ?? null,
            messageId: (event.messageId as string) ?? "",
          });
          if (w.messageHistory.length > 20) {
            w.messageHistory = w.messageHistory.slice(-20);
          }
          w.status = "busy";
        }
        this.events.push({ timestamp: time, message: `${event.name} received message: ${(event.content as string)?.slice(0, 60)}...` });
        break;
      }
      case "worker_status_changed": {
        const w = this.workers.find(w => w.id === event.instanceId);
        if (w) {
          w.status = event.status as string;
          w.currentTaskId = (event.currentTaskId as string) ?? null;
          if (!w.currentTaskId) w.currentRole = null;
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
        // Derive currentRole from the task's link
        const w = this.workers.find(w => w.id === event.instanceId);
        if (w) {
          const taskLink = (t?.link as string) ?? (event.link as string) ?? null;
          w.currentRole = taskLink ? taskLinkToRole(taskLink) : null;
          w.currentTaskId = event.taskId as string ?? null;
          w.status = "busy";
        }
        this.events.push({ timestamp: time, message: `Task ${event.taskId} claimed by ${event.instanceId}` });
        break;
      }
      case "task_completed": {
        this.claimedTasks = this.claimedTasks.filter(t => t.id !== event.taskId);
        if (event.task) this.completedTasks.push(event.task as Record<string, unknown>);
        const w = this.workers.find(w => w.id === event.instanceId);
        if (w) {
          w.currentRole = null;
          w.status = "idle";
          w.currentTaskId = null;
          w.lastCompletedTask = (event.task as Record<string, unknown>)?.title as string ?? null;
          w.currentMessage = null;
          w.currentMessageLink = null;
          w.currentMessageTime = null;
        }
        this.events.push({ timestamp: time, message: `Task ${event.taskId} completed` });
        break;
      }
      case "task_blocked":
        this.events.push({ timestamp: time, message: `Task ${event.taskId} blocked: ${event.reason}` });
        break;
      case "task_failed":
        this.claimedTasks = this.claimedTasks.filter(t => t.id !== event.taskId);
        {
          const w = this.workers.find(w => w.id === event.instanceId);
          if (w) { w.currentRole = null; w.status = "idle"; w.currentTaskId = null; }
        }
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
      case "chain_activated":
        this.events.push({ timestamp: time, message: `Chain ${event.chainId} activated` });
        break;
      case "chain_closed":
        this.events.push({ timestamp: time, message: `Chain ${event.chainId} closed` });
        break;
      case "debug_info":
        this.events.push({ timestamp: time, message: `[DEBUG] ${event.message}` });
        break;
      case "stream_start": {
        const w = this.workers.find(w => w.id === event.instanceId);
        if (w) {
          w.streamBuffer = [];
          w.streamActive = true;
          w.streamLogPath = (event.logPath as string) ?? null;
        }
        break;
      }
      case "stream_chunk": {
        const w = this.workers.find(w => w.id === event.instanceId);
        if (w && w.streamActive) {
          w.streamBuffer.push(event.line as string);
          if (w.streamBuffer.length > 200) {
            w.streamBuffer = w.streamBuffer.slice(-200);
          }
        }
        break;
      }
      case "stream_end": {
        const w = this.workers.find(w => w.id === event.instanceId);
        if (w) {
          w.streamActive = false;
        }
        break;
      }
    }
    // Keep event log to last 100 entries
    if (this.events.length > 100) this.events.shift();
  }
}
