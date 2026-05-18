import * as fs from "node:fs";
import {
  EvalDecisionSchema,
  ValidationError,
  cachePaths,
  type IClaudeRunner,
  type ILogger,
  type ITemplateEngine,
  type InstanceId,
  type SessionId,
  type TaskId,
  type TaskLink,
} from "@co/contracts";
import { extractJson } from "@co/runtime";

export const CHAIN_LINKS: readonly TaskLink[] = [
  "plan",
  "execute",
  "verify",
  "review",
  "accept",
  "explore",
] as const;

const MAX_RETRIES = 3;

export interface SelfEvaluatorOptions {
  runner: IClaudeRunner;
  template_engine: ITemplateEngine;
  logger: ILogger;
  cache_paths: cachePaths.CachePathOptions;
  worktree_path: string;
  identity_system_prompt: string;
  worker_name: string;
  worker_role: string;
}

export interface EvaluateInput {
  link: TaskLink;
  task_id: TaskId;
  msg_vars: Record<string, string>;
  task_result_path: string;
  resume_session_id?: SessionId;
}

export class SelfEvaluator {
  constructor(private readonly opts: SelfEvaluatorOptions) {}

  async evaluate(input: EvaluateInput): Promise<string> {
    let formatHint: string | null = null;
    const baseVars = {
      name: this.opts.worker_name,
      role: this.opts.worker_role,
      link: input.link,
      task_result_path: input.task_result_path,
      work_dir: this.opts.worktree_path,
      time: new Date().toISOString(),
      ...input.msg_vars,
    };

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const evalLogPath = cachePaths.evalLogPath(
        this.opts.cache_paths,
        input.task_id,
        attempt,
      );
      const evalResultPath = `${evalLogPath}.result.md`;

      let prompt = this.opts.template_engine.render("worker-evaluate.md", {
        ...baseVars,
        result_path: evalResultPath,
      });

      if (attempt > 0) {
        if (formatHint === null) {
          formatHint = this.opts.template_engine.load(
            "worker-evaluate-format-hint.md",
          );
        }
        prompt += "\n\n" + formatHint;
      }

      this.opts.logger.info(`self-evaluation attempt ${attempt + 1}/${MAX_RETRIES}`);
      await this.opts.runner.run({
        prompt,
        log_path: evalLogPath,
        system_prompt: this.opts.identity_system_prompt,
        resume_session_id: input.resume_session_id,
        fork_session: true,
        quiet: true,
      });

      try {
        const content = await fs.promises.readFile(evalResultPath, "utf-8");
        if (!content.trim()) continue;
        const parsed = EvalDecisionSchema.safeParse(JSON.parse(extractJson(content)));
        if (!parsed.success) {
          throw new ValidationError("EvalDecision schema mismatch", parsed.error);
        }
        return JSON.stringify(parsed.data);
      } catch (err) {
        this.opts.logger.warn(`attempt ${attempt + 1} parse failure`, {
          error: String(err),
        });
      }
    }

    // Fallback when self-evaluation cannot produce a schema-valid JSON in
    // MAX_RETRIES attempts. We deliberately emit `reject` (never
    // `activate_next` / `close_chain`) so an unreliable evaluator never
    // silently advances the chain — that would invert the quality gate at
    // the accept link in particular. Leader's chain_router routes `reject`
    // to chain abort with full audit.
    this.opts.logger.error(
      `all ${MAX_RETRIES} eval attempts failed — emitting reject`,
    );
    return JSON.stringify({
      decision: "reject",
      reason: `self-evaluation failed after ${MAX_RETRIES} attempts (link=${input.link}) — see eval logs`,
    });
  }

  static instanceFor(_: InstanceId): null {
    return null;
  }
}
