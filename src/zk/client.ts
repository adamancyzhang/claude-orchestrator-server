import zookeeper from "node-zookeeper-client";
import * as paths from "./paths.js";
import type { Instance, Task, Message, ContextEntry } from "../models/schemas.js";

const { CreateMode, Exception, State } = zookeeper;

// Error codes from node-zookeeper-client Exception
const NO_NODE = Exception.NO_NODE; // -101
const NODE_EXISTS = Exception.NODE_EXISTS; // -110

function isErrorCode(err: unknown, code: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "getCode" in err &&
    typeof (err as { getCode: () => number }).getCode === "function" &&
    (err as { getCode: () => number }).getCode() === code
  );
}

export function isNoNode(err: unknown): boolean {
  return isErrorCode(err, NO_NODE);
}

export function isNodeExists(err: unknown): boolean {
  return isErrorCode(err, NODE_EXISTS);
}

export class ZkClient {
  private hosts: string;
  private client: zookeeper.Client | null = null;
  private _connected = false;
  private _running = false;
  private _reconnecting = false;
  private stateListener: ((...args: unknown[]) => void) | null = null;

  constructor(hosts: string) {
    this.hosts = hosts;
  }

  // ── Connection lifecycle ──

  async connect(): Promise<void> {
    this._running = true;
    await this._connect();
  }

  private _connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.client) {
        this.client.removeListener("state", this.stateListener!);
        this.client.close();
        this.client = null;
      }

      this.client = zookeeper.createClient(this.hosts, {
        sessionTimeout: 30000,
        spinDelay: 1000,
        retries: 3,
      });

      this.stateListener = (...args: unknown[]) => {
        const state = args[0] as number;
        if (state === State.SYNC_CONNECTED) {
          this._connected = true;
        } else if (state === State.EXPIRED) {
          this._connected = false;
          if (this._running && !this._reconnecting) {
            this._reconnectLoop();
          }
        } else if (state === State.DISCONNECTED) {
          this._connected = false;
        }
      };

      this.client.once("connected", async () => {
        try {
          await this._ensurePaths();
          this._connected = true;
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.client.on("state", this.stateListener);

      this.client.connect();
    });
  }

  private async _reconnectLoop(): Promise<void> {
    this._reconnecting = true;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (!this._running) return;
        const delay = Math.min(2 ** attempt, 30) * 1000;
        await sleep(delay);
        if (!this._running) return;
        try {
          await this._connect();
          return;
        } catch {
          // continue retrying
        }
      }
      throw new Error(
        "ZK reconnection FAILED after 10 attempts — server requires restart"
      );
    } finally {
      this._reconnecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this._running = false;
    this._connected = false;
    if (this.client) {
      this.client.removeListener("state", this.stateListener!);
      this.client.close();
      this.client = null;
    }
  }

  get connected(): boolean {
    return (
      this._connected &&
      this.client !== null &&
      this.client.getState() === State.SYNC_CONNECTED
    );
  }

  private async _ensurePaths(): Promise<void> {
    await Promise.all(
      paths.ALL_ENSURE_PATHS.map((p) => this.mkdirp(p))
    );
  }

  // ── Low-level ZK operations (promisified) ──

  async mkdirp(p: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client!.mkdirp(p, (err: Error | null) => {
        if (err && !isNoNode(err) && !isNodeExists(err)) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async create(
    p: string,
    data: Buffer,
    mode: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client!.create(p, data, mode, (err: Error | null, createdPath: string) => {
        if (err) reject(err);
        else resolve(createdPath);
      });
    });
  }

  async getData(p: string): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      this.client!.getData(p, (err: Error | null, data: Buffer) => {
        if (err) {
          if (isNoNode(err)) resolve(null);
          else reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }

  async getDataWithWatch(
    p: string,
    watcher: (data: Buffer | null) => void
  ): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      this.client!.getData(
        p,
        () => {
          // Re-read data after watch fires
          this.getData(p).then((d) => watcher(d)).catch(() => watcher(null));
        },
        (err: Error | null, data: Buffer) => {
          if (err) {
            if (isNoNode(err)) resolve(null);
            else reject(err);
          } else {
            resolve(data);
          }
        }
      );
    });
  }

  async setData(p: string, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client!.setData(p, data, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getChildren(p: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.client!.getChildren(p, (err: Error | null, children: string[]) => {
        if (err) {
          if (isNoNode(err)) resolve([]);
          else reject(err);
        } else {
          resolve(children);
        }
      });
    });
  }

  async getChildrenWithWatch(
    p: string,
    watcher: (children: string[]) => void
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.client!.getChildren(
        p,
        () => {
          // Re-read children after watch fires
          this.getChildren(p).then((c) => watcher(c)).catch(() => watcher([]));
        },
        (err: Error | null, children: string[]) => {
          if (err) {
            if (isNoNode(err)) resolve([]);
            else reject(err);
          } else {
            resolve(children);
          }
        }
      );
    });
  }

  async remove(p: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client!.remove(p, (err: Error | null) => {
        if (err) {
          if (isNoNode(err)) resolve();
          else reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async exists(p: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.client!.exists(p, (err: Error | null, stat: unknown) => {
        if (err) {
          if (isNoNode(err)) resolve(false);
          else reject(err);
        } else {
          resolve(stat !== null);
        }
      });
    });
  }

  // ── Leader operations ──

  async createLeader(data: Record<string, unknown>): Promise<void> {
    await this.create(paths.LEADER, encodeJson(data), CreateMode.EPHEMERAL);
  }

  async getLeader(): Promise<Record<string, unknown> | null> {
    const raw = await this.getData(paths.LEADER);
    return raw ? decodeJson(raw) : null;
  }

  // ── Instance operations ──

  async registerInstance(instanceId: string, data: Record<string, unknown>): Promise<void> {
    const p = paths.instancePath(instanceId);
    await this.create(p, encodeJson(data), CreateMode.EPHEMERAL);
  }

  async getInstance(instanceId: string): Promise<Record<string, unknown> | null> {
    const raw = await this.getData(paths.instancePath(instanceId));
    return raw ? decodeJson(raw) : null;
  }

  async updateInstance(instanceId: string, data: Record<string, unknown>): Promise<void> {
    await this.setData(paths.instancePath(instanceId), encodeJson(data));
  }

  async listInstances(): Promise<Record<string, unknown>[]> {
    const children = await this.getChildren(paths.INSTANCES);
    const results: Record<string, unknown>[] = [];
    for (const cid of children) {
      const data = await this.getInstance(cid);
      if (data) results.push(data);
    }
    return results;
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.remove(paths.instancePath(instanceId));
  }

  // ── Task operations ──

  async createPendingTask(data: Record<string, unknown>): Promise<string> {
    const createdPath = await this.create(
      `${paths.TASKS_PENDING}/task-`,
      encodeJson(data),
      CreateMode.PERSISTENT_SEQUENTIAL
    );
    return createdPath.split("/").pop()!;
  }

  async getPendingTask(taskId: string): Promise<Record<string, unknown> | null> {
    const raw = await this.getData(paths.pendingTaskPath(taskId));
    return raw ? decodeJson(raw) : null;
  }

  async listPendingTasks(): Promise<[string, Record<string, unknown>][]> {
    const children = await this.getChildren(paths.TASKS_PENDING);
    children.sort();
    const results: [string, Record<string, unknown>][] = [];
    for (const cid of children) {
      const data = await this.getPendingTask(cid);
      if (data) results.push([cid, data]);
    }
    return results;
  }

  async deletePendingTask(taskId: string): Promise<void> {
    await this.remove(paths.pendingTaskPath(taskId));
  }

  async claimTask(
    instanceId: string,
    taskId: string,
    data: Buffer = Buffer.alloc(0)
  ): Promise<boolean> {
    try {
      await this.create(
        paths.claimedTaskPath(instanceId, taskId),
        data,
        CreateMode.EPHEMERAL
      );
      return true;
    } catch (err) {
      if (isNodeExists(err)) return false;
      throw err;
    }
  }

  async getClaimedTask(
    instanceId: string,
    taskId: string
  ): Promise<Record<string, unknown>> {
    const raw = await this.getData(paths.claimedTaskPath(instanceId, taskId));
    return raw ? decodeJson(raw) : {};
  }

  async listClaimedTasks(): Promise<[string, string, Record<string, unknown>][]> {
    const children = await this.getChildren(paths.TASKS_CLAIMED);
    children.sort();
    const results: [string, string, Record<string, unknown>][] = [];
    for (const name of children) {
      const idx = name.indexOf("-");
      if (idx === -1) continue;
      const instanceId = name.substring(0, idx);
      const taskId = name.substring(idx + 1);
      const data = await this.getClaimedTask(instanceId, taskId);
      results.push([instanceId, taskId, data]);
    }
    return results;
  }

  async updateClaimedTask(instanceId: string, taskId: string, data: Record<string, unknown>): Promise<void> {
    await this.setData(paths.claimedTaskPath(instanceId, taskId), encodeJson(data));
  }

  async deleteClaimedTask(instanceId: string, taskId: string): Promise<void> {
    await this.remove(paths.claimedTaskPath(instanceId, taskId));
  }

  async saveCompletedTask(taskId: string, data: Record<string, unknown>): Promise<void> {
    await this.create(
      paths.completedTaskPath(taskId),
      encodeJson(data),
      CreateMode.PERSISTENT
    );
  }

  async getCompletedTask(taskId: string): Promise<Record<string, unknown> | null> {
    const raw = await this.getData(paths.completedTaskPath(taskId));
    return raw ? decodeJson(raw) : null;
  }

  async listCompletedTasks(): Promise<Record<string, unknown>[]> {
    const children = await this.getChildren(paths.TASKS_COMPLETED);
    children.sort();
    const results: Record<string, unknown>[] = [];
    for (const cid of children) {
      const data = await this.getCompletedTask(cid);
      if (data) results.push(data);
    }
    return results;
  }

  // ── Message operations ──

  async createMessage(
    instanceId: string,
    data: Record<string, unknown>
  ): Promise<string> {
    await this.mkdirp(paths.messageDirPath(instanceId));
    const createdPath = await this.create(
      `${paths.messageDirPath(instanceId)}/msg-`,
      encodeJson(data),
      CreateMode.PERSISTENT_SEQUENTIAL
    );
    return createdPath.split("/").pop()!;
  }

  async getMessage(
    instanceId: string,
    msgId: string
  ): Promise<Record<string, unknown> | null> {
    const raw = await this.getData(paths.messagePath(instanceId, msgId));
    return raw ? decodeJson(raw) : null;
  }

  async updateMessage(
    instanceId: string,
    msgId: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await this.setData(paths.messagePath(instanceId, msgId), encodeJson(data));
  }

  async listMessages(
    instanceId: string
  ): Promise<[string, Record<string, unknown>][]> {
    const children = await this.getChildren(paths.messageDirPath(instanceId));
    children.sort();
    const results: [string, Record<string, unknown>][] = [];
    for (const cid of children) {
      const data = await this.getMessage(instanceId, cid);
      if (data) results.push([cid, data]);
    }
    return results;
  }

  async deleteMessage(instanceId: string, msgId: string): Promise<void> {
    await this.remove(paths.messagePath(instanceId, msgId));
  }

  // ── Context operations ──

  async setContext(key: string, data: Record<string, unknown>): Promise<void> {
    const p = paths.contextPath(key);
    const exists = await this.exists(p);
    if (exists) {
      await this.setData(p, encodeJson(data));
    } else {
      await this.create(p, encodeJson(data), CreateMode.PERSISTENT);
    }
  }

  async getContext(key: string): Promise<Record<string, unknown> | null> {
    const raw = await this.getData(paths.contextPath(key));
    return raw ? decodeJson(raw) : null;
  }

  async deleteContext(key: string): Promise<void> {
    await this.remove(paths.contextPath(key));
  }

  async listContextKeys(): Promise<string[]> {
    return this.getChildren(paths.CONTEXT);
  }

  // ── Watch operations ──

  watchInstances(onChange: (children: string[]) => void): Promise<string[]> {
    return this.getChildrenWithWatch(paths.INSTANCES, onChange);
  }

  watchClaimedTasks(onChange: (children: string[]) => void): Promise<string[]> {
    return this.getChildrenWithWatch(paths.TASKS_CLAIMED, onChange);
  }

  watchMessageDir(
    instanceId: string,
    onChange: (children: string[]) => void
  ): Promise<string[]> {
    return this.getChildrenWithWatch(paths.messageDirPath(instanceId), onChange);
  }

  async watchContextKey(
    key: string,
    onChange: (data: Record<string, unknown> | null) => void
  ): Promise<Record<string, unknown> | null> {
    const raw = await this.getDataWithWatch(paths.contextPath(key), (buf) => {
      onChange(buf ? decodeJson(buf) : null);
    });
    return raw ? decodeJson(raw) : null;
  }

  watchPendingTasks(
    onChange: (children: string[]) => void
  ): Promise<string[]> {
    return this.getChildrenWithWatch(paths.TASKS_PENDING, onChange);
  }
}

// ── Helpers ──

function encodeJson(data: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(data), "utf-8");
}

function decodeJson(raw: Buffer): Record<string, unknown> {
  return JSON.parse(raw.toString("utf-8"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
