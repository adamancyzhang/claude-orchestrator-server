import {
  type IEventBus,
  type ILogger,
  type IMessageRouter,
  type InstanceId,
  type LeaderEvent,
} from "@co/contracts";
import type { ChainRouter } from "./chain-router.js";

export class LeaderWatcher {
  private stopped = false;
  private inFlight = new Set<string>();

  constructor(
    private readonly message_router: IMessageRouter,
    private readonly bus: IEventBus<LeaderEvent>,
    private readonly chain_router: ChainRouter,
    private readonly leader_id: InstanceId,
    private readonly logger: ILogger,
  ) {}

  async start(): Promise<void> {
    await this.message_router.waitForMessage(this.leader_id, (msg) => {
      if (this.stopped) return;
      if (this.inFlight.has(msg.id)) return;
      this.inFlight.add(msg.id);
      void this.processMessage(msg).finally(() => this.inFlight.delete(msg.id));
    });
  }

  stop(): void {
    this.stopped = true;
  }

  private async processMessage(msg: {
    id: string;
    from_instance: InstanceId;
    from_name: string;
    from_role?: string;
    content: string;
    type: string;
    link: string | null;
    task_title?: string | null;
    task_description?: string | null;
    task_criteria?: string | null;
    result_path?: string | null;
    reply_to?: string | null;
    chain_id?: string | null;
    task_id?: string | null;
    read: boolean;
    created_at: string;
    to_instance?: string | null;
    to_name?: string | null;
  }): Promise<void> {
    this.bus.emit({
      type: "message_received",
      from: msg.from_instance,
      message_id: msg.id as never,
      content: msg.content,
    });

    try {
      // The chain router accepts the message envelope directly.
      await this.chain_router.route(msg as Parameters<ChainRouter["route"]>[0]);
    } catch (err) {
      this.logger.error("chain router failed", {
        message_id: msg.id,
        error: String(err),
      });
    }

    this.bus.emit({
      type: "message_processed",
      message_id: msg.id as never,
      log_path: "",
    });
  }
}
