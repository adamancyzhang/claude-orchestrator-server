import * as fs from "node:fs";
import path from "node:path";
import { Logger } from "../utils/logger.js";

const BUSINESS_CARD = `## Worker Identity

You are **{{name}}**, a **{{preset_role}}** in the multi-agent orchestration system.

- Name: {{name}}
- Role: {{preset_role}}
- Worktree: {{worktree_path}}
- Branch: {{worktree_branch}}
- Instance: {{instance_id}}

---
`;

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
    let body = template;
    for (const [key, value] of Object.entries(vars)) {
      body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    const card = BUSINESS_CARD
      .replace(/\{\{name\}\}/g, vars.name ?? "unknown")
      .replace(/\{\{preset_role\}\}/g, vars.preset_role ?? "unknown")
      .replace(/\{\{worktree_path\}\}/g, vars.worktree_path ?? "")
      .replace(/\{\{worktree_branch\}\}/g, vars.worktree_branch ?? "")
      .replace(/\{\{instance_id\}\}/g, vars.instance_id ?? "");

    return card + body;
  }
}

export { LINK_TEMPLATES };
