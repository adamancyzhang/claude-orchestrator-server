import { ZkClient } from "../zk/client.js";
import {
  InstanceSchema,
  createInstance,
  type Instance,
  type InstanceRole,
} from "../models/schemas.js";

export class InstanceRegistry {
  constructor(private zk: ZkClient) {}

  async register(
    name: string,
    role: string = "builder",
    instanceId?: string
  ): Promise<Instance> {
    const validRole = ["planner", "builder", "verifier", "reviewer", "accepter", "leader"].includes(role)
      ? (role as InstanceRole)
      : "builder";

    if (instanceId) {
      const raw = await this.zk.getInstance(instanceId);
      if (raw) {
        const existing = InstanceSchema.parse(raw);
        existing.name = name;
        existing.role = validRole;
        existing.status = "idle";
        existing.connected_since = new Date().toISOString();
        await this.zk.updateInstance(instanceId, existing);
        return existing;
      }
    }

    // If no instanceId, look up existing instance by name to avoid duplicates
    if (!instanceId) {
      const instances = await this.listAll();
      const existing = instances.find((i) => i.name === name);
      if (existing) {
        existing.role = validRole;
        existing.status = "idle";
        existing.connected_since = new Date().toISOString();
        await this.zk.updateInstance(existing.id, existing);
        return existing;
      }
    }

    const instance = createInstance({
      id: instanceId,
      name,
      role: validRole,
    });
    await this.zk.registerInstance(instance.id, instance);
    return instance;
  }

  async heartbeat(
    instanceId: string,
    currentTask?: string
  ): Promise<void> {
    const raw = await this.zk.getInstance(instanceId);
    if (!raw) {
      throw new Error(`Instance ${instanceId} not found`);
    }
    const data = InstanceSchema.parse(raw);
    if (currentTask !== undefined) {
      data.current_task_id = currentTask;
      data.status = currentTask ? "busy" : "idle";
    }
    await this.zk.updateInstance(instanceId, data);
  }

  async get(instanceId: string): Promise<Instance | null> {
    const data = await this.zk.getInstance(instanceId);
    return data ? InstanceSchema.parse(data) : null;
  }

  async listAll(): Promise<Instance[]> {
    const instances = await this.zk.listInstances();
    return instances.map((data) => InstanceSchema.parse(data));
  }

  async unregister(instanceId: string): Promise<void> {
    await this.zk.deleteInstance(instanceId);
  }
}
