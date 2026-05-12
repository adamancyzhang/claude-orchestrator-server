import { ZkClient } from "../zk/client.js";
import * as paths from "../zk/paths.js";
import { MessageSchema } from "../models/schemas.js";
import { LeaderEventBus } from "./event-bus.js";
import type { ChainRouter } from "./chain-router.js";

export class LeaderWatcher {
  private inFlight = new Set<string>();
  private stopped = false;

  constructor(
    private zk: ZkClient,
    private eventBus: LeaderEventBus,
    private leaderInstanceId: string,
    private chainRouter: ChainRouter,
  ) {}

  async start(): Promise<void> {
    await this.zk.mkdirp(paths.messageDirPath(this.leaderInstanceId));
    this.watchLoop();
  }

  private async watchLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      const children = await this.zk.watchMessageDir(
        this.leaderInstanceId,
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
    const data = await this.zk.getMessage(this.leaderInstanceId, msgId);
    if (!data) return;
    const msg = MessageSchema.parse({ ...data, id: msgId });
    if (msg.read) return;

    this.inFlight.add(msgId);
    const fromLabel = msg.from_name || msg.from_instance?.slice(0, 8) || "unknown";

    console.log(`[Watcher] Message from ${fromLabel} (${msg.type}): ${msg.content.slice(0, 100)}`);

    this.eventBus.emit({
      type: "message_received",
      from: fromLabel,
      content: msg.content,
      msgId,
    });

    await this.chainRouter.route(msg);

    try {
      msg.read = true;
      await this.zk.updateMessage(this.leaderInstanceId, msgId, msg as unknown as Record<string, unknown>);
    } catch {
      // best effort
    }

    this.inFlight.delete(msgId);
    this.eventBus.emit({ type: "message_processed", msgId });
  }

  stop(): void {
    this.stopped = true;
  }
}
