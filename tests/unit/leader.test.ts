import { describe, it, expect } from "vitest";
import { LeaderEventBus } from "../../src/leader/event-bus.js";
import { LeaderState } from "../../src/leader/state.js";
import { LeaderTui } from "../../src/leader/tui.js";

describe("LeaderEventBus", () => {
  it("calls onAll for every event type", () => {
    const bus = new LeaderEventBus();
    const received: string[] = [];
    bus.onAll((e) => received.push(e.type));

    bus.emit({ type: "worker_joined", instanceId: "w1" });
    bus.emit({ type: "task_created", taskId: "t1" });
    bus.emit({ type: "message_received", msgId: "m1" });

    expect(received).toEqual(["worker_joined", "task_created", "message_received"]);
  });

  it("on() only fires for matching type", () => {
    const bus = new LeaderEventBus();
    let workerJoined = 0;
    let workerLeft = 0;

    bus.on("worker_joined", () => workerJoined++);
    bus.on("worker_left", () => workerLeft++);

    bus.emit({ type: "worker_joined", instanceId: "w1" });
    bus.emit({ type: "worker_joined", instanceId: "w2" });
    bus.emit({ type: "worker_left", instanceId: "w1" });

    expect(workerJoined).toBe(2);
    expect(workerLeft).toBe(1);
  });
});

describe("LeaderState", () => {
  it("initializes with empty state", () => {
    const state = new LeaderState();
    expect(state.workers).toEqual([]);
    expect(state.pendingTasks).toEqual([]);
    expect(state.claimedTasks).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("worker_joined adds worker and logs event", () => {
    const state = new LeaderState();
    state.apply({
      type: "worker_joined",
      instanceId: "abc12345",
      name: "Jerry",
      instance: { id: "abc12345", name: "Jerry", role: "builder", status: "idle", current_task_id: null },
    });
    expect(state.workers).toHaveLength(1);
    expect(state.workers[0].name).toBe("Jerry");
    expect(state.workers[0].presetRole).toBe("builder");
    expect(state.workers[0].status).toBe("idle");
    expect(state.events).toHaveLength(1);
    expect(state.events[0].message).toContain("Jerry");
  });

  it("worker_left removes worker and logs event", () => {
    const state = new LeaderState();
    state.apply({ type: "worker_joined", instanceId: "w1", instance: { id: "w1", name: "Alice", role: "verifier", status: "idle" } });
    state.apply({ type: "worker_left", instanceId: "w1", name: "Alice" });
    expect(state.workers).toHaveLength(0);
    expect(state.events[1].message).toContain("Alice left");
  });

  it("task_created adds to pendingTasks", () => {
    const state = new LeaderState();
    state.apply({ type: "task_created", taskId: "task-01", task: { id: "task-01", title: "Fix bug", priority: 0 } });
    expect(state.pendingTasks).toHaveLength(1);
    expect(state.pendingTasks[0].title).toBe("Fix bug");
  });

  it("task_claimed moves from pending to claimed", () => {
    const state = new LeaderState();
    state.apply({ type: "task_created", taskId: "task-01", task: { id: "task-01", title: "Fix bug", priority: 0 } });
    state.apply({ type: "task_claimed", taskId: "task-01", instanceId: "w1" });
    expect(state.pendingTasks).toHaveLength(0);
    expect(state.claimedTasks).toHaveLength(1);
    expect(state.claimedTasks[0].status).toBe("claimed");
  });

  it("task_claimed with accept link sets currentRole to accepter", () => {
    const state = new LeaderState();
    state.apply({ type: "worker_joined", instanceId: "w1", instance: { id: "w1", name: "Eve", role: "accepter", status: "idle" } });
    state.apply({ type: "task_created", taskId: "task-005", task: { id: "task-005", title: "Accept task", link: "accept", priority: 1 } });
    state.apply({ type: "task_claimed", taskId: "task-005", instanceId: "w1", link: "accept" });
    expect(state.workers[0].currentRole).toBe("accepter");
  });

  it("task_completed removes from claimedTasks", () => {
    const state = new LeaderState();
    state.apply({ type: "task_created", taskId: "task-01", task: { id: "task-01", title: "Fix bug" } });
    state.apply({ type: "task_claimed", taskId: "task-01", instanceId: "w1" });
    state.apply({ type: "task_completed", taskId: "task-01" });
    expect(state.claimedTasks).toHaveLength(0);
  });

  it("event log caps at 100 entries", () => {
    const state = new LeaderState();
    for (let i = 0; i < 150; i++) {
      state.apply({ type: "task_created", taskId: `t${i}`, task: { id: `t${i}`, title: `Task ${i}` } });
    }
    expect(state.events.length).toBe(100);
    expect(state.events[0].message).toContain("Task 50");
  });
});

describe("LeaderTui", () => {
  it("render does not throw with empty state", () => {
    const tui = new LeaderTui();
    const state = new LeaderState();
    state.leaderName = "TestLeader";
    state.leaderInstanceId = "test1234";
    state.cacheDir = "/tmp/cache";

    // Mock stdout.columns and rows
    const origColumns = process.stdout.columns;
    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });

    expect(() => tui.render(state)).not.toThrow();

    Object.defineProperty(process.stdout, "columns", { value: origColumns, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: origRows, configurable: true });
  });

  it("destroy restores cursor", () => {
    const tui = new LeaderTui();
    expect(() => tui.destroy()).not.toThrow();
  });
});
