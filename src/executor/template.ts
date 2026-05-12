import * as fs from "node:fs";
import path from "node:path";
import { Logger } from "../utils/logger.js";

const LINK_TEMPLATES = ["plan", "build", "verify", "review", "accept", "decompose"];

export class TemplateEngine {
  private templates: Record<string, string> = {};
  private logger = new Logger("TemplateEngine");

  constructor(private agentsDir: string) {}

  async loadAll(): Promise<void> {
    for (const link of LINK_TEMPLATES) {
      try {
        this.templates[link] = await fs.promises.readFile(
          path.join(this.agentsDir, `worker-${link}.md`), "utf-8",
        );
      } catch {
        this.templates[link] = `You are a Worker.\n\n## Task\n\n{{content}}`;
      }
    }
  }

  get(link: string): string | undefined {
    return this.templates[link];
  }

  async loadFile(filename: string): Promise<string> {
    try {
      return await fs.promises.readFile(
        path.join(this.agentsDir, filename), "utf-8",
      );
    } catch {
      throw new Error(`Template ${filename} not found in ${this.agentsDir}`);
    }
  }

  render(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
    return result;
  }
}

export { LINK_TEMPLATES };
