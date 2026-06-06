import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ILogger } from "@co/contracts";
import type { SSEBroadcaster } from "../sse/broadcaster.js";

/**
 * GET /api/chains - Return audit chain data.
 */
export function handleChains(
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

    // Extract chain info from events
    const chains = extractChains(state);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ chains }));
  } catch (err) {
    logger?.error("failed to read chains", { error: String(err) });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to read chains" }));
  }
}

function extractChains(state: Record<string, unknown>): Array<Record<string, unknown>> {
  const events = (state as { events?: Array<Record<string, unknown>> }).events ?? [];
  const activated = new Map<string, string>();
  const closed = new Set<string>();
  const spawned = new Map<string, { parent: string; depth: number }>();
  const mergeFailed = new Set<string>();

  for (const e of events) {
    if (e.type === "chain_activated") {
      activated.set(e.chain_id as string, e.timestamp as string);
    } else if (e.type === "chain_closed") {
      closed.add(e.chain_id as string);
    } else if (e.type === "chain_spawned") {
      spawned.set(e.child_chain_id as string, {
        parent: e.parent_chain_id as string,
        depth: e.chain_depth as number,
      });
    } else if (e.type === "chain_merge_failed") {
      mergeFailed.add(e.chain_id as string);
    }
  }

  const allTasks = [
    ...((state as { pending_tasks?: Array<Record<string, unknown>> }).pending_tasks ?? []),
    ...((state as { in_progress_tasks?: Array<Record<string, unknown>> }).in_progress_tasks ?? []),
  ];

  const chainIds = new Set<string>(activated.keys());
  for (const t of allTasks) {
    if (t.chain_id) chainIds.add(t.chain_id as string);
  }

  return Array.from(chainIds).map((cid) => {
    const isActive = activated.has(cid) && !closed.has(cid);
    const tasks = allTasks.filter((t) => t.chain_id === cid);
    const spawnInfo = spawned.get(cid);

    return {
      chain_id: cid,
      status: mergeFailed.has(cid)
        ? "merge_failed"
        : isActive
          ? "active"
          : "closed",
      spawned_from: spawnInfo?.parent ?? null,
      depth: spawnInfo?.depth ?? null,
      task_count: tasks.length,
    };
  });
}
