import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ILogger } from "@co/contracts";
import { SSEBroadcaster } from "./sse/broadcaster.js";
import { StateWatcher } from "./watcher.js";
import { createRouter } from "./routes/index.js";

export interface DashboardServerOptions {
  /** Port to listen on (default: 3210) */
  port?: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** Path to orchestrator state directory */
  state_dir: string;
  /** Logger instance */
  logger?: ILogger;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private broadcaster: SSEBroadcaster;
  private watcher: StateWatcher;
  private port: number;
  private host: string;
  private state_dir: string;
  private logger?: ILogger;

  constructor(opts: DashboardServerOptions) {
    this.port = opts.port ?? 3210;
    this.host = opts.host ?? "127.0.0.1";
    this.state_dir = opts.state_dir;
    this.logger = opts.logger;

    this.broadcaster = new SSEBroadcaster();
    this.watcher = new StateWatcher(this.state_dir, this.logger);

    // Watch for state changes and broadcast to clients
    this.watcher.onUpdate((state) => {
      this.broadcaster.broadcast("state", state);
    });
  }

  /**
   * Start the dashboard server.
   */
  async start(): Promise<void> {
    const router = createRouter(this.state_dir, this.broadcaster, this.logger);

    this.server = http.createServer((req, res) => {
      router(req, res);
    });

    // Start watching for state changes
    this.watcher.start();

    return new Promise((resolve) => {
      this.server!.listen(this.port, this.host, () => {
        this.logger?.info("dashboard server started", {
          host: this.host,
          port: this.port,
          state_dir: this.state_dir,
        });
        resolve();
      });
    });
  }

  /**
   * Stop the dashboard server.
   */
  async stop(): Promise<void> {
    this.watcher.stop();
    this.broadcaster.closeAll();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger?.info("dashboard server stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the server port.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the server host.
   */
  getHost(): string {
    return this.host;
  }
}
