import * as fs from "node:fs";
import path from "node:path";
import { ZkClient } from "../zk/client.js";
import * as paths from "../zk/paths.js";
import { MessageSchema } from "../models/schemas.js";
import { execWithTee } from "../utils/exec.js";
import { expandHomeDir } from "../config.js";

const LINK_TEMPLATES = ["plan", "build", "verify", "review", "accept"];

export class WorkerWatcher {
  private inFlight = new Set<string>();
  private templates: Record<string, string> = {};
  private instanceName = "";
  private instanceRole = "";
  stopped = false;

  constructor(
    private zk: ZkClient,
    private instanceId: string,
    private workDir: string,
    private command: string,
    private cacheDir: string,
    private leaderInstanceId: string,
  ) {}

  async start(): Promise<void> {
    // Load instance metadata
    const instData = await this.zk.getInstance(this.instanceId);
    this.instanceName = (instData?.name as string) ?? this.instanceId.slice(0, 8);
    this.instanceRole = (instData?.role as string) ?? "builder";

    // Load link templates from agents dir
    const agentsDir = path.join(this.workDir, ".claude-orchestrator", "agents");
    for (const link of LINK_TEMPLATES) {
      try {
        this.templates[link] = await fs.promises.readFile(
          path.join(agentsDir, `worker-${link}.md`), "utf-8",
        );
      } catch {
        this.templates[link] = `You are a Worker.\n\n## Task\n\n{{content}}`;
      }
    }

    await this.zk.mkdirp(paths.messageDirPath(this.instanceId));
    console.log(`Watching for messages on instance ${this.instanceId.slice(0, 8)}...`);
    console.log(`Work dir: ${this.workDir}`);
    console.log(`Command: ${this.command}`);
    console.log(`CACHE_DIR: ${path.join(expandHomeDir(this.cacheDir), this.leaderInstanceId)}`);
    console.log("Press Ctrl+C to stop.\n");
    this.watchLoop();
  }

  private async watchLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      const children = await this.zk.watchMessageDir(
        this.instanceId,
        (newChildren) => {
          for (const cid of newChildren) this.processMessage(cid);
          this.watchLoop();
        }
      );
      for (const cid of children) await this.processMessage(cid);
    } catch {
      if (!this.stopped) setTimeout(() => this.watchLoop(), 1000);
    }
  }

  private async processMessage(msgId: string): Promise<void> {
    if (this.inFlight.has(msgId) || this.stopped) return;
    const data = await this.zk.getMessage(this.instanceId, msgId);
    if (!data) return;
    const msg = MessageSchema.parse({ ...data, id: msgId });
    if (msg.read) return;

    this.inFlight.add(msgId);
    const fromLabel = msg.from_name || msg.from_instance?.slice(0, 8) || "unknown";
    const timestamp = new Date().toLocaleTimeString();
    const link = (msg.link as string) ?? "_generic";

    const uniqueKey = `task-${msgId}-${Date.now().toString(36)}`;
    const resolvedCacheDir = expandHomeDir(path.join(this.cacheDir, this.leaderInstanceId));
    const resultPath = path.join(resolvedCacheDir, `${uniqueKey}-result.md`);
    const logPath = path.join(resolvedCacheDir, `${uniqueKey}.log`);

    // Select and render template
    const template = this.templates[link];
    let prompt: string;
    if (template) {
      prompt = template
        .replace(/\{\{name\}\}/g, this.instanceName)
        .replace(/\{\{preset_role\}\}/g, this.instanceRole)
        .replace(/\{\{task_title\}\}/g, (msg.task_title as string) ?? "")
        .replace(/\{\{task_description\}\}/g, (msg.task_description as string) ?? msg.content)
        .replace(/\{\{task_criteria\}\}/g, (msg.task_criteria as string) ?? "")
        .replace(/\{\{task_doc_path\}\}/g, (msg.task_doc_path as string) ?? "")
        .replace(/\{\{result_path\}\}/g, resultPath)
        .replace(/\{\{work_dir\}\}/g, this.workDir)
        .replace(/\{\{time\}\}/g, new Date().toISOString())
        .replace(/\{\{content\}\}/g, msg.content);
    } else {
      prompt = msg.content;
    }

    console.log(`[Watcher] [${timestamp}] Message from ${fromLabel} (${msg.type}):`);
    console.log(`[Watcher]   ${msg.content.slice(0, 200)}`);
    if (link !== "_generic") {
      console.log(`[Watcher]   Link: ${link}`);
    }

    console.log(`[Watcher] [${timestamp}] Processing...`);
    await execWithTee(this.command, prompt, logPath, this.workDir);

    // Send completion report to leader (only for linked task messages)
    if (link !== "_generic") {
      try {
        const report = [
          `Link: ${link}`,
          `Status: completed`,
          `Result Path: ${resultPath}`,
          `Task completed. Leader, please review and decide next step.`,
        ].join("\n");

        await this.zk.createMessage(this.leaderInstanceId, {
          type: "direct",
          from_instance: this.instanceId,
          from_name: this.instanceName,
          from_role: this.instanceRole,
          to_instance: this.leaderInstanceId,
          content: report,
          created_at: new Date().toISOString(),
          read: false,
          result_path: resultPath,
          link,
        });
        console.log(`[Watcher] [${timestamp}] Completion report sent to Leader.`);
      } catch (err) {
        console.error(`[Watcher] [${timestamp}] Failed to send completion report: ${err}`);
      }
    }

    try {
      msg.read = true;
      await this.zk.updateMessage(this.instanceId, msgId, msg as unknown as Record<string, unknown>);
    } catch {
      // best effort
    }

    this.inFlight.delete(msgId);
    console.log(`[Watcher] [${timestamp}] Done. Log: ${logPath}`);
  }

  stop(): void {
    this.stopped = true;
  }
}
