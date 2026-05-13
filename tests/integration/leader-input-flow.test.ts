import { describe, it, expect, vi } from "vitest";
import { handleKey, composeFrame } from "../../src/leader/tui.js";
import { defaultUiState, stripAnsi } from "../../src/leader/tui-render.js";
import { LeaderState } from "../../src/leader/state.js";
import { makeInstance } from "../fixtures/factories.js";

/**
 * Simulates: user types "build feature X" + Enter → on submit, an external
 * dispatch handler is invoked. The TUI must then render the "✓ sent"
 * indicator immediately afterwards.
 */
describe("integration: leader typing → submit → TUI feedback", () => {
  it("typed text routed to onSubmit, '✓ sent' indicator appears in next frame", () => {
    const state = new LeaderState();
    state.leaderName = "Atlas";
    state.leaderInstanceId = "leader-1";
    state.cacheDir = "/tmp/c";
    const alice = makeInstance({ name: "Alice" });
    state.apply({ type: "worker_joined", instance: alice, instanceId: alice.id, name: "Alice" });
    const ui = defaultUiState();

    // Simulate the leader's onInput callback wiring (which would normally call
    // zk.createMessage to send the message to itself for routing).
    const submitted: string[] = [];
    const onSubmit = vi.fn((text: string) => submitted.push(text));

    // Type "build feature X"
    for (const ch of "build feature X") {
      handleKey(ch, state, ui, onSubmit, 0);
    }
    expect(ui.inputBuffer).toBe("build feature X");

    // Press Enter at t=1000
    handleKey("\r", state, ui, onSubmit, 1000);

    expect(submitted).toEqual(["build feature X"]);
    expect(ui.inputBuffer).toBe("");
    expect(ui.pendingInput).toBe("build feature X");

    // Render at t=1500: '✓ sent' should appear
    const frame = composeFrame(state, ui, 120, 30, 1500);
    expect(stripAnsi(frame)).toContain("✓ sent");
  });

  it("worker_message_received surfaces in the TUI for the selected worker", () => {
    const state = new LeaderState();
    state.leaderName = "L";
    state.leaderInstanceId = "leader-1";
    state.cacheDir = "/tmp/c";
    const w = makeInstance({ name: "Builder", role: "builder" });
    state.apply({ type: "worker_joined", instance: w, instanceId: w.id, name: "Builder" });

    state.apply({
      type: "worker_message_received",
      instanceId: w.id, name: "Builder",
      content: "Step 1: scaffolding files",
      link: "build", timestamp: "12:34:56", messageId: "m1",
    });

    const ui = defaultUiState();
    const frame = composeFrame(state, ui, 120, 30, 0);
    const plain = stripAnsi(frame);
    expect(plain).toContain("WORKER MESSAGES");
    expect(plain).toContain("Step 1: scaffolding files");
  });
});
