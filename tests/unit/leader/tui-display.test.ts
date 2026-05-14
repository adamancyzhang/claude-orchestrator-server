import { describe, it, expect } from "vitest";
import { composeFrame } from "../../../src/leader/tui.js";
import { defaultUiState, stripAnsi } from "../../../src/leader/tui-render.js";
import { LeaderState } from "../../../src/leader/state.js";
import { makeInstance, makeTask } from "../../fixtures/factories.js";

function seedState(): LeaderState {
  const s = new LeaderState();
  s.leaderName = "Atlas";
  s.leaderInstanceId = "leader-abc12345";
  s.cacheDir = "/tmp/cache";
  const a = makeInstance({ name: "Alice", role: "builder" });
  const b = makeInstance({ name: "Bob", role: "planner" });
  s.apply({ type: "worker_joined", instance: a, instanceId: a.id, name: "Alice" });
  s.apply({ type: "worker_joined", instance: b, instanceId: b.id, name: "Bob" });
  const task = { ...makeTask({ title: "build feature X", priority: 0, link: "build" }), id: "task-1" };
  s.apply({ type: "task_created", task, taskId: "task-1" });
  return s;
}

describe("composeFrame", () => {
  it("renders team grid + pending tasks + footer in a normal-sized terminal", () => {
    const s = seedState();
    const ui = defaultUiState();
    const out = composeFrame(s, ui, 120, 30, 0);
    const plain = stripAnsi(out);
    expect(plain).toContain("TEAM");
    expect(plain).toContain("Alice");
    expect(plain).toContain("Bob");
    expect(plain).toContain("PENDING");
    expect(plain).toContain("build feature X");
    expect(plain).toContain("HIGH");
    expect(plain).toContain("Atlas");
  });

  it("renders 'Terminal too small' warning below minimum dimensions", () => {
    const s = seedState();
    const ui = defaultUiState();
    const out = composeFrame(s, ui, 60, 10, 0);
    const plain = stripAnsi(out);
    expect(plain).toContain("Terminal too small");
    expect(plain).not.toContain("TEAM");
  });

  it("renders help overlay when ui.showHelp is set", () => {
    const s = seedState();
    const ui = defaultUiState();
    ui.showHelp = true;
    const out = composeFrame(s, ui, 120, 30, 0);
    const plain = stripAnsi(out);
    expect(plain).toContain("KEYBINDINGS");
    expect(plain).toContain("Ctrl+P");
    expect(plain).not.toContain("TEAM");
  });

  it("renders '✓ sent' shortly after a submission", () => {
    const s = seedState();
    const ui = defaultUiState();
    ui.pendingInput = "build it";
    ui.sentAt = 1000;
    const out = composeFrame(s, ui, 120, 30, 1500);
    const plain = stripAnsi(out);
    expect(plain).toContain("✓ sent");
  });

  it("renders worker message in WORKER MESSAGES panel for the selected worker", () => {
    const s = seedState();
    const wId = s.workers[0].id;
    s.apply({
      type: "worker_message_received",
      instanceId: wId,
      name: "Alice",
      content: "I am building",
      link: "build",
      timestamp: "12:00:00",
      messageId: "m1",
    });
    s.selectedWorkerIndex = 0;
    const ui = defaultUiState();
    const out = composeFrame(s, ui, 120, 30, 0);
    const plain = stripAnsi(out);
    expect(plain).toContain("WORKER MESSAGES");
    expect(plain).toContain("I am building");
  });

  it("event log filter is respected", () => {
    const s = seedState();
    s.apply({ type: "chain_activated", chainId: "c-1" });
    const ui = defaultUiState();
    ui.eventFilter = "chain";
    const out = composeFrame(s, ui, 120, 30, 0);
    const plain = stripAnsi(out);
    expect(plain).toContain("Chain c-1 activated");
    expect(plain).toContain("filter: chain");
  });
});
