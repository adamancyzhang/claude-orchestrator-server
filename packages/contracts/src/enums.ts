import { z } from "zod";

export const InstanceStatusSchema = z.enum(["idle", "busy"]);
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;

export const InstanceRoleSchema = z.enum([
  "planner",
  "builder",
  "verifier",
  "reviewer",
  "accepter",
  "leader",
]);
export type InstanceRole = z.infer<typeof InstanceRoleSchema>;

export const TaskLinkSchema = z.enum(["plan", "build", "verify", "review", "accept"]);
export type TaskLink = z.infer<typeof TaskLinkSchema>;

export const TaskStatusSchema = z.enum([
  "pending",
  "claimed",
  "completed",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.number().int().min(0).max(2);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const MessageTypeSchema = z.enum([
  "direct",
  "broadcast",
  "task_dispatch",
  "completion_report",
  "user_input",
  "help",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const EvalDecisionKindSchema = z.enum([
  "activate_next",
  "feedback",
  "reject",
  "close_chain",
]);
export type EvalDecisionKind = z.infer<typeof EvalDecisionKindSchema>;

export const MergeDecisionKindSchema = z.enum(["merge", "skip", "review_first"]);
export type MergeDecisionKind = z.infer<typeof MergeDecisionKindSchema>;
