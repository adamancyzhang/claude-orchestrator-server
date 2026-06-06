import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ILogger } from "@co/contracts";
import type { SSEBroadcaster } from "../sse/broadcaster.js";

/**
 * POST /api/send - Send a command to the orchestrator.
 */
export function handleSend(
  req: IncomingMessage,
  res: ServerResponse,
  state_dir: string,
  broadcaster: SSEBroadcaster,
  logger?: ILogger,
): void {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    try {
      const command = JSON.parse(body);
      const commandsPath = path.join(state_dir, "commands.jsonl");

      // Ensure state directory exists
      if (!fs.existsSync(state_dir)) {
        fs.mkdirSync(state_dir, { recursive: true });
      }

      // Append command to commands.jsonl
      const entry = {
        ...command,
        timestamp: new Date().toISOString(),
      };
      fs.appendFileSync(commandsPath, JSON.stringify(entry) + "\n");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Command sent" }));
    } catch (err) {
      logger?.error("failed to send command", { error: String(err) });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid command" }));
    }
  });
}
