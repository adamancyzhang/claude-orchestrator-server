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

export const TaskSchema = z.object({
  id: z.string().transform(asTaskId).default(""),
  title: z.string(),
  description: z.string().default(""),
  criteria: z.string().default(""),
  priority: TaskPrioritySchema.default(1),
  status: TaskStatusSchema.default("pending"),
  link: TaskLinkSchema.nullable().default(null),
  chain_id: z.string().transform(asChainId).nullable().default(null),
  task_doc_path: z.string().nullable().default(null),
  result_path: z.string().nullable().default(null),
  retry_count: z.number().int().min(0).default(0),
  depends_on: z.array(z.string().transform(asTaskId)).default([]),
  blocked_by: z.array(z.string().transform(asTaskId)).default([]),
  blocked_reason: z.string().nullable().default(null),
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
});
export type Task = z.infer<typeof TaskSchema>;

export interface CreateTaskInput {
  title: string;
  description?: string;
  criteria?: string;
  priority?: TaskPriority;
  link?: TaskLink | null;
  chain_id?: ChainId | null;
  task_doc_path?: string | null;
  result_path?: string | null;
  depends_on?: readonly TaskId[];
  blocked_by?: readonly TaskId[];
  created_by?: InstanceId | null;
  created_by_name?: string;
  assigned_to?: InstanceId | null;
  assigned_to_name?: string | null;
  leader_only?: boolean;
}

export interface ClaimRecord {
  task_id: TaskId;
  instance_id: InstanceId;
  claimed_at: string;
  task_snapshot?: Task;
}
