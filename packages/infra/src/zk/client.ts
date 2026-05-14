import zookeeper from "node-zookeeper-client";
import {
  asZkPath,
  ZkSessionExpiredError,
  ZkNodeExistsError,
  ZkNodeNotFoundError,
  type IZkClient,
  type ZkConnectionState,
  type ZkPath,
  type ZkStat,
} from "@co/contracts";

const { CreateMode, Exception, State } = zookeeper;

const NO_NODE = Exception.NO_NODE;
const NODE_EXISTS = Exception.NODE_EXISTS;
const SESSION_EXPIRED = Exception.SESSION_EXPIRED;

type ZkEventListener = () => void;

function isErrorCode(err: unknown, code: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "getCode" in err &&
    typeof (err as { getCode: () => number }).getCode === "function" &&
    (err as { getCode: () => number }).getCode() === code
  );
}

function isNoNode(err: unknown): boolean {
  return isErrorCode(err, NO_NODE);
}
function isNodeExists(err: unknown): boolean {
  return isErrorCode(err, NODE_EXISTS);
}
function isSessionExpired(err: unknown): boolean {
  return isErrorCode(err, SESSION_EXPIRED);
}

function adaptError(err: unknown): Error {
  if (err instanceof Error) {
    if (isSessionExpired(err)) return new ZkSessionExpiredError(err.message, err);
    if (isNoNode(err)) return new ZkNodeNotFoundError(err.message, err);
    if (isNodeExists(err)) return new ZkNodeExistsError(err.message, err);
    return err;
  }
  return new Error(String(err));
}

export interface ZkClientOptions {
  hosts: string;
  session_timeout_ms?: number;
  ensure_paths?: readonly ZkPath[];
}

export class ZkClient implements IZkClient {
  private readonly hosts: string;
  private readonly sessionTimeoutMs: number;
  private readonly ensurePaths: readonly ZkPath[];
  private client: zookeeper.Client | null = null;
  private _state: ZkConnectionState = "connecting";
  private _running = false;
  private _reconnecting = false;
  private stateListener: ((...args: unknown[]) => void) | null = null;
  private readonly listeners: Record<
    "expired" | "disconnected" | "reconnected",
    ZkEventListener[]
  > = { expired: [], disconnected: [], reconnected: [] };

  constructor(opts: ZkClientOptions) {
    this.hosts = opts.hosts;
    this.sessionTimeoutMs = opts.session_timeout_ms ?? 30000;
    this.ensurePaths = opts.ensure_paths ?? [];
  }

  get state(): ZkConnectionState {
    return this._state;
  }

  on(
    event: "expired" | "disconnected" | "reconnected",
    cb: () => void,
  ): void {
    this.listeners[event].push(cb);
  }

  private emit(event: "expired" | "disconnected" | "reconnected"): void {
    for (const cb of this.listeners[event]) {
      try {
        cb();
      } catch {
        // swallow listener errors
      }
    }
  }

  // ── lifecycle ──

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
        sessionTimeout: this.sessionTimeoutMs,
        spinDelay: 1000,
        retries: 3,
      });

      this.stateListener = (...args: unknown[]) => {
        const s = args[0] as number;
        if (s === State.SYNC_CONNECTED) {
          const wasReconnecting = this._state !== "connected";
          this._state = "connected";
          if (wasReconnecting) this.emit("reconnected");
        } else if (s === State.EXPIRED) {
          this._state = "expired";
          this.emit("expired");
          if (this._running && !this._reconnecting) {
            void this._reconnectLoop();
          }
        } else if (s === State.DISCONNECTED) {
          this._state = "disconnected";
          this.emit("disconnected");
        }
      };

      this.client.once("connected", () => {
        Promise.all(
          this.ensurePaths.map((p) => this.mkdirp(p)),
        )
          .then(() => {
            this._state = "connected";
            resolve();
          })
          .catch(reject);
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
      throw new ZkSessionExpiredError(
        "ZK reconnection failed after 10 attempts",
      );
    } finally {
      this._reconnecting = false;
    }
  }

  async close(): Promise<void> {
    this._running = false;
    this._state = "disconnected";
    if (this.client) {
      this.client.removeListener("state", this.stateListener!);
      this.client.close();
      this.client = null;
    }
  }

  // ── primitive ops ──

  exists(path: ZkPath): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.client!.exists(path, (err, stat) => {
        if (err) {
          if (isNoNode(err)) resolve(false);
          else reject(adaptError(err));
        } else {
          resolve(stat !== null);
        }
      });
    });
  }

  mkdirp(path: ZkPath): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client!.mkdirp(path, (err) => {
        if (err && !isNoNode(err) && !isNodeExists(err)) {
          reject(adaptError(err));
        } else {
          resolve();
        }
      });
    });
  }

  private create(
    path: string,
    data: Buffer,
    mode: number,
  ): Promise<ZkPath> {
    return new Promise((resolve, reject) => {
      this.client!.create(path, data, mode, (err, createdPath) => {
        if (err) reject(adaptError(err));
        else resolve(asZkPath(createdPath));
      });
    });
  }

  createPersistent(path: ZkPath, data: Buffer): Promise<ZkPath> {
    return this.create(path, data, CreateMode.PERSISTENT);
  }

  createPersistentSequential(
    parent: ZkPath,
    prefix: string,
    data: Buffer,
  ): Promise<ZkPath> {
    return this.create(`${parent}/${prefix}`, data, CreateMode.PERSISTENT_SEQUENTIAL);
  }

  createEphemeral(path: ZkPath, data: Buffer): Promise<ZkPath> {
    return this.create(path, data, CreateMode.EPHEMERAL);
  }

  createEphemeralSequential(
    parent: ZkPath,
    prefix: string,
    data: Buffer,
  ): Promise<ZkPath> {
    return this.create(`${parent}/${prefix}`, data, CreateMode.EPHEMERAL_SEQUENTIAL);
  }

  setData(
    path: ZkPath,
    data: Buffer,
    expectedVersion?: number,
  ): Promise<ZkStat> {
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null, stat: unknown) => {
        if (err) reject(adaptError(err));
        else resolve(stat as ZkStat);
      };
      if (typeof expectedVersion === "number") {
        this.client!.setData(path, data, expectedVersion, cb);
      } else {
        this.client!.setData(path, data, cb);
      }
    });
  }

  getData(path: ZkPath): Promise<{ data: Buffer; stat: ZkStat } | null> {
    return new Promise((resolve, reject) => {
      this.client!.getData(path, (err, data, stat) => {
        if (err) {
          if (isNoNode(err)) resolve(null);
          else reject(adaptError(err));
        } else {
          resolve({ data, stat: stat as ZkStat });
        }
      });
    });
  }

  getChildren(path: ZkPath): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.client!.getChildren(path, (err, children) => {
        if (err) {
          if (isNoNode(err)) resolve([]);
          else reject(adaptError(err));
        } else {
          resolve(children);
        }
      });
    });
  }

  // Persistent watch: re-arms after each fire so the caller's cb sees every change.
  watchChildren(
    path: ZkPath,
    cb: (children: string[]) => void,
  ): Promise<string[]> {
    const rearm = () => {
      this.client!.getChildren(
        path,
        rearm,
        (err, children) => {
          if (!err) cb(children);
          else if (isNoNode(err)) cb([]);
        },
      );
    };
    return new Promise((resolve, reject) => {
      this.client!.getChildren(path, rearm, (err, children) => {
        if (err) {
          if (isNoNode(err)) resolve([]);
          else reject(adaptError(err));
        } else {
          resolve(children);
        }
      });
    });
  }

  watchData(
    path: ZkPath,
    cb: (data: Buffer | null) => void,
  ): Promise<Buffer | null> {
    const rearm = () => {
      this.client!.getData(path, rearm, (err, data) => {
        if (!err) cb(data);
        else if (isNoNode(err)) cb(null);
      });
    };
    return new Promise((resolve, reject) => {
      this.client!.getData(path, rearm, (err, data) => {
        if (err) {
          if (isNoNode(err)) resolve(null);
          else reject(adaptError(err));
        } else {
          resolve(data);
        }
      });
    });
  }

  delete(path: ZkPath, expectedVersion?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null) => {
        if (err) {
          if (isNoNode(err)) resolve();
          else reject(adaptError(err));
        } else {
          resolve();
        }
      };
      if (typeof expectedVersion === "number") {
        this.client!.remove(path, expectedVersion, cb);
      } else {
        this.client!.remove(path, cb);
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
