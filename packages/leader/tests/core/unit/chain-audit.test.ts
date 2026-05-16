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
      build: null,
      verify: null,
      review: null,
      accept: null,
    });
    expect(m!.link_workers).toEqual({
      plan: null,
      build: null,
      verify: null,
      review: null,
      accept: null,
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
    await audit.setLinkWorker(chainId, "build", asInstanceId("jerry-01"));

    const m = await audit.readManifest(chainId);
    expect(m!.link_workers.plan).toBe(asInstanceId("tom-01"));
    expect(m!.link_workers.build).toBe(asInstanceId("jerry-01"));
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
    await audit.setLinkTask(chainId, "build", asTaskId("task-build-1"));
    await audit.setLinkWorker(chainId, "build", asInstanceId("jerry-01"));
    // Simulate a build retry — new task id, same worker.
    await audit.setLinkTask(chainId, "build", asTaskId("task-build-2"));

    const m = await audit.readManifest(chainId);
    expect(m!.link_tasks.build).toBe("task-build-2");
    expect(m!.link_workers.build).toBe(asInstanceId("jerry-01"));
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
});
