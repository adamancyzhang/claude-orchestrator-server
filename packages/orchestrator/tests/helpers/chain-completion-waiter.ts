// Test helper: polls `<co_root>/chains/<chain_id>/audit.jsonl` for a
// target audit event so the e2e test can synchronously wait for the
// `plan → execute → verify → review → accept → close_chain` flow to
// finish without racing the in-process worker watchers.
//
// All paths come from `cachePaths` (packages/contracts/src/paths/cachePaths.ts)
// so the helper tracks any future relocation of the CO root layout.

import * as fs from "node:fs";
import * as path from "node:path";
import { cachePaths, type ChainId } from "@co/contracts";
import type {
  ChainAuditEventType,
  ChainManifest,
} from "@co/leader";

export interface ChainAuditRecord {
  ts: string;
  chain_id: string;
  event: ChainAuditEventType;
  link: string | null;
  worker_id: string | null;
  worker_name: string | null;
  task_id: string | null;
  payload: Record<string, unknown> | null;
}

export interface WaitForEventOptions {
  cache_paths: cachePaths.CachePathOptions;
  chain_id: ChainId;
  event: ChainAuditEventType;
  /** Default 30s — long enough for a 5-link chain on a slow CI runner. */
  timeout_ms?: number;
  interval_ms?: number;
}

export async function waitForChainEvent(
  opts: WaitForEventOptions,
): Promise<ChainAuditRecord> {
  const auditPath = cachePaths.chainAuditPath(opts.cache_paths, opts.chain_id);
  const timeout = opts.timeout_ms ?? 30_000;
  const interval = opts.interval_ms ?? 50;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const records = await safeReadAudit(auditPath);
    const match = records.find((r) => r.event === opts.event);
    if (match) return match;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForChainEvent timeout: event=${opts.event} chain=${opts.chain_id} after ${timeout}ms ` +
      `(audit=${auditPath})`,
  );
}

/**
 * Wait until *any* chain's audit.jsonl reports `chain_closed`. Useful
 * when the test doesn't know the chain_id upfront (the leader generates
 * it during decompose).
 */
export async function waitForAnyChainClosed(opts: {
  cache_paths: cachePaths.CachePathOptions;
  timeout_ms?: number;
  interval_ms?: number;
}): Promise<{ chain_id: ChainId; record: ChainAuditRecord }> {
  // `cachePaths` has no chainsDir() export — derive from coRoot.
  const chainsDir = path.join(cachePaths.coRootDir(opts.cache_paths), "chains");
  const timeout = opts.timeout_ms ?? 30_000;
  const interval = opts.interval_ms ?? 50;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fs.existsSync(chainsDir)) {
      for (const entry of await fs.promises.readdir(chainsDir)) {
        const auditPath = cachePaths.chainAuditPath(
          opts.cache_paths,
          entry as ChainId,
        );
        const records = await safeReadAudit(auditPath);
        const closed = records.find((r) => r.event === "chain_closed");
        if (closed) {
          return { chain_id: entry as ChainId, record: closed };
        }
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForAnyChainClosed timeout after ${timeout}ms (chainsDir=${chainsDir})`,
  );
}

export async function readManifest(opts: {
  cache_paths: cachePaths.CachePathOptions;
  chain_id: ChainId;
}): Promise<ChainManifest> {
  const p = cachePaths.chainManifestPath(opts.cache_paths, opts.chain_id);
  const raw = await fs.promises.readFile(p, "utf-8");
  return JSON.parse(raw) as ChainManifest;
}

export async function readAuditLog(opts: {
  cache_paths: cachePaths.CachePathOptions;
  chain_id: ChainId;
}): Promise<readonly ChainAuditRecord[]> {
  const p = cachePaths.chainAuditPath(opts.cache_paths, opts.chain_id);
  return safeReadAudit(p);
}

async function safeReadAudit(p: string): Promise<ChainAuditRecord[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(p, "utf-8");
  } catch {
    return [];
  }
  const out: ChainAuditRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ChainAuditRecord);
    } catch {
      // Truncated tail line during concurrent write — skip.
    }
  }
  return out;
}
