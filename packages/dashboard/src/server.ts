import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ILogger } from "@co/contracts";
import { SSEBroadcaster } from "./sse/broadcaster.js";
import { StateWatcher } from "./watcher.js";
import { createRouter } from "./routes/index.js";
import type { AuthConfig } from "./auth.js";
import { WSServer } from "./realtime/ws-server.js";
import { ChartDataAggregator } from "./realtime/chart-data.js";
import { HistoricalQuery } from "./realtime/historical-query.js";

// MIME type mappings for static files
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface DashboardServerOptions {
  /** Port to listen on (default: 3210) */
  port?: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** Path to orchestrator state directory */
  state_dir: string;
  /** Logger instance */
  logger?: ILogger;
  /** Authentication configuration */
  auth?: AuthConfig;
  /** Rate limiting configuration */
  rateLimit?: {
    maxRequests?: number;
    windowMs?: number;
  };
  /** Path to static files directory (default: public/) */
  static_dir?: string;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private broadcaster: SSEBroadcaster;
  private wsServer: WSServer;
  private chartData: ChartDataAggregator;
  private historicalQuery: HistoricalQuery;
  private watcher: StateWatcher;
  private port: number;
  private host: string;
  private state_dir: string;
  private static_dir: string;
  private logger?: ILogger;
  private auth?: AuthConfig;
  private rateLimit?: {
    maxRequests?: number;
    windowMs?: number;
  };

  constructor(opts: DashboardServerOptions) {
    this.port = opts.port ?? 3210;
    this.host = opts.host ?? "127.0.0.1";
    this.state_dir = opts.state_dir;
    this.logger = opts.logger;
    this.auth = opts.auth;
    this.rateLimit = opts.rateLimit;

    // Resolve static directory path
    this.static_dir = opts.static_dir ?? path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "public"
    );

    this.broadcaster = new SSEBroadcaster();
    this.wsServer = new WSServer();
    this.chartData = new ChartDataAggregator();
    this.historicalQuery = new HistoricalQuery();
    this.watcher = new StateWatcher(this.state_dir, this.logger);

    // Watch for state changes and broadcast to clients
    this.watcher.onUpdate((state) => {
      this.broadcaster.broadcast("state", state);
      this.wsServer.broadcast("state", state);
    });
  }

  /**
   * Start the dashboard server.
   */
  async start(): Promise<void> {
    const router = createRouter({
      state_dir: this.state_dir,
      broadcaster: this.broadcaster,
      logger: this.logger,
      auth: this.auth,
      rateLimit: this.rateLimit,
    });

    this.server = http.createServer((req, res) => {
      // Try to serve static files first
      if (req.method === "GET" && !req.url?.startsWith("/api/")) {
        const staticResult = this.serveStatic(req, res);
        if (staticResult) {
          return;
        }
      }
      // Fall back to API router
      router(req, res);
    });

    // Attach WebSocket server
    this.wsServer.attach(this.server);

    // Start watching for state changes
    this.watcher.start();

    return new Promise((resolve) => {
      this.server!.listen(this.port, this.host, () => {
        // Get the actual port (useful when port 0 is used for random port)
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }

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
    this.wsServer.closeAll();

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

  /**
   * Get the chart data aggregator.
   */
  getChartData(): ChartDataAggregator {
    return this.chartData;
  }

  /**
   * Get the historical query service.
   */
  getHistoricalQuery(): HistoricalQuery {
    return this.historicalQuery;
  }

  /**
   * Get the WebSocket server.
   */
  getWSServer(): WSServer {
    return this.wsServer;
  }

  /**
   * Serve a static file from the public directory.
   * Returns true if a file was served, false otherwise.
   */
  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    let reqPath = req.url ?? "/";

    // Default to index.html for root
    if (reqPath === "/") {
      reqPath = "/index.html";
    }

    // Security: prevent directory traversal
    const normalizedPath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, "");
    const filePath = path.join(this.static_dir, normalizedPath);

    // Check if file exists
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return false;
      }

      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }
}
