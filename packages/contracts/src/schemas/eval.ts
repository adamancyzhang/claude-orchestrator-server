import { z } from "zod";
import { asInstanceId } from "../ids.js";
import { TaskLinkSchema } from "../enums.js";

export const EvalDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("activate_next"),
    reason: z.string(),
    next_link: TaskLinkSchema,
    suggested_worker: z
      .string()
      .transform(asInstanceId)
      .nullable()
      .optional(),
  }),
  z.object({
    decision: z.literal("feedback"),
    reason: z.string(),
    feedback_to_worker: z.string(),
    feedback_target: z
      .string()
      .transform(asInstanceId)
      .nullable()
      .optional(),
  }),
  z.object({
    decision: z.literal("reject"),
    reason: z.string(),
  }),
  z.object({
    decision: z.literal("close_chain"),
    reason: z.string(),
  }),
]);
export type EvalDecision = z.infer<typeof EvalDecisionSchema>;
