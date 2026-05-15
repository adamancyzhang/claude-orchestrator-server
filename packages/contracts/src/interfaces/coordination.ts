import type { InstanceId, TaskId } from "../ids.js";
import type { InstanceRole } from "../enums.js";
import type {
  ClaimRecord,
  CreateTaskInput,
  Task,
} from "../schemas/task.js";
import type {
  CreateInstanceInput,
  Instance,
} from "../schemas/instance.js";
import type { Message, SendMessageInput } from "../schemas/message.js";

export interface ITaskQueue {
  push(input: CreateTaskInput): Promise<Task>;
  claim(claimer: InstanceId, role: InstanceRole): Promise<Task | null>;
  /**
   * Claim a specific pending task by id (no sort, no role filtering).
   * Used by Workers that received a directed `task_dispatch` message
   * and must transition that exact task from pending → claimed.
   * Returns null when the task is already gone (someone else claimed it
   * or it was completed).
   */
  claimById(taskId: TaskId, claimer: InstanceId): Promise<Task | null>;
  /**
   * Set `assigned_to` / `assigned_to_name` on a still-pending task without
   * transitioning it to claimed. Used by the Leader to pin a pending task
   * to a specific Worker just before sending the corresponding dispatch
   * message. Returns the updated Task, or null when the task is no longer
   * pending (already claimed / completed).
   */
  assign(
    taskId: TaskId,
    instanceId: InstanceId,
    instanceName: string,
  ): Promise<Task | null>;
  complete(
    taskId: TaskId,
    result: string,
    by: InstanceId,
    completedByName: string,
    durationSeconds: number | null,
  ): Promise<void>;
  block(taskId: TaskId, reason: string): Promise<void>;
  fail(taskId: TaskId, reason: string): Promise<void>;
  retry(taskId: TaskId): Promise<Task>;
  listPending(): Promise<Task[]>;
  listClaimed(): Promise<ClaimRecord[]>;
  getPending(taskId: TaskId): Promise<Task | null>;
  getCompleted(taskId: TaskId): Promise<Task | null>;
  watchPending(cb: (children: TaskId[]) => void): Promise<TaskId[]>;
  watchClaimed(cb: (records: ClaimRecord[]) => void): Promise<ClaimRecord[]>;
}

export interface IMessageRouter {
  send(input: SendMessageInput): Promise<Message>;
  poll(instanceId: InstanceId): Promise<Message[]>;
  waitForMessage(
    instanceId: InstanceId,
    cb: (msg: Message) => void,
  ): Promise<void>;
  dismiss(instanceId: InstanceId, messageId: string): Promise<void>;
}

export interface IInstanceRegistry {
  register(input: CreateInstanceInput): Promise<Instance>;
  unregister(instanceId: InstanceId): Promise<void>;
  heartbeat(
    instanceId: InstanceId,
    patch: Partial<Instance>,
  ): Promise<void>;
  list(): Promise<Instance[]>;
  get(instanceId: InstanceId): Promise<Instance | null>;
  watch(cb: (instances: Instance[]) => void): Promise<Instance[]>;
}
