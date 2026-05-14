// CORE-RETENTION
// Locks in: TaskQueue.claim() sort key:
//   (1) hard-assigned tasks first, (2) ROLE_WEIGHTS weight DESC,
//   (3) priority ASC (HIGH=0 first), (4) FIFO sequence.
//   This is the only mechanism that determines which Worker claims which
//   task; a regression silently redirects work between roles.
// Core path because: P→B→V→R→A chain routing depends entirely on this sort.
// Owner subsystem: coordination.
// Primary source files exercised:
//   - packages/coordination/src/task-queue.ts
//   - packages/contracts/src/roleWeights.ts
//
// TRUST-JUSTIFICATION: this test uses an in-memory fake IZkClient instead
//   of a real ZooKeeper.
// Downstream: ZK persistence is exercised in tests/core/integration/* via a
//   real docker-compose ZK instance.
// Reason: claim() sort is a pure function of pending node payloads and the
//   ROLE_WEIGHTS matrix — observable behavior here is "which task wins";
//   ZK semantics (EPHEMERAL claim node, watch re-arm) is orthogonal and
//   covered elsewhere.
// Evidence: the assertions inspect the returned Task — exactly the
//   contract a real ZK call chain would satisfy.

import { describe, expect, it } from "vitest";
import {
  asInstanceId,
  asTaskId,
  type IZkClient,
  type ZkPath,
} from "@co/contracts";
import { TaskQueue } from "../../../src/index.js";

interface Node {
  data: Buffer;
}

class FakeZkClient implements IZkClient {
  private nodes = new Map<ZkPath, Node>();
  state = "connected" as const;

  async connect(): Promise<void> {
    return;
  }
  async close(): Promise<void> {
    return;
  }
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
  async mkdirp(): Promise<void> {
    return;
  }
  on(): void {
    return;
  }
}

describe("TaskQueue.claim sort", () => {
  it("prefers tasks whose link matches role weight (build > review for a builder)", async () => {
    const zk = new FakeZkClient();
    const queue = new TaskQueue({ zk });
    await queue.push({ title: "review", link: "review", priority: 1 });
    await queue.push({ title: "build", link: "build", priority: 1 });

    const claimed = await queue.claim(asInstanceId("worker-1"), "builder");
    expect(claimed?.title).toBe("build");
  });

  it("prefers explicit assigned_to over weight", async () => {
    const zk = new FakeZkClient();
    const queue = new TaskQueue({ zk });
    const me = asInstanceId("worker-X");
    await queue.push({ title: "no-match", link: "build", priority: 1 });
    await queue.push({
      title: "for-me",
      link: "review",
      priority: 1,
      assigned_to: me,
    });

    const claimed = await queue.claim(me, "builder");
    expect(claimed?.title).toBe("for-me");
  });

  it("ties broken by priority then FIFO", async () => {
    const zk = new FakeZkClient();
    const queue = new TaskQueue({ zk });
    await queue.push({ title: "first", link: "build", priority: 1 });
    await queue.push({ title: "high", link: "build", priority: 0 });
    await queue.push({ title: "second", link: "build", priority: 1 });

    const c1 = await queue.claim(asInstanceId("a"), "builder");
    expect(c1?.title).toBe("high");
    const c2 = await queue.claim(asInstanceId("b"), "builder");
    expect(c2?.title).toBe("first");
  });

  it("leader_only tasks are invisible to non-leader claimers", async () => {
    const zk = new FakeZkClient();
    const queue = new TaskQueue({ zk });
    await queue.push({
      title: "leader-only",
      link: null,
      leader_only: true,
    });

    expect(await queue.claim(asInstanceId("worker"), "builder")).toBeNull();
  });

  it("returns null when no pending tasks", async () => {
    const zk = new FakeZkClient();
    const queue = new TaskQueue({ zk });
    expect(await queue.claim(asInstanceId("a"), "builder")).toBeNull();
  });
});
