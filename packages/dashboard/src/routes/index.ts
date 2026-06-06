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
export function createRouter(
  state_dir: string,
  broadcaster: SSEBroadcaster,
  logger?: ILogger,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
      handleSend(req, res, state_dir, broadcaster, logger);
    } else if (pathname === "/api/events/stream" && req.method === "GET") {
      handleSSE(req, res, broadcaster, logger);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  };
}
