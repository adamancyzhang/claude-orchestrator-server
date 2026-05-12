import * as fs from "node:fs";
import { TemplateEngine } from "../executor/template.js";
import { ClaudeRunner } from "../executor/runner.js";
import { Logger } from "../utils/logger.js";
import { EvalDecisionSchema } from "../models/schemas.js";

const CHAIN_LINKS = ["plan", "build", "verify", "review", "accept"];
const MAX_RETRIES = 3;

const NEXT_LINKS: Record<string, string | null> = {
  plan: "build", build: "verify", verify: "review",
  review: "accept", accept: null,
};

export class SelfEvaluator {
  private logger = new Logger("SelfEvaluator");

  constructor(
    private templateEngine: TemplateEngine,
    private runner: ClaudeRunner,
    private instanceName: string,
    private instanceRole: string,
  ) {}

  async evaluate(
    link: string,
    msgVars: Record<string, string>,
    taskResultPath: string,
    uniqueKey: string,
  ): Promise<string> {
    let evalTemplate: string;
    try {
      evalTemplate = await this.templateEngine.loadFile("worker-evaluate.md");
    } catch {
      evalTemplate = [
        `You are {{name}}, a Worker with role {{preset_role}}.`,
        `Evaluate your own output for the {{link}} task and decide the next step.`,
        ``,
        `## Task`,
        `- **Title**: {{task_title}}`,
        `- **Description**: {{task_description}}`,
        `- **Criteria**: {{task_criteria}}`,
        ``,
        `## Your Result`,
        `Read the result from {{task_result_path}}.`,
        ``,
        `## Output Format`,
        `Write the evaluation result to {{result_path}}. Output exactly one JSON decision:`,
        `\`\`\`json`,
        `{"decision": "activate_next" | "feedback" | "close_chain", "reason": "...", "nextLink": "build|verify|review|accept"}`,
        `\`\`\``,
        `Output ONLY the JSON.`,
      ].join("\n");
    }

    const baseVars = {
      name: this.instanceName,
      preset_role: this.instanceRole,
      link,
      task_result_path: taskResultPath,
      work_dir: "",
      time: new Date().toISOString(),
      ...msgVars,
    };

    const formatHint = [
      ``,
      `## IMPORTANT: Format Correction`,
      `Your previous output was invalid JSON or did not match the required schema.`,
      `You MUST output ONLY valid JSON with exactly these fields:`,
      `\`\`\`json`,
      `{"decision": "activate_next"|"feedback"|"close_chain", "reason": "<string>", "nextLink": "<string>", "feedback": "<string>"}`,
      `\`\`\``,
      `No markdown fences, no extra text, no trailing commas. Pure JSON only.`,
    ].join("\n");

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const attemptKey = `${uniqueKey}-${attempt}`;
      const evalResultPath = this.runner.evalResultPath(attemptKey);
      const evalLogPath = this.runner.evalLogPath(attemptKey);

      let prompt = this.templateEngine.render(evalTemplate, {
        ...baseVars,
        result_path: evalResultPath,
      });

      if (attempt > 0) {
        prompt += formatHint;
      }

      this.logger.info(`Self-evaluation attempt ${attempt + 1}/${MAX_RETRIES}...`);
      await this.runner.run(prompt, evalLogPath);

      try {
        const content = await fs.promises.readFile(evalResultPath, "utf-8");
        if (!content.trim()) continue;

        const cleaned = content.trim()
          .replace(/```json\s*/g, "")
          .replace(/```\s*/g, "")
          .trim();

        const parsed = JSON.parse(cleaned);
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
