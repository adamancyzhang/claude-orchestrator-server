import type { IZkClient, ZkConnectionState, ZkPath, ZkStat } from "@co/contracts";

export interface ConnectionPoolOptions {
  /** Maximum number of connections in the pool */
  max_size?: number;
  /** Minimum number of connections to maintain */
  min_size?: number;
  /** Maximum time (ms) a connection can be idle before being closed */
  idle_timeout_ms?: number;
  /** Maximum time (ms) to wait for a connection from the pool */
  acquire_timeout_ms?: number;
  /** Health check interval (ms) */
  health_check_interval_ms?: number;
}

export interface PoolStats {
  /** Total connections in the pool */
  total: number;
  /** Active (checked out) connections */
  active: number;
  /** Idle (available) connections */
  idle: number;
  /** Connections waiting to be created */
  waiting: number;
  /** Total connections created since pool started */
  created: number;
  /** Total connections destroyed since pool started */
  destroyed: number;
  /** Total successful acquires */
  acquire_count: number;
  /** Total failed acquires (timeouts) */
  acquire_failures: number;
}

interface PooledConnection {
  client: IZkClient;
  id: string;
  created_at: number;
  last_used_at: number;
  in_use: boolean;
}

/**
 * Connection pool for managing IZkClient instances.
 *
 * Reuses connections to reduce overhead from establishing new connections.
 * Connections are lazily created up to max_size and recycled when returned.
 */
export class ConnectionPool {
  private readonly maxSize: number;
  private readonly minSize: number;
  private readonly idleTimeoutMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly connections: PooledConnection[] = [];
  private readonly waitQueue: Array<{
    resolve: (conn: PooledConnection) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private nextId = 1;

  // Stats
  private stats = {
    created: 0,
    destroyed: 0,
    acquire_count: 0,
    acquire_failures: 0,
  };

  private readonly connectionFactory: () => IZkClient;

  constructor(
    connectionFactory: () => IZkClient,
    options: ConnectionPoolOptions = {},
  ) {
    this.connectionFactory = connectionFactory;
    this.maxSize = options.max_size ?? 10;
    this.minSize = options.min_size ?? 2;
    this.idleTimeoutMs = options.idle_timeout_ms ?? 300_000; // 5 minutes
    this.acquireTimeoutMs = options.acquire_timeout_ms ?? 10_000; // 10 seconds
    this.healthCheckIntervalMs = options.health_check_interval_ms ?? 60_000; // 1 minute
  }

  /**
   * Start the pool and create minimum connections.
   */
  async start(): Promise<void> {
    // Create minimum connections, tolerating partial failures
    for (let i = 0; i < this.minSize; i++) {
      try {
        const conn = await this.createConnection();
        this.connections.push(conn);
      } catch {
        // Failed to create connection, continue with fewer connections
        // Health check will attempt to replenish later
      }
    }

    // Start health check interval
    this.healthCheckTimer = setInterval(() => {
      void this.healthCheck();
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop the pool and close all connections.
   */
  async stop(): Promise<void> {
    this.closed = true;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Reject all waiting acquires
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Connection pool closed"));
    }
    this.waitQueue.length = 0;

    // Close all connections
    const closePromises = this.connections.map(async (conn) => {
      try {
        await conn.client.close();
        this.stats.destroyed++;
      } catch {
        // Ignore close errors
      }
    });

    await Promise.all(closePromises);
    this.connections.length = 0;
  }

  /**
   * Acquire a connection from the pool.
   * Returns a connection that must be released back via release().
   */
  async acquire(): Promise<IZkClient> {
    if (this.closed) {
      throw new Error("Connection pool is closed");
    }

    // Try to get an idle connection
    const idleConn = this.connections.find(
      (c) => !c.in_use && c.client.state === "connected",
    );

    if (idleConn) {
      idleConn.in_use = true;
      idleConn.last_used_at = Date.now();
      this.stats.acquire_count++;
      return idleConn.client;
    }

    // Create new connection if under max size
    if (this.connections.length < this.maxSize) {
      const conn = await this.createConnection();
      conn.in_use = true;
      this.connections.push(conn);
      this.stats.acquire_count++;
      return conn.client;
    }

    // Wait for a connection to be released
    return new Promise<IZkClient>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
        this.stats.acquire_failures++;
        reject(new Error("Acquire timeout: no connections available"));
      }, this.acquireTimeoutMs);

      this.waitQueue.push({
        resolve: (conn) => {
          clearTimeout(timeout);
          resolve(conn.client);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout,
      });
    });
  }

  /**
   * Release a connection back to the pool.
   */
  release(client: IZkClient): void {
    const conn = this.connections.find((c) => c.client === client);
    if (!conn) {
      return; // Not from this pool, ignore
    }

    conn.in_use = false;
    conn.last_used_at = Date.now();

    // If there are waiting acquires, give them this connection
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      conn.in_use = true;
      conn.last_used_at = Date.now();
      waiter.resolve(conn);
    }
  }

  /**
   * Get current pool statistics.
   */
  getStats(): PoolStats {
    const idle = this.connections.filter((c) => !c.in_use).length;
    const active = this.connections.filter((c) => c.in_use).length;

    return {
      total: this.connections.length,
      active,
      idle,
      waiting: this.waitQueue.length,
      created: this.stats.created,
      destroyed: this.stats.destroyed,
      acquire_count: this.stats.acquire_count,
      acquire_failures: this.stats.acquire_failures,
    };
  }

  /**
   * Get the current state of the pool.
   */
  getState(): "running" | "closed" {
    return this.closed ? "closed" : "running";
  }

  private async createConnection(): Promise<PooledConnection> {
    const client = this.connectionFactory();
    await client.connect();

    this.stats.created++;

    return {
      client,
      id: `pool-${this.nextId++}`,
      created_at: Date.now(),
      last_used_at: Date.now(),
      in_use: false,
    };
  }

  private async healthCheck(): Promise<void> {
    if (this.closed) return;

    const now = Date.now();

    // Close idle connections that have exceeded idle timeout
    const toRemove: PooledConnection[] = [];
    for (const conn of this.connections) {
      if (
        !conn.in_use &&
        now - conn.last_used_at > this.idleTimeoutMs &&
        this.connections.length - toRemove.length > this.minSize
      ) {
        toRemove.push(conn);
      }
    }

    for (const conn of toRemove) {
      const idx = this.connections.indexOf(conn);
      if (idx !== -1) {
        this.connections.splice(idx, 1);
        try {
          await conn.client.close();
          this.stats.destroyed++;
        } catch {
          // Ignore close errors
        }
      }
    }

    // Ensure minimum connections
    while (this.connections.length < this.minSize && !this.closed) {
      try {
        const conn = await this.createConnection();
        this.connections.push(conn);
      } catch {
        // Failed to create connection, will retry on next health check
        break;
      }
    }
  }
}
