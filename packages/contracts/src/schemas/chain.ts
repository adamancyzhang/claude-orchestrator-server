import { z } from "zod";
import { asChainId } from "../ids.js";
import { TaskPrioritySchema } from "../enums.js";

export const ChainTaskDefSchema = z.object({
  title: z.string(),
  description: z.string(),
  criteria: z.string(),
  priority: TaskPrioritySchema,
});
export type ChainTaskDef = z.infer<typeof ChainTaskDefSchema>;

export const ChainDefSchema = z.object({
  chain_id: z.string().transform(asChainId),
  chain_title: z.string(),
  tasks: z.object({
    plan: ChainTaskDefSchema.nullable(),
    build: ChainTaskDefSchema,
    verify: ChainTaskDefSchema,
    review: ChainTaskDefSchema,
    accept: ChainTaskDefSchema,
  }),
});
export type ChainDef = z.infer<typeof ChainDefSchema>;
