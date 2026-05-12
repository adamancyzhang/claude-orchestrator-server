import * as fs from "node:fs";
import * as path from "node:path";
import { ZkClient } from "../zk/client.js";
import { TaskQueue } from "../modules/task-queue.js";
import { expandHomeDir } from "../config.js";
import { execAndCapture } from "../utils/exec.js";

interface ChainTaskDef {
  title: string;
  description: string;
  criteria: string;
  priority: number;
}

interface ChainDef {
  chain_id: string;
  chain_title: string;
  tasks: {
    plan: ChainTaskDef | null;
    build: ChainTaskDef;
    verify: ChainTaskDef;
    review: ChainTaskDef;
    accept: ChainTaskDef;
  };
}

export class TaskGenerator {
  private template: string | null = null;
  private templatePath: string;

  constructor(
    private zk: ZkClient,
    private taskQueue: TaskQueue,
    private command: string,
    private cacheDir: string,
    private leaderInstanceId: string,
    templatePath?: string,
  ) {
    this.templatePath = templatePath ?? path.join(process.cwd(), ".claude-orchestrator", "agents", "leader-decompose.md");
  }

  private async loadTemplate(): Promise<string> {
    if (this.template) return this.template;
    try {
      this.template = await fs.promises.readFile(this.templatePath, "utf-8");
    } catch {
      throw new Error(`Decompose template not found at ${this.templatePath}. Run setup first.`);
    }
    return this.template;
  }

  async decompose(requirement: string, teamStatus: object): Promise<ChainDef[]> {
    const template = await this.loadTemplate();

    const prompt = template
      .replace("{{team_status}}", JSON.stringify(teamStatus, null, 2))
      .replace("{{content}}", requirement);

    const uniqueKey = `decompose-${Date.now().toString(36)}`;
    const resolvedCacheDir = expandHomeDir(path.join(this.cacheDir, this.leaderInstanceId));
    const logPath = path.join(resolvedCacheDir, `${uniqueKey}.log`);

    const { stdout } = await execAndCapture(this.command, prompt, logPath);
    const chains = this.parseOutput(stdout);

    for (const chain of chains) {
      await this.pushChain(chain, resolvedCacheDir);
    }

    return chains;
  }

  private async pushChain(chain: ChainDef, resolvedCacheDir: string): Promise<void> {
    const taskLinks: Array<{ link: string; def: ChainTaskDef }> = [];
    if (chain.tasks.plan) taskLinks.push({ link: "plan", def: chain.tasks.plan });
    taskLinks.push({ link: "build", def: chain.tasks.build });
    taskLinks.push({ link: "verify", def: chain.tasks.verify });
    taskLinks.push({ link: "review", def: chain.tasks.review });
    taskLinks.push({ link: "accept", def: chain.tasks.accept });

    for (const { link, def } of taskLinks) {
      const task = await this.taskQueue.push(
        def.title,
        def.description,
        def.priority,
        "",
        undefined,
        undefined,
        null,
        link,
        chain.chain_id,
      );

      const docPath = path.join(resolvedCacheDir, "tasks", `${task.id}.md`);
      await fs.promises.mkdir(path.dirname(docPath), { recursive: true });
      await fs.promises.writeFile(docPath,
        `# ${def.title}\n\n` +
        `**Link**: ${link}\n` +
        `**Chain**: ${chain.chain_id}\n` +
        `**Priority**: ${def.priority}\n\n` +
        `## Description\n\n${def.description}\n\n` +
        `## Completion Criteria\n\n${def.criteria}\n`,
      );
    }
  }

  private parseOutput(output: string): ChainDef[] {
    let cleaned = output
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      const results: ChainDef[] = [];
      const matches = cleaned.match(/\{[\s\S]*?\}(?=\s*\{|\s*$)/g);
      if (matches) {
        for (const m of matches) {
          try { results.push(JSON.parse(m)); } catch { /* skip */ }
        }
      }
      if (results.length === 0) throw new Error("Failed to parse Claude output as task chain JSON");
      return results;
    }
  }
}
