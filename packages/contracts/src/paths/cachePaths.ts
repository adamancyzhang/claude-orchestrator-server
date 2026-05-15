import type { ChainId, InstanceId, MessageId, TaskId } from "../ids.js";

/**
 * Options for computing paths under a leader's CO state root.
 *
 * `projects_root` is the global parent (default `~/.claude-orchestrator/projects`).
 * The actual leader state lives at `${projects_root}/${leader_instance_id}/`.
 *
 * Layout under the leader root:
 *   chains/<chain_id>/     requirement.md  manifest.json  audit.jsonl
 *   tasks/<task_id>/       definition.md  exec-<ts>.log  eval-<n>.log  commit.log  result.md
 *   messages/<message_id>/ inbound.log  decompose.md
 *   docs/<worker>/<date>/  CLAUDE.md  <prefix>-<uniqueKey>.md  evidence/
 */
export interface CachePathOptions {
  projects_root: string;
  leader_instance_id: InstanceId;
}

export function coRootDir(o: CachePathOptions): string {
  return `${o.projects_root}/${o.leader_instance_id}`;
}

// chains/<chain_id>/...  — only link-level metadata; task outputs live in tasks/<task_id>/
export function chainDir(o: CachePathOptions, chainId: ChainId): string {
  return `${coRootDir(o)}/chains/${chainId}`;
}

export function chainRequirementPath(
  o: CachePathOptions,
  chainId: ChainId,
): string {
  return `${chainDir(o, chainId)}/requirement.md`;
}

export function chainManifestPath(
  o: CachePathOptions,
  chainId: ChainId,
): string {
  return `${chainDir(o, chainId)}/manifest.json`;
}

export function chainAuditPath(
  o: CachePathOptions,
  chainId: ChainId,
): string {
  return `${chainDir(o, chainId)}/audit.jsonl`;
}

// tasks/<task_id>/...  — definition + all per-task artifacts
export function taskDir(o: CachePathOptions, taskId: TaskId): string {
  return `${coRootDir(o)}/tasks/${taskId}`;
}

export function taskDefinitionPath(
  o: CachePathOptions,
  taskId: TaskId,
): string {
  return `${taskDir(o, taskId)}/definition.md`;
}

export function taskLogPath(
  o: CachePathOptions,
  taskId: TaskId,
  ts: string,
): string {
  return `${taskDir(o, taskId)}/exec-${ts}.log`;
}

export function taskResultPath(o: CachePathOptions, taskId: TaskId): string {
  return `${taskDir(o, taskId)}/result.md`;
}

export function evalLogPath(
  o: CachePathOptions,
  taskId: TaskId,
  attempt: number,
): string {
  return `${taskDir(o, taskId)}/eval-${attempt}.log`;
}

export function commitLogPath(o: CachePathOptions, taskId: TaskId): string {
  return `${taskDir(o, taskId)}/commit.log`;
}

// messages/<message_id>/...
export function messageDir(
  o: CachePathOptions,
  messageId: MessageId,
): string {
  return `${coRootDir(o)}/messages/${messageId}`;
}

export function messageLogPath(
  o: CachePathOptions,
  messageId: MessageId,
): string {
  return `${messageDir(o, messageId)}/inbound.log`;
}

export function decomposeResultPath(
  o: CachePathOptions,
  messageId: MessageId,
): string {
  return `${messageDir(o, messageId)}/decompose.md`;
}

// docs/<worker>/<date>/<prefix>-<uniqueKey>.md  — worker local copies
export function workerLocalDocPath(
  o: CachePathOptions,
  workerName: string,
  date: string,
  prefix: string,
  uniqueKey: string,
): string {
  return `${coRootDir(o)}/docs/${workerName}/${date}/${prefix}-${uniqueKey}.md`;
}
