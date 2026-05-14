import { z } from "zod";
import { MergeDecisionKindSchema } from "../enums.js";

export const MergeDecisionSchema = z.object({
  decision: MergeDecisionKindSchema,
  reason: z.string(),
  conflict_files: z.array(z.string()).default([]),
  reviewed_branches: z.array(z.string()).default([]),
});
export type MergeDecision = z.infer<typeof MergeDecisionSchema>;
