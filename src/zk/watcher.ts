import { ZkClient } from "./client.js";

type ChildrenCallback = (children: string[]) => void;
type DataCallback = (data: Record<string, unknown> | null) => void;

export class ZkWatcher {
  constructor(private zk: ZkClient) {}

  async watchMessageDir(
    instanceId: string,
    onChange: ChildrenCallback
  ): Promise<string[]> {
    return this.zk.watchMessageDir(instanceId, onChange);
  }

  async watchPendingTasks(onChange: ChildrenCallback): Promise<string[]> {
    return this.zk.watchPendingTasks(onChange);
  }

  async watchContextKey(
    key: string,
    onChange: DataCallback
  ): Promise<Record<string, unknown> | null> {
    return this.zk.watchContextKey(key, onChange);
  }
}
