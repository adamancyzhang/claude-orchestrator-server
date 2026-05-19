// TRUST-JUSTIFICATION: In-memory IZkClient implementation used by
// `packages/orchestrator/tests/core/e2e/startup-worker-6.test.ts`.
// Downstream: replaces `packages/infra/src/zk/client.ts` ZkClient.
// Reason: the eval doc `docs/evals/01-startup-worker-6.md` describes the
//   ZK node tree that startup *must* produce; running this against real ZK
//   would require docker-compose and would not let the test snapshot the
//   tree directly. The fake honors the IZkClient protocol surface the
//   production code depends on (atomic create, ephemeral flag, watch
//   re-arm on child changes, sequential numbering).
// Evidence: protocol contract is `packages/contracts/src/interfaces/zk.ts`
//   lines 15-55. Every method below maps 1:1 to a method on `IZkClient`.
//   Real ZK semantics are exercised elsewhere via integration tests once
//   reintroduced under `packages/*/tests/core/integration/` against
//   docker-compose. This fake is observable-only (no I/O beyond memory)
//   so the assertions in the e2e test are deterministic.

import {
  asZkPath,
  ZkNodeExistsError,
  ZkNodeNotFoundError,
  type IZkClient,
  type ZkConnectionState,
  type ZkPath,
  type ZkStat,
} from "@co/contracts";

interface Node {
  data: Buffer;
  ephemeral: boolean;
  version: number;
  ctime: number;
  mtime: number;
  // Per-parent sequential counter (only valid on parent nodes).
  seq: Map<string, number>;
}

export interface ZkTreeNode {
  name: string;
  path: string;
  ephemeral: boolean;
  data: string | null;
  children: ZkTreeNode[];
}

export class InMemoryZkClient implements IZkClient {
  private readonly nodes = new Map<string, Node>();
  private readonly childWatches = new Map<string, Array<(children: string[]) => void>>();
  private readonly dataWatches = new Map<string, Array<(data: Buffer | null) => void>>();
  private readonly ensurePaths: readonly ZkPath[];
  private _state: ZkConnectionState = "connecting";

  constructor(opts: { ensure_paths?: readonly ZkPath[] } = {}) {
    this.ensurePaths = opts.ensure_paths ?? [];
    // Root node exists from the start so child lookups under "/" work.
    this.nodes.set("/", this.makeNode(Buffer.alloc(0), false));
  }

  get state(): ZkConnectionState {
    return this._state;
  }

  on(): void {
    // No-op: the fake never emits expired/disconnected/reconnected.
  }

  async connect(): Promise<void> {
    for (const p of this.ensurePaths) await this.mkdirp(p);
    this._state = "connected";
  }

  async close(): Promise<void> {
    this._state = "disconnected";
    // Drop ephemeral nodes to match ZK semantics on session close.
    const drop: string[] = [];
    for (const [path, node] of this.nodes) {
      if (node.ephemeral) drop.push(path);
    }
    for (const path of drop) this.deleteOne(path);
  }

  async exists(path: ZkPath): Promise<boolean> {
    return this.nodes.has(path);
  }

  async createPersistent(path: ZkPath, data: Buffer): Promise<ZkPath> {
    return this.createOne(path, data, false);
  }

  async createPersistentSequential(
    parent: ZkPath,
    prefix: string,
    data: Buffer,
  ): Promise<ZkPath> {
    const seqPath = this.allocateSequential(parent, prefix);
    return this.createOne(asZkPath(seqPath), data, false);
  }

  async createEphemeral(path: ZkPath, data: Buffer): Promise<ZkPath> {
    return this.createOne(path, data, true);
  }

  async createEphemeralSequential(
    parent: ZkPath,
    prefix: string,
    data: Buffer,
  ): Promise<ZkPath> {
    const seqPath = this.allocateSequential(parent, prefix);
    return this.createOne(asZkPath(seqPath), data, true);
  }

  async setData(
    path: ZkPath,
    data: Buffer,
    expectedVersion?: number,
  ): Promise<ZkStat> {
    const node = this.nodes.get(path);
    if (!node) throw new ZkNodeNotFoundError(`no node at ${path}`);
    if (typeof expectedVersion === "number" && node.version !== expectedVersion) {
      throw new Error(`version mismatch at ${path}`);
    }
    node.data = Buffer.from(data);
    node.version += 1;
    node.mtime = Date.now();
    this.fireDataWatch(path, node.data);
    return { version: node.version, ctime: node.ctime, mtime: node.mtime };
  }

  async getData(
    path: ZkPath,
  ): Promise<{ data: Buffer; stat: ZkStat } | null> {
    const node = this.nodes.get(path);
    if (!node) return null;
    return {
      data: Buffer.from(node.data),
      stat: { version: node.version, ctime: node.ctime, mtime: node.mtime },
    };
  }

  async getChildren(path: ZkPath): Promise<string[]> {
    if (!this.nodes.has(path)) return [];
    return this.directChildrenNames(path);
  }

  async watchChildren(
    path: ZkPath,
    cb: (children: string[]) => void,
  ): Promise<string[]> {
    const list = this.childWatches.get(path) ?? [];
    list.push(cb);
    this.childWatches.set(path, list);
    return this.getChildren(path);
  }

  async watchData(
    path: ZkPath,
    cb: (data: Buffer | null) => void,
  ): Promise<Buffer | null> {
    const list = this.dataWatches.get(path) ?? [];
    list.push(cb);
    this.dataWatches.set(path, list);
    const node = this.nodes.get(path);
    return node ? Buffer.from(node.data) : null;
  }

  async delete(path: ZkPath, expectedVersion?: number): Promise<void> {
    const node = this.nodes.get(path);
    if (!node) return; // Match real client: deleting missing node is a no-op
    if (typeof expectedVersion === "number" && node.version !== expectedVersion) {
      throw new Error(`version mismatch at ${path}`);
    }
    this.deleteOne(path);
  }

  async mkdirp(path: ZkPath): Promise<void> {
    const segments = path.split("/").filter((s) => s.length > 0);
    let acc = "";
    for (const seg of segments) {
      acc = `${acc}/${seg}`;
      if (!this.nodes.has(acc)) {
        this.nodes.set(acc, this.makeNode(Buffer.alloc(0), false));
        this.fireChildWatch(parentOf(acc));
      }
    }
  }

  // --- introspection (test-only) ---

  /**
   * Returns a JSON-serializable tree rooted at `rootPath` (defaults to
   * the project root from zkPaths). Used for snapshot comparisons in
   * tests. The shape matches `docs/evals/01-startup-worker-6.md §3.7`.
   */
  dumpTree(rootPath: ZkPath = asZkPath("/claude-orchestrator")): ZkTreeNode {
    return this.buildTree(rootPath);
  }

  private buildTree(p: string): ZkTreeNode {
    const node = this.nodes.get(p);
    const name = p === "/" ? "/" : p.split("/").pop()!;
    const children = this.directChildrenNames(p)
      .map((c) => this.buildTree(p === "/" ? `/${c}` : `${p}/${c}`))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      name,
      path: p,
      ephemeral: node?.ephemeral ?? false,
      data: node && node.data.length > 0 ? node.data.toString("utf-8") : null,
      children,
    };
  }

  // --- internals ---

  private makeNode(data: Buffer, ephemeral: boolean): Node {
    const now = Date.now();
    return {
      data: Buffer.from(data),
      ephemeral,
      version: 0,
      ctime: now,
      mtime: now,
      seq: new Map(),
    };
  }

  private createOne(path: ZkPath, data: Buffer, ephemeral: boolean): ZkPath {
    if (this.nodes.has(path)) {
      throw new ZkNodeExistsError(`node exists at ${path}`);
    }
    const parent = parentOf(path);
    // Auto-create intermediate parents (mkdirp-on-create) so leaf writes
    // don't need separate mkdirp calls. Matches the production
    // ZkClient + the way callers like InstanceRegistry assume the
    // parent exists from `ensure_paths`.
    if (parent !== "/" && !this.nodes.has(parent)) {
      this.mkdirp(asZkPath(parent));
    }
    this.nodes.set(path, this.makeNode(data, ephemeral));
    this.fireChildWatch(parent);
    return path;
  }

  private deleteOne(path: string): void {
    // Recursively delete children too. Real ZK requires empty nodes,
    // but the fake mirrors close()'s session-end ephemeral sweep where
    // child cleanup happens automatically.
    const toDelete = [path, ...this.descendants(path)];
    for (const p of toDelete) this.nodes.delete(p);
    this.fireChildWatch(parentOf(path));
  }

  private descendants(path: string): string[] {
    const prefix = path === "/" ? "/" : `${path}/`;
    const out: string[] = [];
    for (const p of this.nodes.keys()) {
      if (p === path) continue;
      if (p.startsWith(prefix)) out.push(p);
    }
    return out;
  }

  private directChildrenNames(path: string): string[] {
    const prefix = path === "/" ? "/" : `${path}/`;
    const out: string[] = [];
    for (const p of this.nodes.keys()) {
      if (!p.startsWith(prefix)) continue;
      if (p === path) continue;
      const remainder = p.slice(prefix.length);
      if (remainder.length === 0) continue;
      if (remainder.includes("/")) continue;
      out.push(remainder);
    }
    return out;
  }

  private allocateSequential(parent: ZkPath, prefix: string): string {
    let parentNode = this.nodes.get(parent);
    if (!parentNode) {
      // Auto-create parent if missing (mirrors ZK behavior under
      // ensure_paths + mkdirp).
      void this.mkdirp(parent);
      parentNode = this.nodes.get(parent)!;
    }
    const next = (parentNode.seq.get(prefix) ?? 0);
    parentNode.seq.set(prefix, next + 1);
    const sequence = next.toString().padStart(10, "0");
    return `${parent}/${prefix}${sequence}`;
  }

  private fireChildWatch(path: string): void {
    const watchers = this.childWatches.get(path);
    if (!watchers || watchers.length === 0) return;
    // Production `ZkClient.watchChildren` (packages/infra/src/zk/client.ts:294-319)
    // re-arms internally on every fire, so callbacks behave as a persistent
    // subscription. Keep them registered across fires.
    const snapshot = watchers.slice();
    const kids = this.directChildrenNames(path);
    for (const cb of snapshot) {
      try {
        cb(kids);
      } catch {
        // swallow per IZkClient convention
      }
    }
  }

  private fireDataWatch(path: string, data: Buffer | null): void {
    const watchers = this.dataWatches.get(path);
    if (!watchers || watchers.length === 0) return;
    const snapshot = watchers.slice();
    for (const cb of snapshot) {
      try {
        cb(data ? Buffer.from(data) : null);
      } catch {
        // swallow
      }
    }
  }
}

function parentOf(p: string): string {
  if (p === "/" || !p.includes("/")) return "/";
  const idx = p.lastIndexOf("/");
  return idx === 0 ? "/" : p.slice(0, idx);
}
