import {
  type IEventBus,
  type ILogger,
  type IMessageRouter,
  type InstanceId,
  type LeaderEvent,
  type TaskLink,
} from "@co/contracts";
import type { ChainRouter } from "./chain-router.js";

function formatWorkerMessageContent(content: string): string {
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj === "object" && "decision" in obj) {
      const decision = String(obj.decision);
      const reason = obj.reason ? `: ${String(obj.reason)}` : "";
      const nextLink = obj.next_link ? ` → ${String(obj.next_link)}` : "";
      return `[${decision}]${reason}${nextLink}`;
    }
  } catch {
    // not JSON, display raw content
  }
  return content;
}

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

    if (msg.from_instance !== this.leader_id) {
      this.bus.emit({
        type: "worker_message_received",
        instance_id: msg.from_instance,
        message_id: msg.id as never,
        content: formatWorkerMessageContent(msg.content),
        link: (msg.link as TaskLink | null) ?? null,
        timestamp: msg.created_at,
      });
    }

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
