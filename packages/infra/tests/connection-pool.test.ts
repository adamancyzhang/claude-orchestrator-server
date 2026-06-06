import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IZkClient, ZkConnectionState } from "@co/contracts";
import { ConnectionPool } from "../src/zk/connection-pool.js";

// ── Test double ──────────────────────────────────────────────────────

class MockZkClient implements IZkClient {
  private _state: ZkConnectionState = "connecting";
  private _closed = false;
  private readonly listeners: Record<string, Array<() => void>> = {
    expired: [],
    disconnected: [],
    reconnected: [],
  };

  get state(): ZkConnectionState {
    return this._state;
  }

  get closed(): boolean {
    return this._closed;
  }

  async connect(): Promise<void> {
    this._state = "connected";
  }

  async close(): Promise<void> {
    this._closed = true;
    this._state = "disconnected";
  }

  on(event: "expired" | "disconnected" | "reconnected", cb: () => void): void {
    this.listeners[event].push(cb);
  }

  // Stub implementations for IZkClient methods
  async exists(): Promise<boolean> { return true; }
  async mkdirp(): Promise<void> {}
  async createPersistent(): Promise<any> { return "/test"; }
  async createPersistentSequential(): Promise<any> { return "/test-0"; }
  async createEphemeral(): Promise<any> { return "/test"; }
  async createEphemeralSequential(): Promise<any> { return "/test-0"; }
  async setData(): Promise<any> { return { version: 0 }; }
  async getData(): Promise<any> { return { data: Buffer.from(""), stat: { version: 0 } }; }
  async getChildren(): Promise<string[]> { return []; }
  async watchChildren(): Promise<string[]> { return []; }
  async watchData(): Promise<Buffer | null> { return null; }
  async delete(): Promise<void> {}
}

// ── Helpers ───────────────────────────────────────────────────────────

function createMockFactory(): () => MockZkClient {
  return () => new MockZkClient();
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("ConnectionPool", () => {
  let pool: ConnectionPool;

  afterEach(async () => {
    if (pool && pool.getState() === "running") {
      await pool.stop();
    }
  });

  describe("lifecycle", () => {
    it("starts with minimum connections", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();

      const stats = pool.getStats();
      expect(stats.total).toBe(2);
      expect(stats.idle).toBe(2);
      expect(stats.active).toBe(0);
    });

    it("stops and closes all connections", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();
      expect(pool.getState()).toBe("running");

      await pool.stop();
      expect(pool.getState()).toBe("closed");

      const stats = pool.getStats();
      expect(stats.total).toBe(0);
    });

    it("rejects acquire after stop", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();
      await pool.stop();

      await expect(pool.acquire()).rejects.toThrow("Connection pool is closed");
    });
  });

  describe("acquire and release", () => {
    it("acquires idle connection", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();

      const client = await pool.acquire();
      expect(client).toBeDefined();
      expect(client.state).toBe("connected");

      const stats = pool.getStats();
      expect(stats.active).toBe(1);
      expect(stats.idle).toBe(1);
    });

    it("creates new connection when pool not full", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();

      // Acquire all idle connections
      const client1 = await pool.acquire();
      const client2 = await pool.acquire();

      // Should create new connection
      const client3 = await pool.acquire();

      expect(client1).not.toBe(client2);
      expect(client2).not.toBe(client3);

      const stats = pool.getStats();
      expect(stats.total).toBe(3);
      expect(stats.active).toBe(3);
    });

    it("reuses released connection", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();

      const client1 = await pool.acquire();
      pool.release(client1);

      const client2 = await pool.acquire();
      expect(client2).toBe(client1);
    });

    it("release updates stats", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();

      const client = await pool.acquire();
      expect(pool.getStats().active).toBe(1);

      pool.release(client);
      expect(pool.getStats().active).toBe(0);
      expect(pool.getStats().idle).toBe(2);
    });
  });

  describe("pool full scenario", () => {
    it("waits for connection when pool is full", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 1,
        max_size: 2,
        acquire_timeout_ms: 1000,
      });

      await pool.start();

      // Acquire all connections
      const client1 = await pool.acquire();
      const client2 = await pool.acquire();

      // Start waiting for a connection
      let acquired = false;
      let waitedClient: IZkClient | null = null;

      const waitPromise = (async () => {
        waitedClient = await pool.acquire();
        acquired = true;
      })();

      // Release a connection
      pool.release(client1);

      await waitPromise;

      expect(acquired).toBe(true);
      expect(waitedClient).toBe(client1);
    });

    it("times out when pool is full and no release", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 1,
        max_size: 2,
        acquire_timeout_ms: 100,
      });

      await pool.start();

      // Acquire all connections
      await pool.acquire();
      await pool.acquire();

      // Should timeout
      await expect(pool.acquire()).rejects.toThrow("Acquire timeout");

      const stats = pool.getStats();
      expect(stats.acquire_failures).toBe(1);
    });
  });

  describe("stats", () => {
    it("tracks created connections", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();

      const stats = pool.getStats();
      expect(stats.created).toBe(2);
      expect(stats.destroyed).toBe(0);
    });

    it("tracks acquire count", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();

      await pool.acquire();
      await pool.acquire();

      const stats = pool.getStats();
      expect(stats.acquire_count).toBe(2);
    });

    it("tracks waiting count", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 1,
        max_size: 2,
        acquire_timeout_ms: 1000,
      });

      await pool.start();

      // Acquire all connections
      await pool.acquire();
      await pool.acquire();

      // Start waiting
      const waitPromise = pool.acquire().catch(() => {});

      const stats = pool.getStats();
      expect(stats.waiting).toBe(1);

      // Cleanup
      await waitPromise;
    });
  });

  describe("error handling", () => {
    it("handles connection factory failure", async () => {
      let callCount = 0;
      const factory = () => {
        callCount++;
        if (callCount === 1) {
          // Return a mock that will fail during connect
          const mock = new MockZkClient();
          const originalConnect = mock.connect.bind(mock);
          mock.connect = async () => {
            throw new Error("Connection failed");
          };
          return mock;
        }
        return new MockZkClient();
      };

      pool = new ConnectionPool(factory, {
        min_size: 2,
        max_size: 5,
      });

      // Should still start with partial connections (1 out of 2)
      await pool.start();

      const stats = pool.getStats();
      expect(stats.created).toBe(1); // Only 1 created before failure
    });

    it("ignores release of unknown client", async () => {
      pool = new ConnectionPool(createMockFactory(), {
        min_size: 2,
        max_size: 5,
      });

      await pool.start();

      const unknownClient = new MockZkClient();
      pool.release(unknownClient); // Should not throw

      const stats = pool.getStats();
      expect(stats.idle).toBe(2);
    });
  });
});
