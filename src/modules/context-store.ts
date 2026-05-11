import { ZkClient } from "../zk/client.js";
import {
  createContextEntry,
  type ContextEntry,
} from "../models/schemas.js";

export class ContextStore {
  constructor(private zk: ZkClient) {}

  async set(
    key: string,
    value: string,
    updatedBy: string = ""
  ): Promise<ContextEntry> {
    const entry = createContextEntry({ key, value, updated_by: updatedBy });
    await this.zk.setContext(key, entry as unknown as Record<string, unknown>);
    return entry;
  }

  async get(key: string): Promise<string | null> {
    const data = await this.zk.getContext(key);
    if (!data) return null;
    return (data.value as string) ?? null;
  }

  async delete(key: string): Promise<void> {
    await this.zk.deleteContext(key);
  }

  async listKeys(): Promise<string[]> {
    return this.zk.listContextKeys();
  }
}
