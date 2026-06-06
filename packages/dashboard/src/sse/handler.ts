import type { IncomingMessage, ServerResponse } from "node:http";
import type { ILogger } from "@co/contracts";
import type { SSEBroadcaster } from "./broadcaster.js";

/**
 * GET /api/events/stream - SSE endpoint for real-time updates.
 */
export function handleSSE(
  req: IncomingMessage,
  res: ServerResponse,
  broadcaster: SSEBroadcaster,
  logger?: ILogger,
): void {
  const clientId = broadcaster.addClient(res);

  logger?.info("SSE client connected", { client_id: clientId });

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Clean up on disconnect
  res.on("close", () => {
    clearInterval(heartbeat);
    broadcaster.removeClient(clientId);
    logger?.info("SSE client disconnected", { client_id: clientId });
  });
}
