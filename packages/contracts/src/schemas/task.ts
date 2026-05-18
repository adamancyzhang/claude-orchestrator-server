import { z } from "zod";
import {
  asInstanceId,
  asTaskId,
  asChainId,
  type ChainId,
  type InstanceId,
  type TaskId,
} from "../ids.js";
import {
  TaskLinkSchema,
  TaskPrioritySchema,
  TaskStatusSchema,
  type TaskLink,
  type TaskPriority,
} from "../enums.js";

/**
 * Per-link commit hashes for upstream artifacts, addressed to the
 * downstream link of a chain. Each entry references the Worker's
 * project-repo commit produced when that link completed. The downstream
 * Worker rebases its worktree onto the immediate predecessor's hash
 * before starting work, so the final accept-link branch contains the
 * full chain history linearly.
 */
export const UpstreamCommitsSchema = z.object({
  plan: z.string().nullable().optional(),
  execute: z.string().nullable().optional(),
  verify: z.string().nullable().optional(),
  review: z.string().nullable().optional(),
  accept: z.string().nullable().optional(),
});
export type UpstreamCommits = z.infer<typeof UpstreamCommitsSchema>;

export const TaskSchema = z.object({
  id: z.string().transform(asTaskId).default(""),
  title: z.string(),
  description: z.string().default(""),
  criteria: z.string().default(""),
  priority: TaskPrioritySchema.default(1),
  status: TaskStatusSchema.default("pending"),
  link: TaskLinkSchema.nullable().default(null),
  chain_id: z.string().transform(asChainId).nullable().default(null),
  result_path: z.string().nullable().default(null),
  retry_count: z.number().int().min(0).default(0),
  fail_reason: z.string().nullable().default(null),
  created_by: z.string().transform(asInstanceId).nullable().default(null),
  created_by_name: z.string().default(""),
  assigned_to: z.string().transform(asInstanceId).nullable().default(null),
  assigned_to_name: z.string().nullable().default(null),
  claimed_by: z.string().transform(asInstanceId).nullable().default(null),
  completed_by_name: z.string().nullable().default(null),
  created_at: z.string(),
  claimed_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
  duration_seconds: z.number().nullable().default(null),
  leader_only: z.boolean().default(false),
  result: z.string().nullable().default(null),
  upstream_commits: UpstreamCommitsSchema.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export interface CreateTaskInput {
  title: string;
  description?: string;
  criteria?: string;
  priority?: TaskPriority;
  link?: TaskLink | null;
  chain_id?: ChainId | null;
  result_path?: string | null;
  retry_count?: number;
  created_by?: InstanceId | null;
  created_by_name?: string;
  assigned_to?: InstanceId | null;
  assigned_to_name?: string | null;
  leader_only?: boolean;
  upstream_commits?: UpstreamCommits;
}

export interface ClaimRecord {
  task_id: TaskId;
  instance_id: InstanceId;
  claimed_at: string;
  task_snapshot?: Task;
}
