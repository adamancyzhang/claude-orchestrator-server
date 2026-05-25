// CORE-RETENTION
// Locks in: InMemoryZkClient honours the IZkClient contract — exists/
// create/delete are tree-consistent, sequential nodes allocate
// monotonic 10-digit suffixes per (parent, prefix), watches fire on
// direct-child mutations only, ephemeral nodes evict on close, and
// optimistic version checks throw on mismatch.
// Critical because: every other test in the workspace (coordination,
// leader, worker, runtime integration) uses InMemoryZkClient as a
// stand-in for real ZooKeeper. If the fake silently drifts from the
// IZkClient contract — say, sequential suffixes reset, or watches fire
// on grandchildren — production code that DOES talk to real ZK passes
// its tests on the fake and breaks at runtime. This file is the
// trust anchor for "the fake matches the contract."
// Primary sources: packages/infra/src/zk/in-memory-client.ts

import { describe, expect, it } from "vitest";
import {
  asZkPath,
  ZkNodeExistsError,
  zkPaths,
} from "@co/contracts";
import { InMemoryZkClient } from "../src/zk/in-memory-client.js";

async function makeZk(): Promise<InMemoryZkClient> {
  const zk = new InMemoryZkClient({
    ensure_paths: zkPaths.allEnsurePaths(),
  });
  await zk.connect();
  return zk;
}

describe("InMemoryZkClient — node lifecycle", () => {
  it("mkdirp creates missing ancestors and is idempotent", async () => {
    const zk = await makeZk();
    await zk.mkdirp(asZkPath("/a/b/c"));

    expect(await zk.exists(asZkPath("/a"))).toBe(true);
    expect(await zk.exists(asZkPath("/a/b"))).toBe(true);
    expect(await zk.exists(asZkPath("/a/b/c"))).toBe(true);

    // Re-call is observable as a no-op: same exists() result, no throw.
    await zk.mkdirp(asZkPath("/a/b/c"));
    expect(await zk.exists(asZkPath("/a/b/c"))).toBe(true);
    expect(await zk.getChildren(asZkPath("/a/b"))).toEqual(["c"]);
  });

  it("createPersistent on an existing path throws ZkNodeExistsError", async () => {
    const zk = await makeZk();
    const path = asZkPath("/dup");
    await zk.createPersistent(path, Buffer.from("one"));
    await expect(
      zk.createPersistent(path, Buffer.from("two")),
    ).rejects.toBeInstanceOf(ZkNodeExistsError);

    // Data is unchanged after the failed create — fail-loud, not overwrite.
    const got = await zk.getData(path);
    expect(got?.data.toString("utf-8")).toBe("one");
  });

  it("delete on a parent cascades to all descendants", async () => {
    const zk = await makeZk();
    await zk.mkdirp(asZkPath("/tree"));
    await zk.createPersistent(asZkPath("/tree/a"), Buffer.from(""));
    await zk.createPersistent(asZkPath("/tree/a/leaf1"), Buffer.from(""));
    await zk.createPersistent(asZkPath("/tree/a/leaf2"), Buffer.from(""));

    await zk.delete(asZkPath("/tree/a"));

    expect(await zk.exists(asZkPath("/tree/a"))).toBe(false);
    expect(await zk.exists(asZkPath("/tree/a/leaf1"))).toBe(false);
    expect(await zk.exists(asZkPath("/tree/a/leaf2"))).toBe(false);
    expect(await zk.exists(asZkPath("/tree"))).toBe(true);
  });

  it("getChildren on a non-existent path returns []", async () => {
    const zk = await makeZk();
    expect(await zk.getChildren(asZkPath("/nope"))).toEqual([]);
  });
});

describe("InMemoryZkClient — sequential allocation", () => {
  it("createPersistentSequential allocates 10-digit monotonic suffixes per (parent, prefix)", async () => {
    const zk = await makeZk();
    const parent = asZkPath("/seq");
    await zk.mkdirp(parent);

    const first = await zk.createPersistentSequential(
      parent,
      "task-",
      Buffer.from("1"),
    );
    const second = await zk.createPersistentSequential(
      parent,
      "task-",
      Buffer.from("2"),
    );
    const third = await zk.createPersistentSequential(
      parent,
      "task-",
      Buffer.from("3"),
    );

    expect(first).toBe("/seq/task-0000000000");
    expect(second).toBe("/seq/task-0000000001");
    expect(third).toBe("/seq/task-0000000002");

    // Different prefix under the same parent has its own counter.
    const otherPrefix = await zk.createPersistentSequential(
      parent,
      "msg-",
      Buffer.from("x"),
    );
    expect(otherPrefix).toBe("/seq/msg-0000000000");
  });

  it("createEphemeralSequential shares the prefix counter with persistent", async () => {
    // The seq Map keys on prefix only, not on ephemeral-vs-persistent.
    // Lock that in: production code (TaskQueue) relies on uniqueness, not
    // separate counters per kind.
    const zk = await makeZk();
    const parent = asZkPath("/mixed");
    await zk.mkdirp(parent);

    const persistent = await zk.createPersistentSequential(
      parent,
      "n-",
      Buffer.from(""),
    );
    const ephemeral = await zk.createEphemeralSequential(
      parent,
      "n-",
      Buffer.from(""),
    );
    expect(persistent).toBe("/mixed/n-0000000000");
    expect(ephemeral).toBe("/mixed/n-0000000001");
  });
});

describe("InMemoryZkClient — versioning", () => {
  it("setData with a stale expectedVersion throws and leaves data unchanged", async () => {
    const zk = await makeZk();
    const path = asZkPath("/v");
    await zk.createPersistent(path, Buffer.from("v0"));
    const stat0 = await zk.getData(path);
    expect(stat0?.stat.version).toBe(0);

    await zk.setData(path, Buffer.from("v1"), 0);
    const stat1 = await zk.getData(path);
    expect(stat1?.stat.version).toBe(1);
    expect(stat1?.data.toString("utf-8")).toBe("v1");

    await expect(
      zk.setData(path, Buffer.from("v2"), 0 /* stale */),
    ).rejects.toThrow(/version mismatch/);

    const after = await zk.getData(path);
    expect(after?.data.toString("utf-8")).toBe("v1");
    expect(after?.stat.version).toBe(1);
  });
});

describe("InMemoryZkClient — ephemeral lifecycle", () => {
  it("close() evicts ephemerals and preserves persistents", async () => {
    const zk = await makeZk();
    await zk.mkdirp(asZkPath("/mix"));
    await zk.createPersistent(asZkPath("/mix/keep"), Buffer.from("p"));
    await zk.createEphemeral(asZkPath("/mix/ghost"), Buffer.from("e"));

    expect(await zk.exists(asZkPath("/mix/keep"))).toBe(true);
    expect(await zk.exists(asZkPath("/mix/ghost"))).toBe(true);

    await zk.close();

    expect(await zk.exists(asZkPath("/mix/keep"))).toBe(true);
    expect(await zk.exists(asZkPath("/mix/ghost"))).toBe(false);
    expect(zk.state).toBe("disconnected");
  });
});

describe("InMemoryZkClient — watches", () => {
  it("watchChildren fires on direct-child create AND delete, not grandchildren", async () => {
    const zk = await makeZk();
    const parent = asZkPath("/watched");
    await zk.mkdirp(parent);

    const observed: string[][] = [];
    await zk.watchChildren(parent, (kids) => {
      observed.push([...kids].sort());
    });

    await zk.createPersistent(asZkPath("/watched/a"), Buffer.from(""));
    await zk.createPersistent(asZkPath("/watched/b"), Buffer.from(""));

    // Grandchild: should NOT trigger /watched's child-watcher.
    await zk.createPersistent(asZkPath("/watched/a/leaf"), Buffer.from(""));

    await zk.delete(asZkPath("/watched/a"));

    // We expect three watch firings: create /a, create /b, delete /a.
    // Grandchild create fires the watcher for /watched/a (none here), not /watched.
    expect(observed).toEqual([
      ["a"],
      ["a", "b"],
      ["b"],
    ]);
  });
});
