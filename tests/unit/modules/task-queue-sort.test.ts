import { describe, it, expect } from "vitest";
import { TaskQueue } from "../../../src/modules/task-queue.js";
import { MockZkClient } from "../../fixtures/mock-zk.js";
import { makeTask, makeInstance } from "../../fixtures/factories.js";
import type { ZkClient } from "../../../src/zk/client.js";

describe("TaskQueue.claim role-link priority sorting", () => {
  it("prefers tasks explicitly assigned to me", async () => {
    const zk = new MockZkClient();
    const me = makeInstance({ name: "Me", role: "builder" });
    zk.instances.set(me.id, me);

    const tForOther = makeTask({ title: "for-other", assigned_to: "someone-else" });
    const tForMe = makeTask({ title: "for-me", assigned_to: me.id });
    // Use a different priority to ensure assigned-to-me wins over priority
    tForOther.priority = 0; // HIGH
    tForMe.priority = 2;    // LOW
    zk.pendingTasks.set("task-other", tForOther);
    zk.pendingTasks.set("task-mine", tForMe);

    const q = new TaskQueue(zk as unknown as ZkClient);
    const claimed = await q.claim(me.id);

    expect(claimed?.title).toBe("for-me");
  });

  it("prefers tasks whose link matches the instance role", async () => {
    const zk = new MockZkClient();
    const me = makeInstance({ name: "Builder", role: "builder" });
    zk.instances.set(me.id, me);

    const tPlan = makeTask({ title: "plan-task", link: "plan", priority: 0 });
    const tBuild = makeTask({ title: "build-task", link: "build", priority: 1 });
    zk.pendingTasks.set("task-plan", tPlan);
    zk.pendingTasks.set("task-build", tBuild);

    const q = new TaskQueue(zk as unknown as ZkClient);
    const claimed = await q.claim(me.id);

    expect(claimed?.title).toBe("build-task");
  });

  it("falls back to priority when assignment + role tie", async () => {
    const zk = new MockZkClient();
    const me = makeInstance({ name: "Builder", role: "builder" });
    zk.instances.set(me.id, me);

    const tHigh = makeTask({ title: "hi", priority: 0 });
    const tLow = makeTask({ title: "lo", priority: 2 });
    zk.pendingTasks.set("task-hi", tHigh);
    zk.pendingTasks.set("task-lo", tLow);

    const q = new TaskQueue(zk as unknown as ZkClient);
    const claimed = await q.claim(me.id);

    expect(claimed?.title).toBe("hi");
  });

  it("falls back to task id (FIFO) on full tie", async () => {
    const zk = new MockZkClient();
    const me = makeInstance({ name: "B", role: "builder" });
    zk.instances.set(me.id, me);

    zk.pendingTasks.set("task-aaa", makeTask({ title: "A" }));
    zk.pendingTasks.set("task-zzz", makeTask({ title: "Z" }));

    const q = new TaskQueue(zk as unknown as ZkClient);
    const claimed = await q.claim(me.id);
    expect(claimed?.title).toBe("A");
  });

  it("skips leader_only tasks for non-leader instances", async () => {
    const zk = new MockZkClient();
    const me = makeInstance({ name: "B", role: "builder" });
    zk.instances.set(me.id, me);

    const ldrTask = makeTask({ title: "leader-only" });
    ldrTask.leader_only = true;
    zk.pendingTasks.set("task-ldr", ldrTask);
    zk.pendingTasks.set("task-norm", makeTask({ title: "normal" }));

    const q = new TaskQueue(zk as unknown as ZkClient);
    const claimed = await q.claim(me.id);
    expect(claimed?.title).toBe("normal");
  });
});
