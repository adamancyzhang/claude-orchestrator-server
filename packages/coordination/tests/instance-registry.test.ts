// CORE-RETENTION
// Locks in: InstanceRegistry creates ephemeral nodes scoped to the leader's
// session — register stores the full Instance payload, heartbeat merges
// patches without erasing prior state, list/get/watch reflect ephemeral
// lifetime, and unregister is idempotent.
// Critical because: leader scans the registry to detect dead workers and to
// dispatch by role; a heartbeat that silently drops fields (role, worktree,
// pid) would produce mis-routed task dispatch + false orphan detection.
// Primary sources: packages/coordination/src/instance-registry.ts

import { describe, expect, it } from "vitest";
import {
  asInstanceId,
  PROTOCOL_VERSION,
  ValidationError,
  zkPaths,
} from "@co/contracts";
import { InMemoryZkClient } from "@co/infra";
import { InstanceRegistry } from "../src/instance-registry.js";

async function makeZk(): Promise<InMemoryZkClient> {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();
  return zk;
}

describe("InstanceRegistry.register", () => {
  it("creates an ephemeral instance node with full payload + PROTOCOL_VERSION", async () => {
    const zk = await makeZk();
    const reg = new InstanceRegistry({ zk });

    const i = await reg.register({
      id: asInstanceId("inst-1"),
      name: "Alice",
      role: "executor",
      work_dir: "/tmp/proj",
    });

    expect(i.id).toBe("inst-1");
    expect(i.name).toBe("Alice");
    expect(i.role).toBe("executor");
    expect(i.status).toBe("idle");
    expect(i.work_dir).toBe("/tmp/proj");
    expect(i.protocol_version).toBe(PROTOCOL_VERSION);

    // Persisted under instances/<id>.
    const data = await zk.getData(zkPaths.instance(i.id));
    expect(data).not.toBeNull();
  });

  it("auto-generates a UUID-shaped id when none is provided", async () => {
    const zk = await makeZk();
    const reg = new InstanceRegistry({ zk });
    const i = await reg.register({ name: "Anon", role: "executor" });
    // UUIDs (no dashes) are 32 hex chars.
    expect(i.id).toMatch(/^[a-f0-9]{32}$/);
  });

  it("rejects an unknown role at the schema boundary", async () => {
    const zk = await makeZk();
    const reg = new InstanceRegistry({ zk });
    await expect(
      reg.register({
        name: "Wizard",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        role: "wizard" as any,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("InstanceRegistry.heartbeat", () => {
  it("merges a partial patch without erasing untouched fields", async () => {
    const zk = await makeZk();
    const reg = new InstanceRegistry({ zk });
    const i = await reg.register({
      name: "Alice",
      role: "executor",
      work_dir: "/tmp/x",
      pid: 42,
    });
    expect(i.pid).toBe(42);

    await reg.heartbeat(i.id, { status: "busy" });

    const fresh = await reg.get(i.id);
    expect(fresh?.status).toBe("busy");
    expect(fresh?.work_dir).toBe("/tmp/x");
    expect(fresh?.pid).toBe(42);
    expect(fresh?.role).toBe("executor");
  });

  it("is a no-op when the instance no longer exists (e.g. after unregister)", async () => {
    const zk = await makeZk();
    const reg = new InstanceRegistry({ zk });
    const gone = asInstanceId("ghost");
    // Should not throw and should leave the registry empty.
    await reg.heartbeat(gone, { status: "busy" });
    expect(await reg.list()).toEqual([]);
  });
});

describe("InstanceRegistry.list / get / unregister / watch", () => {
  it("list returns all currently-registered instances in arbitrary order", async () => {
    const zk = await makeZk();
    const reg = new InstanceRegistry({ zk });
    await reg.register({ name: "A", role: "executor" });
    await reg.register({ name: "B", role: "verifier" });
    const all = await reg.list();
    expect(all).toHaveLength(2);
    expect(all.map((i) => i.name).sort()).toEqual(["A", "B"]);
  });

  it("unregister deletes the node; subsequent get returns null", async () => {
    const zk = await makeZk();
    const reg = new InstanceRegistry({ zk });
    const i = await reg.register({ name: "A", role: "executor" });
    await reg.unregister(i.id);
    expect(await reg.get(i.id)).toBeNull();
    expect(await reg.list()).toEqual([]);
  });

  it("unregister tolerates a missing instance (idempotent)", async () => {
    const zk = await makeZk();
    const reg = new InstanceRegistry({ zk });
    await reg.unregister(asInstanceId("never-existed"));
  });

  it("watch fires the callback when an instance is added", async () => {
    const zk = await makeZk();
    const reg = new InstanceRegistry({ zk });

    const observed: number[] = [];
    const initial = await reg.watch((list) => {
      observed.push(list.length);
    });
    expect(initial).toEqual([]);

    await reg.register({ name: "A", role: "executor" });
    await new Promise((r) => setTimeout(r, 0));

    expect(observed.at(-1)).toBe(1);
  });
});
