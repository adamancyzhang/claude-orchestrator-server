import {
  TemplateNotFoundError,
  type ITemplateEngine,
  type Message,
  type TaskLink,
} from "@co/contracts";
import type { ChainArtifactPaths } from "./chain-artifacts.js";

/**
 * Per-link user-message template. The system prompt (identity + standing
 * role description) is loaded once at boot in child-boot.ts; these
 * templates only carry the per-task body — task metadata, upstream
 * artifact paths, output contract, retry hint.
 */
export const LINK_TO_TASK_TEMPLATE: Record<TaskLink | "decompose", string> = {
  plan: "agents/planner/task.md",
  execute: "agents/executor/task.md",
  verify: "agents/verifier/task.md",
  review: "agents/reviewer/task.md",
  accept: "agents/accepter/task.md",
  explore: "agents/explorer/task.md",
  decompose: "workflow/decompose.md",
};

export interface BuildWorkerTaskPromptArgs {
  template_engine: ITemplateEngine;
  link: TaskLink | "decompose" | null;
  msg: Message;
  worker_name: string;
  worker_role: string;
  worktree_path: string;
  result_path: string;
  local_doc_path: string;
  unique_key: string;
  date: string;
  retry_hint: string;
  chain_artifacts: ChainArtifactPaths;
  co_root: string;
  workspace_memory_path: string;
  /** Inject for deterministic tests. Defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Build the per-task prompt string for a worker.
 *
 * - link === null: ad-hoc message; return msg.content verbatim.
 * - link !== null: render the per-link template with all task / upstream
 *   variables. Throws TemplateNotFoundError when the template is missing
 *   (NOT a silent fallback to msg.content — that would mask a config
 *   error and ship the worker a degraded prompt).
 *
 * Variable contract for the template:
 *   {{name}} {{role}} {{date}} {{unique_key}}
 *   {{task_title}} {{task_description}} {{task_criteria}}
 *   {{result_path}} {{local_doc_path}} {{work_dir}} {{time}}
 *   {{content}} {{original_requirement_path}}
 *   {{upstream_<link>_artifact}} x5 (plan/execute/verify/review/accept)
 *   {{upstream_<link>_commit}}   x5 (same set)
 *   {{co_root}} {{workspace_memory_path}}
 *   {{retry_hint}}
 *
 * Empty upstream commits / artifacts are passed as the empty string
 * (NOT silently dropped) — the template author chose how to handle "".
 */
export function buildWorkerTaskPrompt(args: BuildWorkerTaskPromptArgs): string {
  const {
    template_engine,
    link,
    msg,
    worker_name,
    worker_role,
    worktree_path,
    result_path,
    local_doc_path,
    unique_key,
    date,
    retry_hint,
    chain_artifacts,
    co_root,
    workspace_memory_path,
  } = args;

  if (!link) return msg.content;

  const tplName = LINK_TO_TASK_TEMPLATE[link];
  if (!template_engine.has(tplName)) {
    throw new TemplateNotFoundError(tplName);
  }
  const upstreamCommits = msg.upstream_commits ?? {};
  const now = (args.now ?? (() => new Date().toISOString()))();
  return template_engine.render(tplName, {
    name: worker_name,
    role: worker_role,
    date,
    unique_key,
    task_title: msg.task_title ?? "",
    task_description: msg.task_description ?? msg.content,
    task_criteria: msg.task_criteria ?? "",
    result_path,
    local_doc_path,
    work_dir: worktree_path,
    time: now,
    content: msg.content,
    original_requirement_path: msg.original_requirement_path ?? "",
    upstream_plan_artifact: chain_artifacts.plan,
    upstream_execute_artifact: chain_artifacts.execute,
    upstream_verify_artifact: chain_artifacts.verify,
    upstream_review_artifact: chain_artifacts.review,
    upstream_accept_artifact: chain_artifacts.accept,
    upstream_plan_commit: upstreamCommits.plan ?? "",
    upstream_execute_commit: upstreamCommits.execute ?? "",
    upstream_verify_commit: upstreamCommits.verify ?? "",
    upstream_review_commit: upstreamCommits.review ?? "",
    upstream_accept_commit: upstreamCommits.accept ?? "",
    co_root,
    workspace_memory_path,
    retry_hint,
  });
}
