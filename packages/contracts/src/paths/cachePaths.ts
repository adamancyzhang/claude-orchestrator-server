import type { InstanceId, MessageId, TaskId } from "../ids.js";

export interface CachePathOptions {
  cache_dir: string;
  leader_instance_id: InstanceId;
}

export function leaderCacheDir(o: CachePathOptions): string {
  return `${o.cache_dir}/${o.leader_instance_id}`;
}

export function taskDocPath(o: CachePathOptions, seq: number): string {
  return `${leaderCacheDir(o)}/tasks/task-${seq}.md`;
}

export function taskLogPath(
  o: CachePathOptions,
  taskId: TaskId,
  ts: string,
): string {
  return `${leaderCacheDir(o)}/logs/task-${taskId}-${ts}.log`;
}

export function taskResultPath(o: CachePathOptions, taskId: TaskId): string {
  return `${leaderCacheDir(o)}/results/task-${taskId}.md`;
}

export function evalLogPath(
  o: CachePathOptions,
  taskId: TaskId,
  attempt: number,
): string {
  return `${leaderCacheDir(o)}/evals/task-${taskId}-attempt-${attempt}.log`;
}

export function commitLogPath(o: CachePathOptions, taskId: TaskId): string {
  return `${leaderCacheDir(o)}/commits/task-${taskId}.log`;
}

export function messageLogPath(
  o: CachePathOptions,
  messageId: MessageId,
): string {
  return `${leaderCacheDir(o)}/messages/${messageId}.log`;
}
