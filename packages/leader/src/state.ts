import {
  type ILeaderStateView,
  type InstanceRole,
  type LeaderEvent,
  type Task,
  type WorkerInfo,
  type WorkerMessageEntry,
  assertNever,
} from "@co/contracts";

interface MutableWorker {
  id: WorkerInfo["id"];
  name: string;
  preset_role: InstanceRole;
  current_role: InstanceRole | null;
  status: WorkerInfo["status"];
  current_task_id: WorkerInfo["current_task_id"];
  worktree_name: WorkerInfo["worktree_name"];
  worktree_path: string | null;
  worktree_branch: string | null;
  pid: number | null;
  current_message: string | null;
  current_message_link: WorkerInfo["current_message_link"];
  current_message_time: string | null;
  message_history: WorkerMessageEntry[];
  last_completed_task: WorkerInfo["last_completed_task"];
}

const LINK_TO_ROLE: Record<string, InstanceRole> = {
  plan: "planner",
  execute: "executor",
  verify: "verifier",
  review: "reviewer",
  accept: "accepter",
  explore: "explorer",
};

export class LeaderState implements ILeaderStateView {
  private _workers: MutableWorker[] = [];
  private _pending: Task[] = [];
  private _in_progress: Task[] = [];
  private _events: LeaderEvent[] = [];
  private _selected = 0;
  private _magic_mode = false;
  private _magic_max_chains: number | null = null;

  get workers(): readonly WorkerInfo[] {
    return this._workers as readonly WorkerInfo[];
  }
  get pending_tasks(): readonly Task[] {
    return this._pending;
  }
  get in_progress_tasks(): readonly Task[] {
    return this._in_progress;
  }
  get events(): readonly LeaderEvent[] {
    return this._events;
  }
  get selected_worker_index(): number {
    return this._selected;
  }
  get magic_mode(): boolean {
    return this._magic_mode;
  }
  get magic_max_chains(): number | null {
    return this._magic_max_chains;
  }

  setSelectedWorkerIndex(idx: number): void {
    if (this._workers.length === 0) {
      this._selected = 0;
      return;
    }
    this._selected = Math.max(0, Math.min(idx, this._workers.length - 1));
  }

  apply(event: LeaderEvent): void {
    this._events.push(event);
    if (this._events.length > 100) this._events.shift();

    switch (event.type) {
      case "worker_joined": {
        const inst = event.instance;
        this._workers.push({
          id: inst.id,
          name: inst.name,
          preset_role: inst.role,
          current_role: null,
          status: inst.status,
          current_task_id: inst.current_task_id ?? null,
          worktree_name: inst.worktree_name ?? null,
          worktree_path: inst.worktree_path ?? null,
          worktree_branch: inst.worktree_branch ?? null,
          pid: inst.pid ?? null,
          current_message: null,
          current_message_link: null,
          current_message_time: null,
          message_history: [],
          last_completed_task: null,
        });
        break;
      }
      case "worker_left": {
        const idx = this._workers.findIndex((w) => w.id === event.instance_id);
        if (idx >= 0) this._workers.splice(idx, 1);
        if (idx <= this._selected) {
          this._selected = Math.max(0, this._selected - 1);
        }
        break;
      }
      case "worker_status_changed": {
        const w = this._workers.find((w) => w.id === event.instance_id);
        if (w) {
          w.status = event.status;
          if (event.current_task_id !== undefined) {
            w.current_task_id = event.current_task_id;
          }
          if (!w.current_task_id) w.current_role = null;
        }
        break;
      }
      case "worker_message_received": {
        const w = this._workers.find((w) => w.id === event.instance_id);
        if (w) {
          w.current_message = event.content;
          w.current_message_link = event.link;
          w.current_message_time = event.timestamp;
          w.message_history.push({
            message_id: event.message_id,
            content: event.content,
            link: event.link,
            timestamp: event.timestamp,
          });
          if (w.message_history.length > 20) {
            w.message_history = w.message_history.slice(-20);
          }
          w.status = "busy";
        }
        break;
      }
      case "task_created": {
        this._pending.push(event.task);
        break;
      }
      case "task_claimed": {
        const idx = this._pending.findIndex((t) => t.id === event.task_id);
        if (idx >= 0) {
          const [t] = this._pending.splice(idx, 1);
          this._in_progress.push({ ...t, status: "claimed", claimed_by: event.instance_id });
          const w = this._workers.find((w) => w.id === event.instance_id);
          if (w) {
            w.current_task_id = event.task_id;
            w.status = "busy";
            if (t.link && LINK_TO_ROLE[t.link]) {
              w.current_role = LINK_TO_ROLE[t.link];
            }
          }
        }
        break;
      }
      case "task_completed": {
        this._in_progress = this._in_progress.filter((t) => t.id !== event.task_id);
        const w = this._workers.find((w) => w.id === event.instance_id);
        if (w) {
          w.current_role = null;
          w.status = "idle";
          w.current_task_id = null;
          w.last_completed_task = event.task_id;
          w.current_message = null;
          w.current_message_link = null;
          w.current_message_time = null;
        }
        break;
      }
      case "task_failed": {
        this._in_progress = this._in_progress.filter((t) => t.id !== event.task_id);
        break;
      }
      case "magic_mode_configured": {
        this._magic_mode = event.magic_mode;
        this._magic_max_chains = event.magic_max_chains;
        break;
      }
      case "task_blocked":
      case "task_recovered":
      case "task_dependency_resolved":
      case "message_sent":
      case "message_received":
      case "message_processed":
      case "chain_activated":
      case "chain_closed":
      case "chain_merge_failed":
      case "chain_spawned":
      case "magic_depth_exhausted":
      case "debug_info":
      case "stream_chunk":
        break;
      default:
        assertNever(event);
    }
  }
}
