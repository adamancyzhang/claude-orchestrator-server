import { ZkClient } from "../zk/client.js";
import {
  MessageSchema,
  createMessage,
  type Message,
  type MessageType,
} from "../models/schemas.js";

function utcNow(): string {
  return new Date().toISOString();
}

export class MessageRouter {
  constructor(private zk: ZkClient) {}

  async send(
    fromInstance: string,
    fromName: string,
    content: string,
    toInstance?: string,
    broadcast: boolean = false
  ): Promise<Message[]> {
    const messages: Message[] = [];
    const msgType: MessageType = broadcast ? "broadcast" : "direct";

    let targets: string[];
    if (broadcast) {
      const instances = await this.zk.listInstances();
      targets = instances
        .map((i) => i.id as string)
        .filter((id) => id !== fromInstance);
    } else if (toInstance) {
      targets = [toInstance];
    } else {
      throw new Error("Must specify to_instance or broadcast=true");
    }

    for (const targetId of targets) {
      const msg = createMessage({
        type: msgType,
        from_instance: fromInstance,
        from_name: fromName,
        to_instance: targetId,
        content,
      });
      const msgId = await this.zk.createMessage(
        targetId,
        msg as unknown as Record<string, unknown>
      );
      msg.id = msgId;
      messages.push(msg);
    }

    return messages;
  }

  async poll(instanceId: string): Promise<Message[]> {
    const raw = await this.zk.listMessages(instanceId);
    const messages: Message[] = [];

    for (const [msgId, data] of raw) {
      data.id = msgId;
      const msg = MessageSchema.parse(data);
      if (!msg.read) {
        msg.read = true;
        await this.zk.updateMessage(
          instanceId,
          msgId,
          msg as unknown as Record<string, unknown>
        );
      }
      messages.push(msg);
    }

    return messages;
  }

  async waitForMessage(
    instanceId: string,
    timeoutSeconds: number = 30
  ): Promise<Message[]> {
    // First check if there are already messages
    const existing = await this.poll(instanceId);
    if (existing.length > 0) return existing;

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), timeoutSeconds * 1000);

      this.zk.watchMessageDir(instanceId, async () => {
        clearTimeout(timer);
        const msgs = await this.poll(instanceId);
        resolve(msgs);
      });
    });
  }

  async markRead(instanceId: string, messageId: string): Promise<void> {
    const data = await this.zk.getMessage(instanceId, messageId);
    if (!data) {
      throw new Error(`Message ${messageId} not found for instance ${instanceId}`);
    }
    data.read = true;
    await this.zk.updateMessage(instanceId, messageId, data);
  }

  async dismissMessage(instanceId: string, messageId: string): Promise<void> {
    await this.zk.deleteMessage(instanceId, messageId);
  }

  async requestHelp(
    fromInstance: string,
    fromName: string,
    question: string,
    ctx?: string
  ): Promise<Message[]> {
    let content = question;
    if (ctx) {
      content = `${question}\n\nContext:\n${ctx}`;
    }
    // Set message type to "help" by modifying after creation
    const messages = await this.send(
      fromInstance,
      fromName,
      content,
      undefined,
      true
    );
    // Update type to "help" for each message
    for (const msg of messages) {
      msg.type = "help";
      await this.zk.updateMessage(
        msg.to_instance!,
        msg.id,
        msg as unknown as Record<string, unknown>
      );
    }
    return messages;
  }
}
