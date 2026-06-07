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
      system_prompt: input.system_prompt ?? null,
      result_path: input.result_path ?? null,
      original_requirement_path: input.original_requirement_path ?? null,
      // Optional v0.7 fields — must be forwarded for downstream
      // consumers (Worker `preTaskRebase` / `collectChainArtifacts` /
      // task-template rendering, ChainRouter spawn_chain dispatch) to
      // function. Dropping them here silently breaks
      // `docs/evals/02-leader-worker-communication.md` §3.4 (the
      // task_dispatch upstream_commits column) and §6.1 (worker
      // pre-task rebase).
      ...(input.upstream_commits !== undefined
        ? { upstream_commits: input.upstream_commits }
        : {}),
      ...(input.spawned_from !== undefined
        ? { spawned_from: input.spawned_from }
        : {}),
      ...(input.next_requirement !== undefined
        ? { next_requirement: input.next_requirement }
        : {}),
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
      if (!msg.read) out.push(msg);
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
      await this.ack(instanceId, m.id);
    }
    await this.zk.watchChildren(dir, async () => {
      const msgs = await this.poll(instanceId);
      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        cb(m);
        await this.ack(instanceId, m.id);
      }
    });
  }

  async ack(instanceId: InstanceId, messageId: string): Promise<void> {
    const data = await this.zk.getData(
      zkPaths.message(instanceId, asMessageId(messageId), this.paths),
    );
    if (!data) return;
    const raw = decode<Record<string, unknown>>(data.data);
    if (raw.read) return;
    const updated = { ...raw, read: true };
    await this.zk.setData(
      zkPaths.message(instanceId, asMessageId(messageId), this.paths),
      encode(updated),
    );
  }

  async dismiss(instanceId: InstanceId, messageId: string): Promise<void> {
    await this.zk.delete(
      zkPaths.message(instanceId, asMessageId(messageId), this.paths),
    );
  }
}
