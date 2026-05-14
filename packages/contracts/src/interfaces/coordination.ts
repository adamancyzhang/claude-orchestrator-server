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
