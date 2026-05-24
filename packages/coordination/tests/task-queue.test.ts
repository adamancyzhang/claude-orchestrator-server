// CORE-RETENTION
// Locks in: TaskQueue lifecycle through a real InMemoryZkClient — push →
// listPending → claim → complete archives, fail records the failure, retry
// re-enqueues, role-weight sorting picks the right candidate. Additionally:
// claim races swallow only ZkNodeExistsError; any other ZK failure bubbles
// up so a session expiry can never look like "no task to claim."
// Critical because: every Worker enters its execution loop here; a silent
// retry-on-ZK-failure (today's catch{} at claimById) hides cluster outages.
// Primary sources: packages/coordination/src/task-queue.ts

import { describe, expect, it, beforeEach } from "vitest";
import {
  asInstanceId,
  asTaskId,
  ZkSessionExpiredError,
  type IZkClient,
  type ZkPath,
  zkPaths,
} from "@co/contracts";
import { InMemoryZkClient } from "@co/infra";
import { TaskQueue, parseClaimedNodeName } from "../src/task-queue.js";

async function makeZk(): Promise<InMemoryZkClient> {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();
  return zk;
}

const ALICE = asInstanceId("inst-alice");
const BOB = asInstanceId("inst-bob");

describe("TaskQueue.push + listPending", () => {
  it("creates a sequential pending node and listPending returns the task", async () => {
    const zk = await makeZk();
    const q = new TaskQueue({ zk });

    const t = await q.push({
      title: "first",
      description: "d",
      criteria: "c",
      priority: 1,
      link: "execute",
      created_by_name: "Leader",
    });
    expect(t.id).toMatch(/^task-/);
    expect(t.status).toBe("pending");

    const pending = await q.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.title).toBe("first");
    expect(pending[0]?.link).toBe("execute");
  });

  it("preserves push order via sequential naming", async () => {
    const zk = await makeZk();
    const q = new TaskQueue({ zk });

    await q.push({ title: "a" });
    await q.push({ title: "b" });
    await q.push({ title: "c" });

    const pending = await q.listPending();
    expect(pending.map((t) => t.title)).toEqual(["a", "b", "c"]);
  });
});

describe("TaskQueue.claim — role-weighted candidate selection", () => {
  it("prefers a task whose link matches the claimer's role over other links", async () => {
    const zk = await makeZk();
    const q = new TaskQueue({ zk });

    // Order chosen so the FIFO tie-breaker would pick the verify task first;
    // role-weight sort must override that and hand the executor its execute.
    await q.push({ title: "v-task", link: "verify" });
    await q.push({ title: "e-task", link: "execute" });

    const claimed = await q.claim(ALICE, "executor");
    expect(claimed?.title).toBe("e-task");
    expect(claimed?.claimed_by).toBe(ALICE);
    expect(claimed?.status).toBe("claimed");
  });

  it("respects leader_only by funneling those tasks only to the leader role", async () => {
    const zk = await makeZk();
    const q = new TaskQueue({ zk });
    await q.push({ title: "ops", leader_only: true });
    expect(await q.claim(ALICE, "executor")).toBeNull();
    const leaderTask = await q.claim(asInstanceId("inst-leader"), "leader");
    expect(leaderTask?.title).toBe("ops");
  });

  it("prefers an assigned-to-me task even when role weight ties", async () => {
    const zk = await makeZk();
    const q = new TaskQueue({ zk });

    const unassigned = await q.push({ title: "any", link: "execute" });
    const assigned = await q.push({
      title: "mine",
      link: "execute",
      assigned_to: ALICE,
      assigned_to_name: "Alice",
    });

    const claimed = await q.claim(ALICE, "executor");
    expect(claimed?.id).toBe(assigned.id);
    expect(claimed?.id).not.toBe(unassigned.id);
  });
});

describe("TaskQueue.claimById — race losers vs real ZK failures (A3 regression)", () => {
  it("returns null when the race for the ephemeral node is lost (ZkNodeExistsError)", async () => {
    const zk = await makeZk();
    const q = new TaskQueue({ zk });
    const t = await q.push({ title: "race", link: "execute" });

    // First claim wins.
    const first = await q.claimById(t.id, ALICE);
    expect(first?.id).toBe(t.id);

    // Second claim by a different instance must NOT crash; the task is gone
    // from /pending — claimById returns null because data lookup is null.
    const second = await q.claimById(t.id, BOB);
    expect(second).toBeNull();
  });

  it("returns null when two claimers race for the same instance_id collision (ZkNodeExistsError surfaced from claim path)", async () => {
    // Build a scenario where the pending node is still readable but the
    // claimed ephemeral node already exists for the claimer. Today the
    // catch in claimById swallowed any error here; this test now asserts
    // the race-loss path returns null while leaving other errors free to
    // throw (next test).
    const zk = await makeZk();
    const q = new TaskQueue({ zk });
    const t = await q.push({ title: "race2", link: "execute" });

    // Pre-create the ephemeral claim node so the createEphemeral call inside
    // claimById will throw ZkNodeExistsError on attempt.
    await zk.createEphemeral(
      zkPaths.taskClaimed(ALICE, t.id),
      Buffer.from("{}"),
    );

    const result = await q.claimById(t.id, ALICE);
    expect(result).toBeNull();
  });

  it("PROPAGATES non-race ZK errors instead of treating them as race-loss", async () => {
    // RED test for the iron-law fix: previously claimById's `catch {}`
    // converted every ZK error into "lost the race." A ZkSessionExpired
    // (cluster outage, auth failure) must now bubble so the worker loop
    // halts loudly instead of looping over a healthy-looking "no task."
    const realZk = await makeZk();
    const q = new TaskQueue({ zk: failingClaimZk(realZk) });

    const real = new TaskQueue({ zk: realZk });
    const t = await real.push({ title: "boom", link: "execute" });

    await expect(q.claimById(t.id, ALICE)).rejects.toBeInstanceOf(
      ZkSessionExpiredError,
    );
  });
});

describe("TaskQueue.complete + listClaimed + getCompleted", () => {
  it("moves a claimed task to /completed and clears the claim node", async () => {
    const zk = await makeZk();
    const q = new TaskQueue({ zk });
    const t = await q.push({ title: "done", link: "execute" });
    await q.claim(ALICE, "executor");

    const claimedBefore = await q.listClaimed();
    expect(claimedBefore).toHaveLength(1);

    await q.complete(t.id, "ok", ALICE, "Alice", 4.2);

    const claimedAfter = await q.listClaimed();
    expect(claimedAfter).toHaveLength(0);

    const completed = await q.getCompleted(t.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toBe("ok");
    expect(completed?.completed_by_name).toBe("Alice");
    expect(completed?.duration_seconds).toBe(4.2);
  });
});

describe("TaskQueue.fail records the failure even when no claim exists", () => {
  it("archives a failed task with fail_reason and result=Failed:<reason>", async () => {
    const zk = await makeZk();
    const q = new TaskQueue({ zk });
    const t = await q.push({ title: "doomed" });

    await q.fail(t.id, "no candidate worker");

    const completed = await q.getCompleted(t.id);
    expect(completed?.status).toBe("failed");
    expect(completed?.fail_reason).toBe("no candidate worker");
    expect(completed?.result).toContain("no candidate worker");

    // pending must have been cleaned.
    const pending = await q.listPending();
    expect(pending).toHaveLength(0);
  });
});

describe("TaskQueue.retry re-enqueues with an incremented retry_count", () => {
  it("creates a new pending task carrying retry_count = prev + 1", async () => {
    const zk = await makeZk();
    const q = new TaskQueue({ zk });
    const t = await q.push({ title: "again" });
    await q.fail(t.id, "oops");

    const retried = await q.retry(t.id);
    expect(retried.retry_count).toBe(1);
    expect(retried.status).toBe("pending");
    expect(retried.title).toBe("again");

    const retried2 = await q.retry(retried.id, retried);
    expect(retried2.retry_count).toBe(2);
  });
});

describe("parseClaimedNodeName", () => {
  it("splits ephemeral node names of the form <instance>-<taskId>", () => {
    const parsed = parseClaimedNodeName("inst-alice-task-0000000003");
    expect(parsed).toEqual({
      instance_id: asInstanceId("inst-alice"),
      task_id: asTaskId("task-0000000003"),
    });
  });

  it("returns null when the name does not embed -task-", () => {
    expect(parseClaimedNodeName("garbage")).toBeNull();
  });
});

// ── test fixtures ────────────────────────────────────────────────────

/**
 * Wraps a real InMemoryZkClient so every createEphemeral call rejects with
 * ZkSessionExpiredError. Every other method delegates to the real client so
 * the rest of TaskQueue (getData, parse, etc.) runs against real state.
 *
 * This is a real IZkClient implementation — not a vi.fn() mock — used to
 * deterministically exercise the non-race ZK failure path. The skill bans
 * mocking internal collaborators; this stub is structurally analogous to
 * InMemoryZkClient itself (both are alternate IZkClient impls).
 */
function failingClaimZk(real: IZkClient): IZkClient {
  return {
    connect: () => real.connect(),
    close: () => real.close(),
    exists: (p: ZkPath) => real.exists(p),
    createPersistent: (p, d) => real.createPersistent(p, d),
    createPersistentSequential: (p, prefix, d) =>
      real.createPersistentSequential(p, prefix, d),
    createEphemeral: () => {
      throw new ZkSessionExpiredError("simulated session loss");
    },
    createEphemeralSequential: (p, prefix, d) =>
      real.createEphemeralSequential(p, prefix, d),
    setData: (p, d, v) => real.setData(p, d, v),
    getData: (p) => real.getData(p),
    getChildren: (p) => real.getChildren(p),
    watchChildren: (p, cb) => real.watchChildren(p, cb),
    watchData: (p, cb) => real.watchData(p, cb),
    delete: (p, v) => real.delete(p, v),
    mkdirp: (p) => real.mkdirp(p),
    get state() {
      return real.state;
    },
    on: (event, cb) => real.on(event, cb),
  };
}

