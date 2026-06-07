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
 *   messages/<message_id>/ inbound.log                              ← system communication (structured JSON)
 *   docs/<leader>/<date>/  decompose-<msg_id>.md  chain-def.json    ← model artifacts (arbitrary markdown)
 *   docs/<worker>/<date>/  CLAUDE.md  <prefix>-<uniqueKey>.md  evidence/
 *   memory/                CLAUDE.md  <dir>/CLAUDE.md  <dir>/<file>.md
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

// messages/<message_id>/...  — system communication layer (structured JSON)
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

/**
 * Decompose result path — model artifact layer (arbitrary markdown/JSON).
 *
 * Lives under `docs/<leader>/<date>/` rather than `messages/` to keep
 * model-generated artifacts separate from system communication channels.
 * The `date` parameter should be YYYY-MM-DD format.
 */
export function decomposeResultPath(
  o: CachePathOptions,
  messageId: MessageId,
  date: string,
): string {
  return `${coRootDir(o)}/docs/${o.leader_instance_id}/${date}/decompose-${messageId}.md`;
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

// memory/...  — workspace memory mirroring the project source tree.
// Layout:
//   memory/                              — root index lives in CLAUDE.md
//   memory/<dir>/CLAUDE.md               — per-directory index
//   memory/<dir>/<file>.md               — per-source-file summary
// `relativeSourcePath` is the path of the source file relative to the project
// workspace root (e.g. "packages/worker/src/watcher.ts"). The summary file
// keeps the same relative path but swaps the extension to ".md".
export function workspaceMemoryRoot(o: CachePathOptions): string {
  return `${coRootDir(o)}/memory`;
}

export function workspaceMemoryFilePath(
  o: CachePathOptions,
  relativeSourcePath: string,
): string {
  const normalized = relativeSourcePath.replace(/^\/+/, "");
  const mdPath = normalized.replace(/\.[^./]+$/, ".md");
  return `${workspaceMemoryRoot(o)}/${mdPath}`;
}

export function workspaceMemoryDirIndexPath(
  o: CachePathOptions,
  relativeDirPath: string,
): string {
  const normalized = relativeDirPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") {
    return `${workspaceMemoryRoot(o)}/CLAUDE.md`;
  }
  return `${workspaceMemoryRoot(o)}/${normalized}/CLAUDE.md`;
}
