import { z } from "zod";
import {
  asInstanceId,
  asTaskId,
  asWorktreeName,
  type InstanceId,
  type TaskId,
  type WorktreeName,
} from "../ids.js";
import {
  InstanceRoleSchema,
  InstanceStatusSchema,
  type InstanceRole,
} from "../enums.js";

export const InstanceSchema = z.object({
  id: z.string().transform(asInstanceId),
  name: z.string(),
  role: InstanceRoleSchema.default("builder"),
  status: InstanceStatusSchema.default("idle"),
  current_task_id: z.string().transform(asTaskId).nullable().default(null),
  connected_since: z.string(),
  work_dir: z.string().nullable().default(null),
  worktree_name: z.string().transform(asWorktreeName).nullable().default(null),
  worktree_path: z.string().nullable().default(null),
  worktree_branch: z.string().nullable().default(null),
  pid: z.number().int().nullable().default(null),
  protocol_version: z.string(),
});
export type Instance = z.infer<typeof InstanceSchema>;

export interface CreateInstanceInput {
  id?: InstanceId;
  name: string;
  role?: InstanceRole;
  work_dir?: string | null;
  worktree_name?: WorktreeName | null;
  worktree_path?: string | null;
  worktree_branch?: string | null;
  pid?: number | null;
  current_task_id?: TaskId | null;
}
