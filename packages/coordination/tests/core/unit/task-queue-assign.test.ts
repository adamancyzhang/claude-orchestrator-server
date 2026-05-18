// CORE-RETENTION
// Locks in: TaskQueue.assign() updates the pending task's `assigned_to`
//   and `assigned_to_name` fields without transitioning the task from
//   pending → claimed, so the Leader can pin a pending task to a specific
//   Worker just before sending the corresponding task_dispatch message.
//   This is the load-bearing primitive of Leader-directed dispatch — the
//   Worker watcher reads `assigned_to` before claimById() and rejects
//   dispatches whose pinned worker does not match self.
// Core path because: without assign(), the Leader's dispatch is just a
//   convention (only the inbox knows who the task is for); a recovering
//   worker could claim from a stale pending node and silently bypass
//   the assignment. With assign() the assignment is durable in ZK.
// Owner subsystem: coordination.
// Primary source files exercised:
//   - packages/coordination/src/task-queue.ts (assign method)
//   - packages/contracts/src/interfaces/coordination.ts (ITaskQueue.assign)
//
// TRUST-JUSTIFICATION: in-memory FakeZkClient mirrors the same set/get
//   semantics TaskQueue relies on (setData overwrites at the same path;
//   getData returns the last write). Real ZK persistence is covered by
//   integration tests; here we exercise the pure protocol contract:
//   assign() loads the pending payload, merges new assignment fields,
//   writes back, and returns the parsed Task with status="pending".

import { describe, expect, it } from "vitest";
import {
  asInstanceId,
  type IZkClient,
  type ZkPath,
} from "@co/contracts";
import { TaskQueue } from "../../../src/index.js";

class FakeZkClient implements IZkClient {
  private nodes = new Map<ZkPath, { data: Buffer }>();
  state = "connected" as const;
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async exists(path: ZkPath): Promise<boolean> {
    return this.nodes.has(path);
  }
  async createPersistent(path: ZkPath, data: Buffer): Promise<ZkPath> {
    this.nodes.set(path, { data });
    return path;
  }
  async createPersistentSequential(
    parent: ZkPath,
    prefix: string,
    data: Buffer,
  ): Promise<ZkPath> {
    const seq = String(this.nodes.size + 1).padStart(10, "0");
    const path = `${parent}/${prefix}${seq}` as ZkPath;
    this.nodes.set(path, { data });
    return path;
  }
  async createEphemeral(path: ZkPath, data: Buffer): Promise<ZkPath> {
    this.nodes.set(path, { data });
    return path;
  }
  async createEphemeralSequential(
    parent: ZkPath,
    prefix: string,
    data: Buffer,
  ): Promise<ZkPath> {
    return this.createPersistentSequential(parent, prefix, data);
  }
  async setData(path: ZkPath, data: Buffer): Promise<never> {
    this.nodes.set(path, { data });
    return { version: 1, ctime: 0, mtime: 0 } as never;
  }
  async getData(path: ZkPath) {
    const node = this.nodes.get(path);
    if (!node) return null;
    return { data: node.data, stat: { version: 1, ctime: 0, mtime: 0 } };
  }
  async getChildren(path: ZkPath): Promise<string[]> {
    const prefix = `${path}/`;
    const out: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) out.push(rest);
      }
    }
    return out;
  }
  async watchChildren(): Promise<string[]> {
    return [];
  }
  async watchData(): Promise<Buffer | null> {
    return null;
  }
  async delete(path: ZkPath): Promise<void> {
    this.nodes.delete(path);
  }
  async mkdirp(): Promise<void> {}
  on(): void {}
}

describe("TaskQueue.assign", () => {
  it("pins a pending task to an instance without transitioning to claimed", async () => {
    const zk = new FakeZkClient();
    const queue = new TaskQueue({ zk });
    const task = await queue.push({ title: "build it", link: "execute", priority: 1 });
    expect(task.assigned_to).toBeNull();

    const worker = asInstanceId("worker-jerry-01");
    const updated = await queue.assign(task.id, worker, "Jerry");
    expect(updated).not.toBeNull();
    expect(updated!.assigned_to).toBe(worker);
    expect(updated!.assigned_to_name).toBe("Jerry");
    expect(updated!.status).toBe("pending");

    // Re-read through the public getter to confirm the pending payload is durable.
    const stillPending = await queue.getPending(task.id);
    expect(stillPending).not.toBeNull();
    expect(stillPending!.assigned_to).toBe(worker);
    expect(stillPending!.assigned_to_name).toBe("Jerry");
  });

  it("returns null when the task is no longer pending", async () => {
    const zk = new FakeZkClient();
    const queue = new TaskQueue({ zk });
    const task = await queue.push({ title: "x", link: "execute", priority: 1 });
    // Claim it (removes the pending node).
    await queue.claimById(task.id, asInstanceId("worker-a"));
    const updated = await queue.assign(task.id, asInstanceId("worker-b"), "B");
    expect(updated).toBeNull();
  });

  it("subsequent assign() overwrites a prior assignment on the same pending task", async () => {
    const zk = new FakeZkClient();
    const queue = new TaskQueue({ zk });
    const task = await queue.push({ title: "x", link: "execute", priority: 1 });
    await queue.assign(task.id, asInstanceId("worker-a"), "A");
    const updated = await queue.assign(task.id, asInstanceId("worker-b"), "B");
    expect(updated!.assigned_to).toBe(asInstanceId("worker-b"));
    expect(updated!.assigned_to_name).toBe("B");
  });
});
