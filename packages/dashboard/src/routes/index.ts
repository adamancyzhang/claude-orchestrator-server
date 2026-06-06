import type { IncomingMessage, ServerResponse } from "node:http";
import type { ILogger } from "@co/contracts";
import type { SSEBroadcaster } from "../sse/broadcaster.js";
import { handleState } from "./state.js";
import { handleWorkers } from "./workers.js";
import { handleTasks } from "./tasks.js";
import { handleEvents } from "./events.js";
import { handleChains } from "./chains.js";
import { handleSend } from "./send.js";
import { handleSSE } from "../sse/handler.js";
import { createAuthMiddleware, sendUnauthorized, type AuthConfig } from "../auth.js";
import { RateLimiter } from "../rate-limit.js";
import { getApiDocs, generateDocsHtml } from "../docs.js";

export interface RouterConfig {
  state_dir: string;
  broadcaster: SSEBroadcaster;
  logger?: ILogger;
  auth?: AuthConfig;
  rateLimit?: {
    maxRequests?: number;
    windowMs?: number;
  };
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  state_dir: string,
  broadcaster: SSEBroadcaster,
  logger?: ILogger,
) => void;

/**
 * Create a router that handles all dashboard API requests.
 */
export function createRouter(config: RouterConfig): (req: IncomingMessage, res: ServerResponse) => void {
  const { state_dir, broadcaster, logger } = config;

  // Initialize auth middleware
  const authConfig: AuthConfig = config.auth ?? { enabled: false, tokens: [] };
  const authenticate = createAuthMiddleware(authConfig);

  // Initialize rate limiter
  const rateLimiter = new RateLimiter(config.rateLimit);

  return (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Get client IP for rate limiting
    const clientIp = req.socket.remoteAddress ?? "unknown";

    // Apply rate limiting
    const rateLimitResult = rateLimiter.check(clientIp);
    if (!rateLimitResult.allowed) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": Math.ceil(rateLimitResult.resetMs / 1000).toString(),
      });
      res.end(JSON.stringify({ error: "Rate limit exceeded" }));
      return;
    }

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", "100");
    res.setHeader("X-RateLimit-Remaining", rateLimitResult.remaining.toString());

    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route matching
    if (pathname === "/api/state" && req.method === "GET") {
      handleState(req, res, state_dir, broadcaster, logger);
    } else if (pathname === "/api/workers" && req.method === "GET") {
      handleWorkers(req, res, state_dir, broadcaster, logger);
    } else if (pathname === "/api/tasks" && req.method === "GET") {
      handleTasks(req, res, state_dir, broadcaster, logger);
    } else if (pathname === "/api/events" && req.method === "GET") {
      handleEvents(req, res, state_dir, broadcaster, logger);
    } else if (pathname === "/api/chains" && req.method === "GET") {
      handleChains(req, res, state_dir, broadcaster, logger);
    } else if (pathname === "/api/send" && req.method === "POST") {
      // Check authentication for send endpoint
      const authResult = authenticate(req);
      if (!authResult.authenticated) {
        sendUnauthorized(res, authResult.error);
        return;
      }
      handleSend(req, res, state_dir, broadcaster, logger);
    } else if (pathname === "/api/events/stream" && req.method === "GET") {
      handleSSE(req, res, broadcaster, logger);
    } else if (pathname === "/api/docs" && req.method === "GET") {
      // API documentation endpoint
      const accept = req.headers.accept ?? "";
      if (accept.includes("text/html")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(generateDocsHtml());
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getApiDocs(), null, 2));
      }
    } else if (pathname === "/api/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "1.0.0" }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  };
}
