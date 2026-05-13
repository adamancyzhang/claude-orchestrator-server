import * as fs from "node:fs";
import { TemplateEngine } from "../executor/template.js";
import { ClaudeRunner } from "../executor/runner.js";
import { Logger } from "../utils/logger.js";
import { EvalDecisionSchema } from "../models/schemas.js";
import { extractJson } from "../utils/json.js";

const CHAIN_LINKS = ["plan", "build", "verify", "review", "accept"];
const MAX_RETRIES = 3;

const NEXT_LINKS: Record<string, string | null> = {
  plan: "build", build: "verify", verify: "review",
  review: "accept", accept: null,
};

export class SelfEvaluator {
  private logger = new Logger("SelfEvaluator");
  private formatHintTemplate: string | null = null;

  constructor(
    private templateEngine: TemplateEngine,
    private runner: ClaudeRunner,
  ) {}

  async evaluate(
    link: string,
    msgVars: Record<string, string>,
    taskResultPath: string,
    uniqueKey: string,
    resumeSessionId?: string,
  ): Promise<string> {
    const evalTemplate = await this.templateEngine.loadFile("worker-evaluate.md");

    const baseVars = {
      link,
      task_result_path: taskResultPath,
      work_dir: "",
      time: new Date().toISOString(),
      ...msgVars,
    };

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const attemptKey = `${uniqueKey}-${attempt}`;
      const evalResultPath = this.runner.evalResultPath(attemptKey);
      const evalLogPath = this.runner.evalLogPath(attemptKey);

      let prompt = this.templateEngine.render(evalTemplate, {
        ...baseVars,
        result_path: evalResultPath,
      });

      if (attempt > 0) {
        if (this.formatHintTemplate === null) {
          this.formatHintTemplate = await this.templateEngine.loadFile("worker-evaluate-format-hint.md");
        }
        prompt += "\n\n" + this.formatHintTemplate;
      }

      this.logger.info(`Self-evaluation attempt ${attempt + 1}/${MAX_RETRIES}...`);
      await this.runner.run(prompt, evalLogPath, {
        systemPrompt: this.runner.buildIdentityPrompt(),
        resumeSessionId,
        forkSession: true,
      });

      try {
        const content = await fs.promises.readFile(evalResultPath, "utf-8");
        if (!content.trim()) continue;

        const parsed = JSON.parse(extractJson(content));
        const validated = EvalDecisionSchema.parse(parsed);
        return JSON.stringify(validated);
      } catch (err) {
        this.logger.error(`Attempt ${attempt + 1} invalid`, err);
      }
    }

    this.logger.error(`All ${MAX_RETRIES} evaluation attempts failed, using fallback`);

    const nextLink = NEXT_LINKS[link];
    if (nextLink) {
      return JSON.stringify({
        decision: "activate_next",
        reason: `Auto-advance from ${link} (after ${MAX_RETRIES} eval failures)`,
        nextLink,
      });
    }
    return JSON.stringify({
      decision: "close_chain",
      reason: `Accept link completed (after ${MAX_RETRIES} eval failures)`,
    });
  }
}

export { CHAIN_LINKS };
