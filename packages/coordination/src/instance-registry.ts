import {
  asInstanceId,
  InstanceSchema,
  PROTOCOL_VERSION,
  ValidationError,
  zkPaths,
  type CreateInstanceInput,
  type IInstanceRegistry,
  type IZkClient,
  type Instance,
  type InstanceId,
  type ZkPathOptions,
} from "@co/contracts";
import { randomUUID } from "node:crypto";

function utcNow(): string {
  return new Date().toISOString();
}

function encode(data: unknown): Buffer {
  return Buffer.from(JSON.stringify(data), "utf-8");
}

function decode<T>(buf: Buffer): T {
  return JSON.parse(buf.toString("utf-8")) as T;
}

function parseInstance(raw: unknown): Instance {
  const result = InstanceSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError("invalid instance payload", result.error);
  }
  return result.data;
}

export interface InstanceRegistryOptions {
  zk: IZkClient;
  paths?: ZkPathOptions;
}

export class InstanceRegistry implements IInstanceRegistry {
  private readonly zk: IZkClient;
  private readonly paths: ZkPathOptions | undefined;

  constructor(opts: InstanceRegistryOptions) {
    this.zk = opts.zk;
    this.paths = opts.paths;
  }

  async register(input: CreateInstanceInput): Promise<Instance> {
    const id = input.id ?? asInstanceId(randomUUID().replace(/-/g, ""));
    const instance: Instance = parseInstance({
      id,
      name: input.name,
      role: input.role ?? "executor",
      status: "idle",
      current_task_id: input.current_task_id ?? null,
      connected_since: utcNow(),
      work_dir: input.work_dir ?? null,
      worktree_name: input.worktree_name ?? null,
      worktree_path: input.worktree_path ?? null,
      worktree_branch: input.worktree_branch ?? null,
      pid: input.pid ?? null,
      protocol_version: PROTOCOL_VERSION,
    });
    await this.zk.createEphemeral(
      zkPaths.instance(id, this.paths),
      encode(instance),
    );
    return instance;
  }

  async unregister(instanceId: InstanceId): Promise<void> {
    await this.zk
      .delete(zkPaths.instance(instanceId, this.paths))
      .catch(() => {});
  }

  async heartbeat(
    instanceId: InstanceId,
    patch: Partial<Instance>,
  ): Promise<void> {
    const data = await this.zk.getData(
      zkPaths.instance(instanceId, this.paths),
    );
    if (!data) return;
    const current = parseInstance(decode<Record<string, unknown>>(data.data));
    const merged = parseInstance({ ...current, ...patch });
    await this.zk.setData(
      zkPaths.instance(instanceId, this.paths),
      encode(merged),
    );
  }

  async list(): Promise<Instance[]> {
    const ids = await this.zk.getChildren(zkPaths.instances(this.paths));
    const out: Instance[] = [];
    for (const id of ids) {
      const data = await this.zk.getData(
        zkPaths.instance(asInstanceId(id), this.paths),
      );
      if (!data) continue;
      out.push(parseInstance(decode<Record<string, unknown>>(data.data)));
    }
    return out;
  }

  async get(instanceId: InstanceId): Promise<Instance | null> {
    const data = await this.zk.getData(
      zkPaths.instance(instanceId, this.paths),
    );
    if (!data) return null;
    return parseInstance(decode<Record<string, unknown>>(data.data));
  }

  async watch(cb: (instances: Instance[]) => void): Promise<Instance[]> {
    await this.zk.watchChildren(zkPaths.instances(this.paths), async () => {
      const list = await this.list();
      cb(list);
    });
    return this.list();
  }
}
