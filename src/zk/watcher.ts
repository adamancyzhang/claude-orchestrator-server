import { ZkClient } from "./client.js";

type ChildrenCallback = (children: string[]) => void;

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
}
