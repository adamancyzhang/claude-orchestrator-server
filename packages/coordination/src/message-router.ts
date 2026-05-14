import {
  asMessageId,
  MessageSchema,
  ValidationError,
  zkPaths,
  type IMessageRouter,
  type IZkClient,
  type InstanceId,
  type Message,
  type SendMessageInput,
  type ZkPathOptions,
} from "@co/contracts";

function utcNow(): string {
  return new Date().toISOString();
}

function encode(data: unknown): Buffer {
  return Buffer.from(JSON.stringify(data), "utf-8");
}

function decode<T>(buf: Buffer): T {
  return JSON.parse(buf.toString("utf-8")) as T;
}

function parseMessage(raw: unknown): Message {
  const result = MessageSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError("invalid message payload", result.error);
  }
  return result.data;
}

export interface MessageRouterOptions {
  zk: IZkClient;
  paths?: ZkPathOptions;
}

export class MessageRouter implements IMessageRouter {
  private readonly zk: IZkClient;
  private readonly paths: ZkPathOptions | undefined;

  constructor(opts: MessageRouterOptions) {
    this.zk = opts.zk;
    this.paths = opts.paths;
  }

  async send(input: SendMessageInput): Promise<Message> {
    if (!input.to_instance) {
      throw new ValidationError("send() requires to_instance");
    }
    const payload = {
      type: input.type,
      from_instance: input.from_instance,
      from_name: input.from_name,
      from_role: input.from_role ?? "",
      to_instance: input.to_instance,
      to_name: input.to_name ?? null,
      content: input.content,
      link: input.link ?? null,
      task_id: input.task_id ?? null,
      chain_id: input.chain_id ?? null,
      task_title: input.task_title ?? null,
      task_description: input.task_description ?? null,
      task_criteria: input.task_criteria ?? null,
      task_doc_path: input.task_doc_path ?? null,
      result_path: input.result_path ?? null,
      reply_to: input.reply_to ?? null,
      read: false,
      created_at: utcNow(),
    };

    const dir = zkPaths.messageDir(input.to_instance, this.paths);
    await this.zk.mkdirp(dir);
    const createdPath = await this.zk.createPersistentSequential(
      dir,
      "msg-",
      encode(payload),
    );
    const msgId = asMessageId(createdPath.split("/").pop()!);
    return parseMessage({ ...payload, id: msgId });
  }

  async poll(instanceId: InstanceId): Promise<Message[]> {
    const dir = zkPaths.messageDir(instanceId, this.paths);
    const ids = await this.zk.getChildren(dir);
    ids.sort();
    const out: Message[] = [];
    for (const id of ids) {
      const data = await this.zk.getData(
        zkPaths.message(instanceId, asMessageId(id), this.paths),
      );
      if (!data) continue;
      const raw = decode<Record<string, unknown>>(data.data);
      const msg = parseMessage({ ...raw, id });
      if (!msg.read) {
        const updated = { ...raw, id, read: true };
        await this.zk.setData(
          zkPaths.message(instanceId, asMessageId(id), this.paths),
          encode(updated),
        );
      }
      out.push(msg);
    }
    return out;
  }

  async waitForMessage(
    instanceId: InstanceId,
    cb: (msg: Message) => void,
  ): Promise<void> {
    const dir = zkPaths.messageDir(instanceId, this.paths);
    await this.zk.mkdirp(dir);
    const seen = new Set<string>();
    const initial = await this.poll(instanceId);
    for (const m of initial) {
      seen.add(m.id);
      cb(m);
    }
    await this.zk.watchChildren(dir, async () => {
      const msgs = await this.poll(instanceId);
      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        cb(m);
      }
    });
  }

  async dismiss(instanceId: InstanceId, messageId: string): Promise<void> {
    await this.zk.delete(
      zkPaths.message(instanceId, asMessageId(messageId), this.paths),
    );
  }
}
