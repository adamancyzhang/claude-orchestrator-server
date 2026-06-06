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
import type { WorkerActivityReporter } from "./activity-reporter.js";

/**
 * Type-level upper bound on every responsibility-chain link the schema
 * knows about. Used only where the static set matters (template name
 * lookup, type discrimination). Workers must NOT iterate this directly
 * for runtime "is this a chain link" checks — use `chainLinksFor(magic_mode)`
 * so `explore` is excluded in default mode (DD 02 §3.1).
 */
export const ALL_CHAIN_LINKS: readonly TaskLink[] = [
  "plan",
  "execute",
  "verify",
  "review",
  "accept",
  "explore",
] as const;

const DEFAULT_CHAIN_LINKS: readonly TaskLink[] = [
  "plan",
  "execute",
  "verify",
  "review",
  "accept",
] as const;

/**
 * Returns the runtime CHAIN_LINKS set the Worker should treat as
 * legitimate chain links. `--magic` mode adds `explore` as the 6th
 * link; default mode stops at `accept`.
 */
export function chainLinksFor(magicMode: boolean): readonly TaskLink[] {
  return magicMode ? ALL_CHAIN_LINKS : DEFAULT_CHAIN_LINKS;
}

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
  /**
   * Optional reporter for surfacing evaluation step actions (tool_use /
   * text / thinking) to the Leader. The watcher emits the surrounding
   * evaluate/phase_start and phase_end markers; this hook reports the
   * tool calls Claude makes while reading the result file etc.
   */
  activity_reporter?: WorkerActivityReporter;
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
      co_root: cachePaths.coRootDir(this.opts.cache_paths),
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
      const reporter = this.opts.activity_reporter;
      if (reporter && attempt > 0) {
        reporter.report({
          phase: "evaluate",
          action: "retry",
          detail: `attempt ${attempt + 1}/${MAX_RETRIES}`,
          link: input.link,
          task_id: input.task_id,
        });
      }
      await this.opts.runner.run({
        prompt,
        log_path: evalLogPath,
        system_prompt: this.opts.identity_system_prompt,
        resume_session_id: input.resume_session_id,
        fork_session: true,
        quiet: true,
        on_chunk: reporter
          ? (chunk) => {
              const e = chunk.event;
              if (!e) return;
              if (e.kind === "tool_use") {
                reporter.report({
                  phase: "evaluate",
                  action: "tool_use",
                  detail: `${e.tool}: ${e.summary}`.slice(0, 120),
                  link: input.link,
                  task_id: input.task_id,
                });
              } else if (e.kind === "thinking") {
                reporter.report({
                  phase: "evaluate",
                  action: "thinking",
                  detail: "thinking…",
                  link: input.link,
                  task_id: input.task_id,
                });
              }
            }
          : undefined,
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
