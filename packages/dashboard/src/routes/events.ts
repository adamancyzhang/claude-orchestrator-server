import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ILogger } from "@co/contracts";
import type { SSEBroadcaster } from "../sse/broadcaster.js";

/**
 * GET /api/events - Return event history.
 */
export function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  state_dir: string,
  broadcaster: SSEBroadcaster,
  logger?: ILogger,
): void {
  const state_path = path.join(state_dir, "state.json");

  try {
    if (!fs.existsSync(state_path)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "State file not found" }));
      return;
    }

    const content = fs.readFileSync(state_path, "utf-8");
    const state = JSON.parse(content);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ events: state.events ?? [] }));
  } catch (err) {
    logger?.error("failed to read events", { error: String(err) });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to read events" }));
  }
}
