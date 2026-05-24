// CORE-RETENTION
// Locks in: ChainAudit fs invariants — openChain on a terminal manifest
// throws ChainConflictError; clearLinkCommitsFrom wipes the target link
// and every downstream link, leaving upstream intact; incrementRetry
// returns monotonic post-increment counts; readManifest coerces legacy
// (v0.6) manifests missing forest fields to defaults;
// writeManifestAtomic survives concurrent writes leaving a parseable
// file behind every time.
// Critical because: chain-router routes retries and merges off these
// exact values. A regression that lets a closed chain be reopened or
// that loses retry monotonicity would let runaway feedback loops bypass
// the retry ceiling.
// Primary sources: packages/leader/src/chain-audit.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  asChainId,
  asInstanceId,
  asTaskId,
  cachePaths,
  ChainConflictError,
  type ChainId,
  type ILogger,
} from "@co/contracts";
import { ChainAudit } from "../src/chain-audit.js";

let projectsRoot: string;
let leaderId: ReturnType<typeof asInstanceId>;

beforeEach(() => {
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "co-chain-audit-"));
  leaderId = asInstanceId("leader-test");
});

afterEach(() => {
  fs.rmSync(projectsRoot, { recursive: true, force: true });
});

const SILENT_LOGGER: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT_LOGGER,
} as unknown as ILogger;

function makeAudit(): ChainAudit {
  return new ChainAudit({
    cache_paths: { projects_root: projectsRoot, leader_instance_id: leaderId },
    logger: SILENT_LOGGER,
  });
}

const META = {
  created_at: "2025-01-01T00:00:00Z",
  leader_id: asInstanceId("leader-test"),
  leader_name: "Leader",
  requirement_path: "/req.md",
};

describe("ChainAudit.openChain", () => {
  it("creates a running manifest with default forest fields", async () => {
    const a = makeAudit();
    const c = asChainId("c-1");
    await a.openChain(c, META);
    const m = await a.readManifest(c);
    expect(m?.status).toBe("running");
    expect(m?.parent_chain_id).toBeNull();
    expect(m?.chain_depth).toBe(0);
    expect(m?.magic_mode).toBe(false);
    expect(m?.total_retry_count).toBe(0);
    expect(m?.link_tasks.execute).toBeNull();
  });

  it("is an upsert on a still-running chain (idempotent replay)", async () => {
    const a = makeAudit();
    const c = asChainId("c-1");
    await a.openChain(c, META);
    await a.openChain(c, { ...META, requirement_path: "/req-new.md" });
    const m = await a.readManifest(c);
    expect(m?.status).toBe("running");
    expect(m?.requirement_path).toBe("/req-new.md");
  });

  it("rejects re-open of a closed chain with ChainConflictError", async () => {
    const a = makeAudit();
    const c = asChainId("c-1");
    await a.openChain(c, META);
    await a.closeChain(c, "completed");

    await expect(a.openChain(c, META)).rejects.toBeInstanceOf(ChainConflictError);
  });
});

describe("ChainAudit.clearLinkCommitsFrom", () => {
  it("wipes target link + downstream, leaves upstream intact", async () => {
    const a = makeAudit();
    const c = asChainId("c-1");
    await a.openChain(c, META);

    // Pre-populate all five core link commits.
    for (const link of ["plan", "execute", "verify", "review", "accept"] as const) {
      await a.recordLinkCommit(c, link, {
        worktree: `sha-${link}`,
        docs: null,
        branch: `b-${link}`,
      });
    }

    await a.clearLinkCommitsFrom(c, "verify");

    const m = await a.readManifest(c);
    expect(m?.link_commits?.plan?.worktree).toBe("sha-plan");
    expect(m?.link_commits?.execute?.worktree).toBe("sha-execute");
    expect(m?.link_commits?.verify).toBeUndefined();
    expect(m?.link_commits?.review).toBeUndefined();
    expect(m?.link_commits?.accept).toBeUndefined();
  });

  it("collectUpstreamCommits reflects the wiped state", async () => {
    const a = makeAudit();
    const c = asChainId("c-1");
    await a.openChain(c, META);
    await a.recordLinkCommit(c, "plan", {
      worktree: "p1",
      docs: null,
      branch: "b/p",
    });
    await a.recordLinkCommit(c, "execute", {
      worktree: "e1",
      docs: null,
      branch: "b/e",
    });
    await a.clearLinkCommitsFrom(c, "execute");
    const upstream = await a.collectUpstreamCommits(c);
    expect(upstream).toEqual({ plan: "p1" });
  });
});

describe("ChainAudit.incrementRetry", () => {
  it("returns monotonic post-increment counts persisted across reads", async () => {
    const a = makeAudit();
    const c = asChainId("c-1");
    await a.openChain(c, META);

    const r1 = await a.incrementRetry(c);
    const r2 = await a.incrementRetry(c);
    const r3 = await a.incrementRetry(c);
    expect(r1?.total_retry_count).toBe(1);
    expect(r2?.total_retry_count).toBe(2);
    expect(r3?.total_retry_count).toBe(3);

    const m = await a.readManifest(c);
    expect(m?.total_retry_count).toBe(3);
  });

  it("returns null when the manifest does not exist", async () => {
    const a = makeAudit();
    const result = await a.incrementRetry(asChainId("never-opened"));
    expect(result).toBeNull();
  });
});

describe("ChainAudit.readManifest — v0.6 backward compat", () => {
  it("coerces legacy manifest missing the four forest fields to defaults", async () => {
    const c = asChainId("c-legacy");
    const manifestPath = cachePaths.chainManifestPath(
      { projects_root: projectsRoot, leader_instance_id: leaderId },
      c,
    );
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        chain_id: c,
        created_at: "2024-01-01T00:00:00Z",
        completed_at: null,
        status: "running",
        leader_id: leaderId,
        leader_name: "Leader",
        requirement_path: "/req.md",
        link_tasks: {
          plan: null,
          execute: null,
          verify: null,
          review: null,
          accept: null,
          explore: null,
        },
        link_workers: {
          plan: null,
          execute: null,
          verify: null,
          review: null,
          accept: null,
          explore: null,
        },
        total_retry_count: 0,
        max_total_retries: 9,
        // forest fields intentionally absent
      }),
    );

    const a = makeAudit();
    const m = await a.readManifest(c);
    expect(m).not.toBeNull();
    expect(m?.parent_chain_id).toBeNull();
    expect(m?.child_chain_ids).toEqual([]);
    expect(m?.chain_depth).toBe(0);
    expect(m?.magic_mode).toBe(false);
  });

  it("returns null when the manifest file is missing", async () => {
    const a = makeAudit();
    const m = await a.readManifest(asChainId("never-existed"));
    expect(m).toBeNull();
  });
});

describe("ChainAudit.writeManifestAtomic (via concurrent setLinkTask)", () => {
  it("leaves the manifest always parseable under concurrent writes", async () => {
    const a = makeAudit();
    const c = asChainId("c-concur");
    await a.openChain(c, META);

    const writes = Array.from({ length: 20 }, (_, i) =>
      a.setLinkTask(c, "execute", asTaskId(`task-${i}`)),
    );
    await Promise.all(writes);

    // Manifest must be parseable AND must reflect one of the writes.
    const m = await a.readManifest(c);
    expect(m?.link_tasks.execute).toMatch(/^task-\d+$/);

    // No tmp files left lingering.
    const chainDir = cachePaths.chainDir(
      { projects_root: projectsRoot, leader_instance_id: leaderId },
      c,
    );
    const leftover = fs
      .readdirSync(chainDir)
      .filter((f) => f.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });
});

describe("ChainAudit.record + closeChain", () => {
  it("appends one jsonl line per record + closes with the chosen status", async () => {
    const a = makeAudit();
    const c = asChainId("c-1");
    await a.openChain(c, META);
    await a.record(c, { event: "task_dispatch", link: "execute" });
    await a.record(c, { event: "task_completed", link: "execute" });
    await a.closeChain(c, "completed");

    const auditPath = cachePaths.chainAuditPath(
      { projects_root: projectsRoot, leader_instance_id: leaderId },
      c,
    );
    const lines = fs
      .readFileSync(auditPath, "utf-8")
      .split("\n")
      .filter(Boolean);
    // chain_opened + task_dispatch + task_completed + chain_closed = 4 events
    expect(lines).toHaveLength(4);
    const parsed = lines.map((l) => JSON.parse(l) as { event: string });
    expect(parsed.map((p) => p.event)).toEqual([
      "chain_opened",
      "task_dispatch",
      "task_completed",
      "chain_closed",
    ]);

    const m = await a.readManifest(c);
    expect(m?.status).toBe("completed");
    expect(m?.completed_at).not.toBeNull();
  });
});

describe("ChainAudit.appendChildChain", () => {
  it("appends a child chain id idempotently", async () => {
    const a = makeAudit();
    const parent: ChainId = asChainId("c-parent");
    const child: ChainId = asChainId("c-child");
    await a.openChain(parent, META);

    await a.appendChildChain(parent, child);
    await a.appendChildChain(parent, child); // idempotent

    const m = await a.readManifest(parent);
    expect(m?.child_chain_ids).toEqual([child]);
  });
});
