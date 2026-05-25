// CORE-RETENTION
// Locks in: pickImmediatePredecessor's per-link walk back through the
// chain order ("plan → execute → verify → review → accept", with
// "explore" walking the full list) and its fall-through to null when
// no upstream commit is recorded. Also locks in collectChainArtifacts'
// link-position truncation (plan→empty, execute→only plan, verify→…,
// explore→all 5), its return of 5 empty strings on missing chain_id,
// missing manifest file, or unparseable JSON — the deliberate
// fail-silent contract that template rendering depends on.
// Critical because: a regression in pickImmediatePredecessor sends the
// worker to rebase onto the wrong sha (silent merge of stale code) or
// fails to rebase at all (chain history breaks). A regression in
// collectChainArtifacts feeds the wrong upstream path into the task
// template — the worker then reads stale or unrelated artifacts as if
// they were its predecessor's output. Locking the truncation matrix
// pins the contract every task.md template depends on.
// Primary sources: packages/worker/src/chain-artifacts.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  cachePaths,
  type CachePathOptions,
  type TaskLink,
  type UpstreamCommits,
} from "@co/contracts";
import {
  collectChainArtifacts,
  LINK_TO_LOCAL_PREFIX,
  pickImmediatePredecessor,
} from "../src/chain-artifacts.js";

describe("pickImmediatePredecessor", () => {
  const allUpstream: UpstreamCommits = {
    plan: "sha-plan",
    execute: "sha-execute",
    verify: "sha-verify",
    review: "sha-review",
    accept: "sha-accept",
  };

  it("returns null when upstream is undefined", () => {
    expect(pickImmediatePredecessor("execute", undefined)).toBeNull();
  });

  it("returns null for the plan link (no predecessor)", () => {
    expect(pickImmediatePredecessor("plan", allUpstream)).toBeNull();
  });

  it("returns the immediate predecessor sha for each non-plan link", () => {
    expect(pickImmediatePredecessor("execute", allUpstream)).toBe("sha-plan");
    expect(pickImmediatePredecessor("verify", allUpstream)).toBe("sha-execute");
    expect(pickImmediatePredecessor("review", allUpstream)).toBe("sha-verify");
    expect(pickImmediatePredecessor("accept", allUpstream)).toBe("sha-review");
  });

  it("explore walks the full chain back-to-front and picks accept", () => {
    expect(pickImmediatePredecessor("explore", allUpstream)).toBe("sha-accept");
  });

  it("explore falls back through gaps when accept is missing", () => {
    const partial: UpstreamCommits = {
      plan: "sha-plan",
      execute: "sha-execute",
      verify: "sha-verify",
      review: null,
      accept: null,
    };
    expect(pickImmediatePredecessor("explore", partial)).toBe("sha-verify");
  });

  it("non-plan link tolerates gaps and walks further back", () => {
    // accept has only plan committed (chain skipped execute/verify/review).
    const sparse: UpstreamCommits = {
      plan: "sha-plan",
      execute: null,
      verify: null,
      review: null,
      accept: null,
    };
    expect(pickImmediatePredecessor("accept", sparse)).toBe("sha-plan");
  });

  it("returns null when every upstream slot is empty", () => {
    expect(pickImmediatePredecessor("verify", {})).toBeNull();
  });
});

describe("LINK_TO_LOCAL_PREFIX — exhaustive map", () => {
  it("covers every TaskLink value", () => {
    const links: TaskLink[] = [
      "plan",
      "execute",
      "verify",
      "review",
      "accept",
      "explore",
    ];
    for (const l of links) {
      expect(LINK_TO_LOCAL_PREFIX[l]).toBe(l);
    }
  });
});

describe("collectChainArtifacts", () => {
  let projectsRoot: string;
  const leaderId = asInstanceId("leader-x");

  function makeCachePaths(): CachePathOptions {
    return { projects_root: projectsRoot, leader_instance_id: leaderId };
  }

  beforeEach(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "co-art-"));
  });

  afterEach(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  function writeManifest(
    cp: CachePathOptions,
    chainId: string,
    linkTasks: Record<string, string | null>,
  ): void {
    const chainDir = cachePaths.chainDir(cp, asChainId(chainId));
    fs.mkdirSync(chainDir, { recursive: true });
    fs.writeFileSync(
      cachePaths.chainManifestPath(cp, asChainId(chainId)),
      JSON.stringify({ link_tasks: linkTasks }),
      "utf-8",
    );
  }

  const EMPTY = {
    plan: "",
    execute: "",
    verify: "",
    review: "",
    accept: "",
  };

  it("returns 5 empty strings when chain_id is null", async () => {
    const cp = makeCachePaths();
    expect(await collectChainArtifacts(cp, null, "execute")).toEqual(EMPTY);
  });

  it("returns 5 empty strings when link is null", async () => {
    const cp = makeCachePaths();
    expect(await collectChainArtifacts(cp, asChainId("c-1"), null)).toEqual(EMPTY);
  });

  it("returns 5 empty strings when link is 'decompose'", async () => {
    const cp = makeCachePaths();
    expect(
      await collectChainArtifacts(cp, asChainId("c-1"), "decompose"),
    ).toEqual(EMPTY);
  });

  it("returns 5 empty strings when manifest file does not exist", async () => {
    const cp = makeCachePaths();
    expect(
      await collectChainArtifacts(cp, asChainId("missing"), "execute"),
    ).toEqual(EMPTY);
  });

  it("returns 5 empty strings when manifest JSON is corrupt", async () => {
    const cp = makeCachePaths();
    const chainDir = cachePaths.chainDir(cp, asChainId("bad"));
    fs.mkdirSync(chainDir, { recursive: true });
    fs.writeFileSync(
      cachePaths.chainManifestPath(cp, asChainId("bad")),
      "not json {",
      "utf-8",
    );
    expect(await collectChainArtifacts(cp, asChainId("bad"), "execute")).toEqual(EMPTY);
  });

  it("execute link receives plan only (per truncation matrix)", async () => {
    const cp = makeCachePaths();
    writeManifest(cp, "c-2", {
      plan: "task-plan",
      execute: "task-execute",
      verify: "task-verify",
      review: "task-review",
      accept: "task-accept",
    });

    const got = await collectChainArtifacts(cp, asChainId("c-2"), "execute");
    expect(got.plan).toBe(
      cachePaths.taskResultPath(cp, "task-plan" as never),
    );
    expect(got.execute).toBe("");
    expect(got.verify).toBe("");
    expect(got.review).toBe("");
    expect(got.accept).toBe("");
  });

  it("review link receives plan + execute + verify", async () => {
    const cp = makeCachePaths();
    writeManifest(cp, "c-3", {
      plan: "tp",
      execute: "te",
      verify: "tv",
      review: "tr",
      accept: "ta",
    });

    const got = await collectChainArtifacts(cp, asChainId("c-3"), "review");
    expect(got.plan).toBe(cachePaths.taskResultPath(cp, "tp" as never));
    expect(got.execute).toBe(cachePaths.taskResultPath(cp, "te" as never));
    expect(got.verify).toBe(cachePaths.taskResultPath(cp, "tv" as never));
    expect(got.review).toBe("");
    expect(got.accept).toBe("");
  });

  it("explore link receives all 5 (full upstream context)", async () => {
    const cp = makeCachePaths();
    writeManifest(cp, "c-4", {
      plan: "tp",
      execute: "te",
      verify: "tv",
      review: "tr",
      accept: "ta",
    });

    const got = await collectChainArtifacts(cp, asChainId("c-4"), "explore");
    expect(got.plan).toBe(cachePaths.taskResultPath(cp, "tp" as never));
    expect(got.execute).toBe(cachePaths.taskResultPath(cp, "te" as never));
    expect(got.verify).toBe(cachePaths.taskResultPath(cp, "tv" as never));
    expect(got.review).toBe(cachePaths.taskResultPath(cp, "tr" as never));
    expect(got.accept).toBe(cachePaths.taskResultPath(cp, "ta" as never));
  });

  it("missing entries in manifest yield empty strings (no fallback)", async () => {
    const cp = makeCachePaths();
    writeManifest(cp, "c-5", {
      plan: "tp",
      // execute intentionally omitted
      verify: "tv",
      review: null,
      accept: null,
    });

    const got = await collectChainArtifacts(cp, asChainId("c-5"), "review");
    expect(got.plan).toBe(cachePaths.taskResultPath(cp, "tp" as never));
    expect(got.execute).toBe("");
    expect(got.verify).toBe(cachePaths.taskResultPath(cp, "tv" as never));
    expect(got.review).toBe("");
  });
});
