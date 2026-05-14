import { describe, it, expect } from "vitest";
import { LeaderState } from "../../../src/leader/state.js";
import { makeInstance, makeTask } from "../../fixtures/factories.js";

function freshState(): LeaderState {
  return new LeaderState();
}

describe("LeaderState.apply", () => {
  describe("worker_joined", () => {
    it("adds a worker and logs an event", () => {
      const s = freshState();
      const inst = makeInstance({ name: "Alice", role: "builder" });
      s.apply({ type: "worker_joined", instance: inst, instanceId: inst.id, name: "Alice" });
      expect(s.workers).toHaveLength(1);
      expect(s.workers[0].name).toBe("Alice");
      expect(s.workers[0].presetRole).toBe("builder");
      expect(s.workers[0].status).toBe("idle");
      expect(s.events.at(-1)?.message).toContain("Alice joined");
    });
  });

  describe("worker_left selectedWorkerIndex adjustment", () => {
    it("decrements when an earlier-index worker leaves", () => {
      const s = freshState();
      const a = makeInstance({ name: "A" });
      const b = makeInstance({ name: "B" });
      const c = makeInstance({ name: "C" });
      for (const i of [a, b, c]) s.apply({ type: "worker_joined", instance: i, instanceId: i.id, name: i.name });
      s.selectedWorkerIndex = 2;

      s.apply({ type: "worker_left", instanceId: a.id, name: "A" });

      expect(s.workers).toHaveLength(2);
      expect(s.selectedWorkerIndex).toBe(1);
    });

    it("clamps when the selected worker itself leaves", () => {
      const s = freshState();
      const a = makeInstance({ name: "A" });
      const b = makeInstance({ name: "B" });
      for (const i of [a, b]) s.apply({ type: "worker_joined", instance: i, instanceId: i.id, name: i.name });
      s.selectedWorkerIndex = 1;

      s.apply({ type: "worker_left", instanceId: b.id, name: "B" });

      expect(s.workers).toHaveLength(1);
      expect(s.selectedWorkerIndex).toBe(0);
    });

    it("never goes negative when the last worker leaves", () => {
      const s = freshState();
      const a = makeInstance({ name: "A" });
      s.apply({ type: "worker_joined", instance: a, instanceId: a.id, name: "A" });

      s.apply({ type: "worker_left", instanceId: a.id, name: "A" });

      expect(s.workers).toHaveLength(0);
      expect(s.selectedWorkerIndex).toBe(0);
    });

    it("leaves index alone when a later-index worker leaves", () => {
      const s = freshState();
      const a = makeInstance({ name: "A" });
      const b = makeInstance({ name: "B" });
      const c = makeInstance({ name: "C" });
      for (const i of [a, b, c]) s.apply({ type: "worker_joined", instance: i, instanceId: i.id, name: i.name });
      s.selectedWorkerIndex = 0;

      s.apply({ type: "worker_left", instanceId: c.id, name: "C" });

      expect(s.selectedWorkerIndex).toBe(0);
    });
  });

  describe("worker_message_received", () => {
    it("appends to history and marks busy", () => {
      const s = freshState();
      const inst = makeInstance({ name: "Bob" });
      s.apply({ type: "worker_joined", instance: inst, instanceId: inst.id, name: "Bob" });
      s.apply({
        type: "worker_message_received",
        instanceId: inst.id,
        name: "Bob",
        content: "hi there",
        link: "build",
        timestamp: "12:00:00",
        messageId: "m1",
      });
      const w = s.workers[0];
      expect(w.currentMessage).toBe("hi there");
      expect(w.currentMessageLink).toBe("build");
      expect(w.status).toBe("busy");
      expect(w.messageHistory).toHaveLength(1);
    });

    it("caps message history at 20 entries", () => {
      const s = freshState();
      const inst = makeInstance({ name: "Bob" });
      s.apply({ type: "worker_joined", instance: inst, instanceId: inst.id, name: "Bob" });
      for (let i = 0; i < 25; i++) {
        s.apply({
          type: "worker_message_received",
          instanceId: inst.id, name: "Bob",
          content: `msg ${i}`, link: null,
          timestamp: "t", messageId: `m${i}`,
        });
      }
      expect(s.workers[0].messageHistory).toHaveLength(20);
      expect(s.workers[0].messageHistory[0].content).toBe("msg 5");
    });
  });

  describe("task lifecycle", () => {
    it("task_created → pending; task_claimed moves to claimed; task_completed moves to completed", () => {
      const s = freshState();
      const inst = makeInstance({ name: "Bob", role: "builder" });
      s.apply({ type: "worker_joined", instance: inst, instanceId: inst.id, name: "Bob" });

      const task = makeTask({ title: "Do build", link: "build" });
      task.id = "task-1";
      s.apply({ type: "task_created", task, taskId: "task-1" });
      expect(s.pendingTasks).toHaveLength(1);

      s.apply({ type: "task_claimed", instanceId: inst.id, taskId: "task-1", link: "build" });
      expect(s.pendingTasks).toHaveLength(0);
      expect(s.claimedTasks).toHaveLength(1);
      // currentRole derived from link "build" → "builder"
      expect(s.workers[0].currentRole).toBe("builder");
      expect(s.workers[0].status).toBe("busy");

      const completed = { ...task, status: "completed" };
      s.apply({ type: "task_completed", instanceId: inst.id, taskId: "task-1", task: completed });
      expect(s.claimedTasks).toHaveLength(0);
      expect(s.completedTasks).toHaveLength(1);
      expect(s.workers[0].status).toBe("idle");
      expect(s.workers[0].currentRole).toBeNull();
    });
  });

  describe("stream events", () => {
    it("stream_chunk buffer is capped at 200", () => {
      const s = freshState();
      const inst = makeInstance({ name: "Bob" });
      s.apply({ type: "worker_joined", instance: inst, instanceId: inst.id, name: "Bob" });
      s.apply({ type: "stream_start", instanceId: inst.id, logPath: "/tmp/x.log" });
      for (let i = 0; i < 250; i++) {
        s.apply({ type: "stream_chunk", instanceId: inst.id, line: `line ${i}` });
      }
      expect(s.workers[0].streamBuffer).toHaveLength(200);
      expect(s.workers[0].streamBuffer[0]).toBe("line 50");
    });

    it("stream_start resets buffer; stream_end flips streamActive false", () => {
      const s = freshState();
      const inst = makeInstance({ name: "Bob" });
      s.apply({ type: "worker_joined", instance: inst, instanceId: inst.id, name: "Bob" });
      s.workers[0].streamBuffer = ["old"];
      s.apply({ type: "stream_start", instanceId: inst.id, logPath: "/tmp/y.log" });
      expect(s.workers[0].streamBuffer).toEqual([]);
      expect(s.workers[0].streamActive).toBe(true);
      s.apply({ type: "stream_end", instanceId: inst.id });
      expect(s.workers[0].streamActive).toBe(false);
    });
  });

  it("event log is capped at 100 entries", () => {
    const s = freshState();
    for (let i = 0; i < 150; i++) {
      s.apply({ type: "debug_info", message: `event-${i}` });
    }
    expect(s.events.length).toBe(100);
    // First retained should be event-50
    expect(s.events[0].message).toContain("event-50");
  });
});
