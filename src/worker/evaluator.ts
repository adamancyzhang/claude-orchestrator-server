import * as fs from "node:fs";
import { TemplateEngine } from "../executor/template.js";
import { ClaudeRunner } from "../executor/runner.js";
import { Logger } from "../utils/logger.js";

const CHAIN_LINKS = ["plan", "build", "verify", "review", "accept"];

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

    const evalResultPath = this.runner.evalResultPath(uniqueKey);
    const evalLogPath = this.runner.evalLogPath(uniqueKey);

    const evalPrompt = this.templateEngine.render(evalTemplate, {
      name: this.instanceName,
      preset_role: this.instanceRole,
      link,
      task_result_path: taskResultPath,
      result_path: evalResultPath,
      work_dir: "",
      time: new Date().toISOString(),
      ...msgVars,
    });

    this.logger.info("Running self-evaluation...");
    await this.runner.run(evalPrompt, evalLogPath);

    try {
      const content = await fs.promises.readFile(evalResultPath, "utf-8");
      if (content.trim()) {
        try {
          JSON.parse(content.trim());
          return content.trim();
        } catch {
          // Not valid JSON
        }
      }
    } catch {
      // Evaluation result file not found or empty
    }

    const nextLink = NEXT_LINKS[link];
    if (nextLink) {
      return JSON.stringify({ decision: "activate_next", reason: `Auto-advance from ${link}`, nextLink });
    }
    return JSON.stringify({ decision: "close_chain", reason: "Accept link completed" });
  }
}

export { CHAIN_LINKS };
