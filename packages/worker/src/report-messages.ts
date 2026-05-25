import * as fs from "node:fs";
import type {
  ChainId,
  InstanceId,
  Message,
  SendMessageInput,
  TaskId,
  TaskLink,
} from "@co/contracts";
import type { CommitResult } from "./commit-checker.js";

export interface WorkerIdentity {
  instance_id: InstanceId;
  worker_name: string;
  worker_role: string;
  worktree_branch: string;
  leader_id: InstanceId;
}

/**
 * Build the body of a completion_report by enriching evaluator output
 * with commit metadata. If evaluator returned JSON, the `commits` and
 * `commit` fields are merged in; if it returned plain text, the metadata
 * is appended as human-readable tag lines (legacy fallback).
 *
 * The new `commits` envelope carries BOTH the project worktree commit
 * and the CO root docs commit so Leader can propagate them as
 * upstream_commits to the next link's task. Legacy `commit` field is
 * retained alongside for backward-compatible parsers.
 */
export function buildCompletionBody(args: {
  evalContent: string;
  commit: CommitResult | null;
  docsSha: string | null;
  worktreeBranch: string;
}): string {
  const { evalContent, commit, docsSha, worktreeBranch } = args;
  if (!commit && !docsSha) return evalContent;
  try {
    const json = JSON.parse(evalContent);
    json.commits = {
      worktree: commit?.sha ?? null,
      docs: docsSha,
      branch: worktreeBranch,
    };
    if (commit) {
      json.commit = {
        sha: commit.sha,
        message: commit.message,
        branch: worktreeBranch,
        changed_files: commit.changed_files,
        untracked_files: commit.untracked_files,
      };
    }
    return JSON.stringify(json);
  } catch {
    const tag = commit
      ? `\nCommit: ${commit.sha.slice(0, 7)} - ${commit.message}`
      : "";
    const docsTag = docsSha ? `\nDocs commit: ${docsSha.slice(0, 7)}` : "";
    return evalContent + tag + docsTag;
  }
}

/**
 * Build the payload for the forced-feedback completion_report sent when
 * a commit failure prevents the link from producing a valid artifact.
 * Skips the self-evaluator entirely so an LLM hallucination cannot
 * promote broken work to activate_next. Targets the same worker
 * (self-retry of the same link) — Leader's chain-router treats it like
 * any other feedback dispatch, subject to the retry ceiling.
 */
export function buildForcedFeedbackDecision(args: {
  link: TaskLink;
  taskId: TaskId;
  instanceId: InstanceId;
  stderr: string;
}): {
  decision: "feedback";
  reason: string;
  feedback_to_worker: string;
  feedback_target: InstanceId;
} {
  const { link, taskId, instanceId, stderr } = args;
  return {
    decision: "feedback",
    reason: `commit failed at ${link}: ${stderr.slice(0, 200) || "unknown error"}`,
    feedback_to_worker: `git commit failed for ${link} task ${taskId}. Diagnose with 'git status' / 'git diff' in the worktree, resolve the issue, then re-run.`,
    feedback_target: instanceId,
  };
}

export async function sendCompletionReport(args: {
  router: { send(input: SendMessageInput): Promise<Message> };
  identity: WorkerIdentity;
  link: TaskLink;
  msg: Message;
  resultPath: string;
  taskId: TaskId;
  body: string;
}): Promise<void> {
  const { router, identity, link, msg, resultPath, taskId, body } = args;
  await router.send({
    type: "completion_report",
    from_instance: identity.instance_id,
    from_name: identity.worker_name,
    from_role: identity.worker_role,
    to_instance: identity.leader_id,
    content: body,
    link,
    task_id: taskId,
    chain_id: msg.chain_id ?? null,
    result_path: resultPath,
  });
}

export async function sendForcedFeedbackReport(args: {
  router: { send(input: SendMessageInput): Promise<Message> };
  identity: WorkerIdentity;
  link: TaskLink;
  msg: Message;
  resultPath: string;
  taskId: TaskId;
  stderr: string;
}): Promise<void> {
  const { router, identity, link, msg, resultPath, taskId, stderr } = args;
  const decision = buildForcedFeedbackDecision({
    link,
    taskId,
    instanceId: identity.instance_id,
    stderr,
  });
  await router.send({
    type: "completion_report",
    from_instance: identity.instance_id,
    from_name: identity.worker_name,
    from_role: identity.worker_role,
    to_instance: identity.leader_id,
    content: JSON.stringify(decision),
    link,
    task_id: taskId,
    chain_id: msg.chain_id ?? null,
    result_path: resultPath,
  });
}

export async function sendDecomposeReport(args: {
  router: { send(input: SendMessageInput): Promise<Message> };
  identity: WorkerIdentity;
  msg: Message;
  resultPath: string;
  taskId: TaskId;
}): Promise<void> {
  const { router, identity, msg, resultPath, taskId } = args;
  const content = await fs.promises.readFile(resultPath, "utf-8");
  await router.send({
    type: "completion_report",
    from_instance: identity.instance_id,
    from_name: identity.worker_name,
    from_role: identity.worker_role,
    to_instance: identity.leader_id,
    content,
    link: null,
    task_id: taskId,
    chain_id: msg.chain_id ?? null,
    result_path: resultPath,
  });
}
