import path from "node:path";
import { ZkClient } from "../zk/client.js";
import * as paths from "../zk/paths.js";
import { MessageSchema } from "../models/schemas.js";
import { execWithTee } from "../utils/exec.js";
import { expandHomeDir } from "../config.js";

export class WorkerWatcher {
  private inFlight = new Set<string>();
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

    const uniqueKey = `${msg.type}-${msgId}-${Date.now().toString(36)}`;
    const resolvedCacheDir = expandHomeDir(path.join(this.cacheDir, this.leaderInstanceId));
    const logPath = path.join(resolvedCacheDir, `${uniqueKey}.log`);

    console.log(`[${timestamp}] Message from ${fromLabel} (${msg.type}):`);
    console.log(`  ${msg.content.slice(0, 200)}`);

    console.log(`[${timestamp}] Processing...`);
    await execWithTee(this.command, msg.content, logPath, this.workDir);

    try {
      msg.read = true;
      await this.zk.updateMessage(this.instanceId, msgId, msg as unknown as Record<string, unknown>);
    } catch {
      // best effort
    }

    this.inFlight.delete(msgId);
    console.log(`[${timestamp}] Done. Log: ${logPath}`);
  }

  stop(): void {
    this.stopped = true;
  }
}
