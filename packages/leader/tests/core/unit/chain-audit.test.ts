// CORE-RETENTION
// Locks in: ChainAudit.openChain / setLinkTask / setLinkWorker / record /
//   closeChain manifest semantics. The manifest is the persistent source
//   of truth ChainRouter consults to (a) thread upstream task ids into
//   downstream dispatches and (b) route feedback to the prior-link
//   worker after a leader restart.
// Core path because: a regression on the manifest layout silently breaks
//   feedback routing across links and chain resume after leader restart.
// Owner subsystem: leader.
// Primary source files exercised:
//   - packages/leader/src/chain-audit.ts

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  asChainId,
  asInstanceId,
  asTaskId,
  cachePaths,
  ChainConflictError,
  type ILogger,
} from "@co/contracts";
import {
  ChainAudit,
  DEFAULT_MAX_TOTAL_RETRIES,
} from "../../../src/chain-audit.js";

class SilentLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
}

function makeAudit(): { audit: ChainAudit; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chain-audit-"));
  const audit = new ChainAudit({
    cache_paths: {
      projects_root: root,
      leader_instance_id: asInstanceId("leader-1"),
    },
    logger: new SilentLogger(),
  });
  return { audit, root };
}

describe("ChainAudit", () => {
  it("openChain seeds link_tasks and link_workers with five nulls each", async () => {
    const { audit } = makeAudit();
    const chainId = asChainId("chain-x");
    await audit.openChain(chainId, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
    });
    const m = await audit.readManifest(chainId);
    expect(m).not.toBeNull();
    expect(m!.link_tasks).toEqual({
      plan: null,
      execute: null,
      verify: null,
      review: null,
      accept: null,
      explore: null,
    });
    expect(m!.link_workers).toEqual({
      plan: null,
      execute: null,
      verify: null,
      review: null,
      accept: null,
      explore: null,
    });
    expect(m!.status).toBe("running");
  });

  it("setLinkWorker persists worker ids per link and survives reads", async () => {
    const { audit } = makeAudit();
    const chainId = asChainId("chain-y");
    await audit.openChain(chainId, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
    });
    await audit.setLinkWorker(chainId, "plan", asInstanceId("tom-01"));
    await audit.setLinkWorker(chainId, "execute", asInstanceId("jerry-01"));

    const m = await audit.readManifest(chainId);
    expect(m!.link_workers.plan).toBe(asInstanceId("tom-01"));
    expect(m!.link_workers.execute).toBe(asInstanceId("jerry-01"));
    expect(m!.link_workers.verify).toBeNull();
  });

  it("setLinkTask and setLinkWorker are independent — verifier feedback can update one without clearing the other", async () => {
    const { audit } = makeAudit();
    const chainId = asChainId("chain-z");
    await audit.openChain(chainId, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
    });
    await audit.setLinkTask(chainId, "execute", asTaskId("task-build-1"));
    await audit.setLinkWorker(chainId, "execute", asInstanceId("jerry-01"));
    // Simulate a build retry — new task id, same worker.
    await audit.setLinkTask(chainId, "execute", asTaskId("task-build-2"));

    const m = await audit.readManifest(chainId);
    expect(m!.link_tasks.execute).toBe("task-build-2");
    expect(m!.link_workers.execute).toBe(asInstanceId("jerry-01"));
  });

  it("closeChain stamps status and completed_at, appends chain_closed to audit.jsonl", async () => {
    const { audit, root } = makeAudit();
    const chainId = asChainId("chain-close");
    await audit.openChain(chainId, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
    });
    await audit.closeChain(chainId, "completed");
    const m = await audit.readManifest(chainId);
    expect(m!.status).toBe("completed");
    expect(m!.completed_at).not.toBeNull();

    const auditPath = cachePaths.chainAuditPath(
      { projects_root: root, leader_instance_id: asInstanceId("leader-1") },
      chainId,
    );
    const lines = fs
      .readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string });
    expect(lines.some((l) => l.event === "chain_opened")).toBe(true);
    expect(lines.some((l) => l.event === "chain_closed")).toBe(true);
  });

  it("openChain seeds total_retry_count=0 and the default ceiling", async () => {
    const { audit } = makeAudit();
    const chainId = asChainId("chain-retry-defaults");
    await audit.openChain(chainId, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
    });
    const m = await audit.readManifest(chainId);
    expect(m!.total_retry_count).toBe(0);
    expect(m!.max_total_retries).toBe(DEFAULT_MAX_TOTAL_RETRIES);
  });

  it("openChain honors an explicit max_total_retries override", async () => {
    const { audit } = makeAudit();
    const chainId = asChainId("chain-retry-override");
    await audit.openChain(chainId, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
      max_total_retries: 3,
    });
    const m = await audit.readManifest(chainId);
    expect(m!.max_total_retries).toBe(3);
  });

  it("incrementRetry bumps total_retry_count and reports the ceiling", async () => {
    const { audit } = makeAudit();
    const chainId = asChainId("chain-retry-bump");
    await audit.openChain(chainId, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
      max_total_retries: 2,
    });
    const first = await audit.incrementRetry(chainId);
    expect(first).toEqual({ total_retry_count: 1, max_total_retries: 2 });
    const second = await audit.incrementRetry(chainId);
    expect(second).toEqual({ total_retry_count: 2, max_total_retries: 2 });
    const m = await audit.readManifest(chainId);
    expect(m!.total_retry_count).toBe(2);
  });

  it("incrementRetry returns null when the manifest is missing", async () => {
    const { audit } = makeAudit();
    const result = await audit.incrementRetry(asChainId("chain-ghost"));
    expect(result).toBeNull();
  });

  it("openChain throws ChainConflictError when a chain is already completed", async () => {
    const { audit } = makeAudit();
    const chainId = asChainId("chain-once");
    await audit.openChain(chainId, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
    });
    await audit.closeChain(chainId, "completed");

    let caught: unknown = null;
    try {
      await audit.openChain(chainId, {
        created_at: "2026-05-15T00:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req2.md",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChainConflictError);
    const err = caught as ChainConflictError;
    expect(err.existing_status).toBe("completed");
    expect(err.existing_completed_at).not.toBeNull();

    // Manifest must still reflect the original closed state, not the
    // would-be overwrite.
    const m = await audit.readManifest(chainId);
    expect(m!.status).toBe("completed");
  });

  it("openChain throws ChainConflictError for aborted and merge_failed chains too", async () => {
    const { audit } = makeAudit();
    const aborted = asChainId("chain-aborted");
    await audit.openChain(aborted, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
    });
    await audit.closeChain(aborted, "aborted");
    await expect(
      audit.openChain(aborted, {
        created_at: "2026-05-15T00:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req2.md",
      }),
    ).rejects.toBeInstanceOf(ChainConflictError);

    const mergeFailed = asChainId("chain-merge-failed");
    await audit.openChain(mergeFailed, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
    });
    await audit.closeChain(mergeFailed, "merge_failed");
    await expect(
      audit.openChain(mergeFailed, {
        created_at: "2026-05-15T00:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req2.md",
      }),
    ).rejects.toBeInstanceOf(ChainConflictError);
  });

  it("openChain on a still-running chain is a no-op upsert (no conflict)", async () => {
    const { audit } = makeAudit();
    const chainId = asChainId("chain-running");
    await audit.openChain(chainId, {
      created_at: "2026-05-14T00:00:00Z",
      leader_id: asInstanceId("leader-1"),
      leader_name: "Leader",
      requirement_path: "/tmp/req.md",
    });
    // Re-opening a running chain must not throw — the manifest is just
    // rewritten to the same shape. This keeps replay/restart paths
    // unblocked.
    await expect(
      audit.openChain(chainId, {
        created_at: "2026-05-14T01:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req.md",
      }),
    ).resolves.toBeUndefined();
    const m = await audit.readManifest(chainId);
    expect(m!.status).toBe("running");
  });

  describe("link_commits API (v0.6 hash propagation)", () => {
    it("recordLinkCommit + collectUpstreamCommits round-trips per-link worktree hashes", async () => {
      const { audit } = makeAudit();
      const chainId = asChainId("chain-c");
      await audit.openChain(chainId, {
        created_at: "2026-05-17T00:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req.md",
      });
      await audit.recordLinkCommit(chainId, "plan", {
        worktree: "plan-sha-1",
        docs: "plan-docs-1",
        branch: "co/plan-1",
      });
      await audit.recordLinkCommit(chainId, "execute", {
        worktree: "build-sha-1",
        docs: null,
        branch: "co/build-1",
      });
      const upstream = await audit.collectUpstreamCommits(chainId);
      expect(upstream).toEqual({ plan: "plan-sha-1", execute: "build-sha-1" });
      // v0.7 NEW — accept IS surfaced as upstream (the explore link
      // rebases onto it). The recordLinkCommit call below adds it to
      // the manifest, and collectUpstreamCommits now returns it too.
      await audit.recordLinkCommit(chainId, "accept", {
        worktree: "accept-sha",
        docs: null,
        branch: "co/accept",
      });
      const upstream2 = await audit.collectUpstreamCommits(chainId);
      expect(upstream2).toEqual({
        plan: "plan-sha-1",
        execute: "build-sha-1",
        accept: "accept-sha",
      });
    });

    it("collectUpstreamCommits omits links with null worktree hash", async () => {
      const { audit } = makeAudit();
      const chainId = asChainId("chain-d");
      await audit.openChain(chainId, {
        created_at: "2026-05-17T00:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req.md",
      });
      await audit.recordLinkCommit(chainId, "plan", {
        worktree: "plan-sha",
        docs: null,
        branch: "co/plan",
      });
      // Build link recorded but with NO worktree commit (docs-only
      // task). Downstream consumers must not see a `build: null` key
      // in the map — they should fall back to plan as the predecessor.
      await audit.recordLinkCommit(chainId, "execute", {
        worktree: null,
        docs: "build-docs",
        branch: "co/build",
      });
      const upstream = await audit.collectUpstreamCommits(chainId);
      expect(upstream).toEqual({ plan: "plan-sha" });
      expect("execute" in upstream).toBe(false);
    });

    it("clearLinkCommitsFrom wipes the rejected link AND everything downstream", async () => {
      const { audit } = makeAudit();
      const chainId = asChainId("chain-e");
      await audit.openChain(chainId, {
        created_at: "2026-05-17T00:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req.md",
      });
      await audit.recordLinkCommit(chainId, "plan", {
        worktree: "p",
        docs: null,
        branch: "co/p",
      });
      await audit.recordLinkCommit(chainId, "execute", {
        worktree: "b",
        docs: null,
        branch: "co/b",
      });
      await audit.recordLinkCommit(chainId, "verify", {
        worktree: "v",
        docs: null,
        branch: "co/v",
      });
      // Feedback targets "execute" → execute, verify, review, accept all clear.
      await audit.clearLinkCommitsFrom(chainId, "execute");
      const m = await audit.readManifest(chainId);
      expect(m!.link_commits?.plan?.worktree).toBe("p");
      expect(m!.link_commits?.execute).toBeUndefined();
      expect(m!.link_commits?.verify).toBeUndefined();
      const upstream = await audit.collectUpstreamCommits(chainId);
      expect(upstream).toEqual({ plan: "p" });
    });
  });

  // v0.7 NEW — Chain Forest (FR-35) + appendChildChain wire-up.
  describe("Chain Forest (v0.7 NEW)", () => {
    it("openChain defaults forest fields for root chains", async () => {
      const { audit } = makeAudit();
      const chainId = asChainId("chain-root");
      await audit.openChain(chainId, {
        created_at: "2026-05-18T00:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req.md",
      });
      const m = await audit.readManifest(chainId);
      expect(m!.parent_chain_id).toBeNull();
      expect(m!.child_chain_ids).toEqual([]);
      expect(m!.chain_depth).toBe(0);
      expect(m!.magic_mode).toBe(false);
    });

    it("openChain captures magic_mode + parent_chain_id + chain_depth", async () => {
      const { audit } = makeAudit();
      const chainId = asChainId("chain-child");
      const parentId = asChainId("chain-parent");
      await audit.openChain(chainId, {
        created_at: "2026-05-18T00:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req.md",
        parent_chain_id: parentId,
        chain_depth: 2,
        magic_mode: true,
      });
      const m = await audit.readManifest(chainId);
      expect(m!.parent_chain_id).toBe(parentId);
      expect(m!.chain_depth).toBe(2);
      expect(m!.magic_mode).toBe(true);
      expect(m!.child_chain_ids).toEqual([]);
    });

    it("appendChildChain mutates the parent's child_chain_ids (idempotent)", async () => {
      const { audit } = makeAudit();
      const parentId = asChainId("chain-parent");
      const childA = asChainId("chain-child-a");
      const childB = asChainId("chain-child-b");
      await audit.openChain(parentId, {
        created_at: "2026-05-18T00:00:00Z",
        leader_id: asInstanceId("leader-1"),
        leader_name: "Leader",
        requirement_path: "/tmp/req.md",
        magic_mode: true,
      });
      await audit.appendChildChain(parentId, childA);
      await audit.appendChildChain(parentId, childB);
      // Idempotent: a duplicate append is a no-op.
      await audit.appendChildChain(parentId, childA);
      const m = await audit.readManifest(parentId);
      expect(m!.child_chain_ids).toEqual([childA, childB]);
    });

    it("readManifest coerces a v0.6 manifest into v0.7 defaults", async () => {
      const { audit, root } = makeAudit();
      const chainId = asChainId("chain-v06");
      // Hand-write a v0.6 manifest with no forest fields. Mirrors
      // disk state from a pre-upgrade chain.
      const manifestPath = cachePaths.chainManifestPath(
        { projects_root: root, leader_instance_id: asInstanceId("leader-1") },
        chainId,
      );
      await fs.promises.mkdir(require("node:path").dirname(manifestPath), {
        recursive: true,
      });
      await fs.promises.writeFile(
        manifestPath,
        JSON.stringify({
          chain_id: chainId,
          created_at: "2026-04-01T00:00:00Z",
          completed_at: null,
          status: "running",
          leader_id: "leader-1",
          leader_name: "Leader",
          requirement_path: "/tmp/req.md",
          link_tasks: {
            plan: null,
            execute: null,
            verify: null,
            review: null,
            accept: null,
          },
          link_workers: {
            plan: null,
            execute: null,
            verify: null,
            review: null,
            accept: null,
          },
          total_retry_count: 0,
          max_total_retries: 9,
        }),
        "utf-8",
      );
      const m = await audit.readManifest(chainId);
      expect(m!.parent_chain_id).toBeNull();
      expect(m!.child_chain_ids).toEqual([]);
      expect(m!.chain_depth).toBe(0);
      expect(m!.magic_mode).toBe(false);
    });
  });
});
