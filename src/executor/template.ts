import * as fs from "node:fs";
import path from "node:path";
import { Logger } from "../utils/logger.js";

const LINK_TEMPLATES = ["plan", "build", "verify", "review", "accept", "decompose"];

export class TemplateEngine {
  private templates: Record<string, string> = {};
  private logger = new Logger("TemplateEngine");

  constructor(
    private agentsDir: string,
    private builtinDir?: string,
  ) {}

  private async readTemplate(filename: string): Promise<string> {
    try {
      return await fs.promises.readFile(
        path.join(this.agentsDir, filename), "utf-8",
      );
    } catch {
      if (this.builtinDir) {
        return fs.promises.readFile(
          path.join(this.builtinDir, filename), "utf-8",
        );
      }
      throw new Error(`Template ${filename} not found in ${this.agentsDir}`);
    }
  }

  async loadAll(): Promise<void> {
    for (const link of LINK_TEMPLATES) {
      this.templates[link] = await this.readTemplate(`worker-${link}.md`);
    }
  }

  get(link: string): string | undefined {
    return this.templates[link];
  }

  async loadFile(filename: string): Promise<string> {
    return this.readTemplate(filename);
  }

  render(template: string, vars: Record<string, string>): string {
    let body = template;
    for (const [key, value] of Object.entries(vars)) {
      body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
    return body;
  }
}

export { LINK_TEMPLATES };
