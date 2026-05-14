import { vi } from "vitest";

type WatchCb = (children: string[]) => void;

export interface MockZkOpts {
  initialInstances?: Record<string, unknown>;
  initialPendingTasks?: Record<string, unknown>;
  initialClaimedTasks?: Record<string, unknown>;
  initialMessages?: Record<string, Record<string, unknown>>;
}

let nextTaskNumber = 1;
let nextMsgNumber = 1;

export class MockZkClient {
  private _connected = true;
  private leader: unknown = null;
  instances = new Map<string, unknown>();
  pendingTasks = new Map<string, unknown>();
  claimedTasks = new Map<string, unknown>();
  completedTasks = new Map<string, unknown>();
  messages = new Map<string, Map<string, unknown>>();

  private instanceWatchers: WatchCb[] = [];
  private pendingWatchers: WatchCb[] = [];
  private claimedWatchers: WatchCb[] = [];
  private messageWatchers = new Map<string, WatchCb[]>();

  mkdirp = vi.fn(async (_p: string) => {});
  connect = vi.fn(async () => { this._connected = true; });
  disconnect = vi.fn(async () => { this._connected = false; });

  constructor(opts: MockZkOpts = {}) {
    for (const [id, data] of Object.entries(opts.initialInstances ?? {})) {
      this.instances.set(id, data);
    }
    for (const [id, data] of Object.entries(opts.initialPendingTasks ?? {})) {
      this.pendingTasks.set(id, data);
    }
    for (const [name, data] of Object.entries(opts.initialClaimedTasks ?? {})) {
      this.claimedTasks.set(name, data);
    }
    for (const [insId, msgs] of Object.entries(opts.initialMessages ?? {})) {
      this.messages.set(insId, new Map(Object.entries(msgs)));
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  setConnected(v: boolean): void {
    this._connected = v;
  }

  // ── Leader ──
  createLeader = vi.fn(async (data: unknown) => {
    this.leader = data;
  });
  getLeader = vi.fn(async () => this.leader);

  // ── Instance ──
  registerInstance = vi.fn(async (id: string, data: unknown) => {
    this.instances.set(id, data);
    this.fireInstanceWatch();
  });
  getInstance = vi.fn(async (id: string) => this.instances.get(id) ?? null);
  updateInstance = vi.fn(async (id: string, data: unknown) => {
    this.instances.set(id, data);
    this.fireInstanceWatch();
  });
  listInstances = vi.fn(async () => Array.from(this.instances.values()));
  deleteInstance = vi.fn(async (id: string) => {
    this.instances.delete(id);
    this.fireInstanceWatch();
  });

  // ── Pending Tasks ──
  createPendingTask = vi.fn(async (data: unknown) => {
    const id = `task-${String(nextTaskNumber++).padStart(10, "0")}`;
    this.pendingTasks.set(id, data);
    this.firePendingWatch();
    return id;
  });
  getPendingTask = vi.fn(async (id: string) => this.pendingTasks.get(id) ?? null);
  listPendingTasks = vi.fn(async () => {
    const ids = Array.from(this.pendingTasks.keys()).sort();
    return ids.map((id) => [id, this.pendingTasks.get(id)] as [string, unknown]);
  });
  deletePendingTask = vi.fn(async (id: string) => {
    this.pendingTasks.delete(id);
    this.firePendingWatch();
  });

  // ── Claimed Tasks ──
  claimTask = vi.fn(async (instanceId: string, taskId: string, _data: Buffer = Buffer.alloc(0)) => {
    const key = `${instanceId}-${taskId}`;
    if (this.claimedTasks.has(key)) return false;
    this.claimedTasks.set(key, this.pendingTasks.get(taskId) ?? {});
    this.fireClaimedWatch();
    return true;
  });
  getClaimedTask = vi.fn(async (instanceId: string, taskId: string) => {
    return this.claimedTasks.get(`${instanceId}-${taskId}`) ?? {};
  });
  listClaimedTasks = vi.fn(async () => {
    const keys = Array.from(this.claimedTasks.keys()).sort();
    return keys.map((key) => {
      const idx = key.indexOf("-");
      const insId = key.substring(0, idx);
      const taskId = key.substring(idx + 1);
      return [insId, taskId, this.claimedTasks.get(key)] as [string, string, unknown];
    });
  });
  updateClaimedTask = vi.fn(async (instanceId: string, taskId: string, data: unknown) => {
    this.claimedTasks.set(`${instanceId}-${taskId}`, data);
  });
  deleteClaimedTask = vi.fn(async (instanceId: string, taskId: string) => {
    this.claimedTasks.delete(`${instanceId}-${taskId}`);
    this.fireClaimedWatch();
  });

  saveCompletedTask = vi.fn(async (taskId: string, data: unknown) => {
    this.completedTasks.set(taskId, data);
  });
  getCompletedTask = vi.fn(async (taskId: string) => this.completedTasks.get(taskId) ?? null);
  listCompletedTasks = vi.fn(async () => Array.from(this.completedTasks.values()));

  // ── Messages ──
  createMessage = vi.fn(async (instanceId: string, data: unknown) => {
    if (!this.messages.has(instanceId)) this.messages.set(instanceId, new Map());
    const id = `msg-${String(nextMsgNumber++).padStart(10, "0")}`;
    this.messages.get(instanceId)!.set(id, data);
    this.fireMessageWatch(instanceId);
    return id;
  });
  getMessage = vi.fn(async (instanceId: string, msgId: string) => {
    return this.messages.get(instanceId)?.get(msgId) ?? null;
  });
  updateMessage = vi.fn(async (instanceId: string, msgId: string, data: unknown) => {
    this.messages.get(instanceId)?.set(msgId, data);
  });
  listMessages = vi.fn(async (instanceId: string) => {
    const m = this.messages.get(instanceId);
    if (!m) return [];
    const ids = Array.from(m.keys()).sort();
    return ids.map((id) => [id, m.get(id)] as [string, unknown]);
  });
  deleteMessage = vi.fn(async (instanceId: string, msgId: string) => {
    this.messages.get(instanceId)?.delete(msgId);
    this.fireMessageWatch(instanceId);
  });

  // ── Watch operations ──
  watchInstances = vi.fn(async (cb: WatchCb): Promise<string[]> => {
    this.instanceWatchers.push(cb);
    return Array.from(this.instances.keys());
  });
  watchPendingTasks = vi.fn(async (cb: WatchCb): Promise<string[]> => {
    this.pendingWatchers.push(cb);
    return Array.from(this.pendingTasks.keys()).sort();
  });
  watchClaimedTasks = vi.fn(async (cb: WatchCb): Promise<string[]> => {
    this.claimedWatchers.push(cb);
    return Array.from(this.claimedTasks.keys()).sort();
  });
  watchMessageDir = vi.fn(async (instanceId: string, cb: WatchCb): Promise<string[]> => {
    if (!this.messageWatchers.has(instanceId)) this.messageWatchers.set(instanceId, []);
    this.messageWatchers.get(instanceId)!.push(cb);
    return Array.from(this.messages.get(instanceId)?.keys() ?? []).sort();
  });

  // ── Manual fire helpers (drive callbacks from tests) ──
  fireInstanceWatch(): void {
    const children = Array.from(this.instances.keys());
    const cbs = this.instanceWatchers.splice(0);
    for (const cb of cbs) cb(children);
  }
  firePendingWatch(): void {
    const children = Array.from(this.pendingTasks.keys()).sort();
    const cbs = this.pendingWatchers.splice(0);
    for (const cb of cbs) cb(children);
  }
  fireClaimedWatch(): void {
    const children = Array.from(this.claimedTasks.keys()).sort();
    const cbs = this.claimedWatchers.splice(0);
    for (const cb of cbs) cb(children);
  }
  fireMessageWatch(instanceId: string): void {
    const m = this.messages.get(instanceId);
    const children = Array.from(m?.keys() ?? []).sort();
    const cbs = this.messageWatchers.get(instanceId)?.splice(0) ?? [];
    for (const cb of cbs) cb(children);
  }

  resetWatchers(): void {
    this.instanceWatchers = [];
    this.pendingWatchers = [];
    this.claimedWatchers = [];
    this.messageWatchers.clear();
  }
}

export function resetSequenceCounters(): void {
  nextTaskNumber = 1;
  nextMsgNumber = 1;
}
