import * as fs from "node:fs";
import { ZkClient } from "../zk/client.js";
import {
  MessageSchema,
  InstanceSchema,
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
    broadcast: boolean = false,
    toName?: string,
    help: boolean = false,
  ): Promise<Message[]> {
    const messages: Message[] = [];

    // Name-based addressing: resolve to_name to instance_id
    if (toName) {
      const name = toName.replace(/^@/, "");
      if (name.toLowerCase() === "all") {
        broadcast = true;
      } else {
        const instances = await this.zk.listInstances();
        const match = instances
          .map((raw) => InstanceSchema.parse(raw))
          .find((i) => i.name === name);
        if (!match) {
          throw new Error(`Instance "${name}" not found`);
        }
        toInstance = match.id;
      }
    }

    const msgType: MessageType = help ? "help" : (broadcast ? "broadcast" : "direct");

    let targets: string[];
    if (broadcast || help) {
      const instances = await this.zk.listInstances();
      targets = instances
        .map((raw) => InstanceSchema.parse(raw))
        .map((i) => i.id)
        .filter((id) => id !== fromInstance);
    } else if (toInstance) {
      targets = [toInstance];
    } else {
      throw new Error("Must specify to_instance, to_name, or broadcast=true");
    }

    for (const targetId of targets) {
      const msg = createMessage({
        type: msgType,
        from_instance: fromInstance,
        from_name: fromName,
        to_instance: targetId,
        content,
      });
      const msgId = await this.zk.createMessage(targetId, msg);
      msg.id = msgId;
      messages.push(msg);
    }

    return messages;
  }

  async poll(instanceId: string): Promise<Message[]> {
    const raw = await this.zk.listMessages(instanceId);
    const messages: Message[] = [];

    for (const [msgId, data] of raw) {
      const msg = MessageSchema.parse(data);
      msg.id = msgId;
      if (!msg.read) {
        msg.read = true;
        await this.zk.updateMessage(instanceId, msgId, msg);
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
    const raw = await this.zk.getMessage(instanceId, messageId);
    if (!raw) {
      throw new Error(`Message ${messageId} not found for instance ${instanceId}`);
    }
    const msg = MessageSchema.parse(raw);
    msg.id = messageId;
    msg.read = true;
    await this.zk.updateMessage(instanceId, messageId, msg);
  }

  async dismissMessage(instanceId: string, messageId: string): Promise<void> {
    await this.zk.deleteMessage(instanceId, messageId);
  }

}

export async function renderTemplate(
  templatePath: string,
  variables: Record<string, string>,
): Promise<string> {
  let content = await fs.promises.readFile(templatePath, "utf-8");
  for (const [key, value] of Object.entries(variables)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return content;
}
