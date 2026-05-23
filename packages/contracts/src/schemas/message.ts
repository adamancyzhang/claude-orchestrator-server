import { z } from "zod";
import {
  asInstanceId,
  asMessageId,
  asTaskId,
  asChainId,
  type ChainId,
  type InstanceId,
  type MessageId,
  type TaskId,
} from "../ids.js";
import {
  MessageTypeSchema,
  TaskLinkSchema,
  type MessageType,
  type TaskLink,
} from "../enums.js";
import { UpstreamCommitsSchema, type UpstreamCommits } from "./task.js";

export const MessageSchema = z.object({
  id: z.string().transform(asMessageId).default(""),
  type: MessageTypeSchema.default("direct"),
  from_instance: z.string().transform(asInstanceId),
  from_name: z.string(),
  from_role: z.string().default(""),
  to_instance: z.string().transform(asInstanceId).nullable().default(null),
  to_name: z.string().nullable().default(null),
  content: z.string(),
  link: TaskLinkSchema.nullable().default(null),
  task_id: z.string().transform(asTaskId).nullable().default(null),
  chain_id: z.string().transform(asChainId).nullable().default(null),
  task_title: z.string().nullable().default(null),
  task_description: z.string().nullable().default(null),
  task_criteria: z.string().nullable().default(null),
  result_path: z.string().nullable().default(null),
  original_requirement_path: z.string().nullable().default(null),
  reply_to: z.string().transform(asMessageId).nullable().default(null),
  read: z.boolean().default(false),
  created_at: z.string(),
  upstream_commits: UpstreamCommitsSchema.optional(),
  // populated when this user_input message was injected by
  // ChainRouter on a `spawn_chain` decision. `spawned_from` points at
  // the parent chain id; `next_requirement` is the Explorer-authored
  // requirement that bootstraps the child chain.
  spawned_from: z.string().transform(asChainId).optional(),
  next_requirement: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export interface SendMessageInput {
  type: MessageType;
  from_instance: InstanceId;
  from_name: string;
  from_role?: string;
  to_instance: InstanceId | null;
  to_name?: string | null;
  content: string;
  link?: TaskLink | null;
  task_id?: TaskId | null;
  chain_id?: ChainId | null;
  task_title?: string | null;
  task_description?: string | null;
  task_criteria?: string | null;
  result_path?: string | null;
  original_requirement_path?: string | null;
  reply_to?: MessageId | null;
  upstream_commits?: UpstreamCommits;
  spawned_from?: ChainId;
  next_requirement?: string;
}
