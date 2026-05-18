import { z } from "zod";
import { asInstanceId } from "../ids.js";
import { TaskLinkSchema } from "../enums.js";

/**
 * The two commit hashes a Worker reports after finishing a chain-link
 * task. `worktree` is the project-repo commit (Worker's per-name branch);
 * `docs` is the CO root commit covering `docs/<worker>/...`. Either may
 * be null when nothing changed in that repo.
 */
export const CompletionCommitsSchema = z.object({
  worktree: z.string().nullable(),
  docs: z.string().nullable(),
  branch: z.string(),
});
export type CompletionCommits = z.infer<typeof CompletionCommitsSchema>;

const commitsField = CompletionCommitsSchema.optional();

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
    commits: commitsField,
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
    commits: commitsField,
  }),
  z.object({
    decision: z.literal("reject"),
    reason: z.string(),
    commits: commitsField,
  }),
  z.object({
    decision: z.literal("close_chain"),
    reason: z.string(),
    commits: commitsField,
  }),
  // v0.7 NEW — spawn_chain: only legal at the `explore` link when
  // magic_mode=true. Carries the next requirement that bootstraps the
  // child chain.
  z.object({
    decision: z.literal("spawn_chain"),
    reason: z.string(),
    next_requirement: z.string().min(1),
    commits: commitsField,
  }),
]);
export type EvalDecision = z.infer<typeof EvalDecisionSchema>;
