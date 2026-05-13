import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleKey } from "../../../src/leader/tui.js";
import { defaultUiState } from "../../../src/leader/tui-render.js";
import { LeaderState } from "../../../src/leader/state.js";
import { makeInstance } from "../../fixtures/factories.js";

function freshSetup() {
  const state = new LeaderState();
  const a = makeInstance({ name: "A" });
  const b = makeInstance({ name: "B" });
  const c = makeInstance({ name: "C" });
  for (const i of [a, b, c]) {
    state.apply({ type: "worker_joined", instance: i, instanceId: i.id, name: i.name });
  }
  const ui = defaultUiState();
  const onSubmit = vi.fn();
  return { state, ui, onSubmit };
}

describe("handleKey", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
  });

  it("Ctrl+C calls process.kill with SIGINT", () => {
    const s = freshSetup();
    handleKey("\x03", s.state, s.ui, s.onSubmit);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
  });

  it("Tab cycles selectedWorkerIndex forward", () => {
    const s = freshSetup();
    s.state.selectedWorkerIndex = 0;
    handleKey("\t", s.state, s.ui, s.onSubmit);
    expect(s.state.selectedWorkerIndex).toBe(1);
    handleKey("\t", s.state, s.ui, s.onSubmit);
    expect(s.state.selectedWorkerIndex).toBe(2);
    handleKey("\t", s.state, s.ui, s.onSubmit);
    expect(s.state.selectedWorkerIndex).toBe(0);
  });

  it("Shift+Tab cycles backward, wrapping", () => {
    const s = freshSetup();
    s.state.selectedWorkerIndex = 0;
    handleKey("\x1b[Z", s.state, s.ui, s.onSubmit);
    expect(s.state.selectedWorkerIndex).toBe(2);
  });

  it("Digit 1-9 jumps when index is in range", () => {
    const s = freshSetup();
    handleKey("3", s.state, s.ui, s.onSubmit);
    expect(s.state.selectedWorkerIndex).toBe(2);
    // Out-of-range — no change
    handleKey("9", s.state, s.ui, s.onSubmit);
    expect(s.state.selectedWorkerIndex).toBe(2);
  });

  it("Printable chars append to inputBuffer; backspace deletes", () => {
    const s = freshSetup();
    handleKey("h", s.state, s.ui, s.onSubmit);
    handleKey("i", s.state, s.ui, s.onSubmit);
    expect(s.ui.inputBuffer).toBe("hi");
    handleKey("\x7f", s.state, s.ui, s.onSubmit);
    expect(s.ui.inputBuffer).toBe("h");
  });

  it("Enter triggers onSubmit, clears buffer, and sets sentAt", () => {
    const s = freshSetup();
    s.ui.inputBuffer = "build it";
    handleKey("\r", s.state, s.ui, s.onSubmit, 5000);
    expect(s.onSubmit).toHaveBeenCalledWith("build it");
    expect(s.ui.inputBuffer).toBe("");
    expect(s.ui.pendingInput).toBe("build it");
    expect(s.ui.sentAt).toBe(5000);
  });

  it("Enter on empty buffer does NOT invoke onSubmit", () => {
    const s = freshSetup();
    handleKey("\r", s.state, s.ui, s.onSubmit);
    expect(s.onSubmit).not.toHaveBeenCalled();
  });

  it("Esc clears inputBuffer when non-empty", () => {
    const s = freshSetup();
    s.ui.inputBuffer = "draft";
    handleKey("\x1b", s.state, s.ui, s.onSubmit);
    expect(s.ui.inputBuffer).toBe("");
  });

  it("Ctrl+P toggles streamPaused", () => {
    const s = freshSetup();
    expect(s.ui.streamPaused).toBe(false);
    handleKey("\x10", s.state, s.ui, s.onSubmit);
    expect(s.ui.streamPaused).toBe(true);
    handleKey("\x10", s.state, s.ui, s.onSubmit);
    expect(s.ui.streamPaused).toBe(false);
  });

  it("Arrow up/down adjusts streamScrollOffset; End resets it", () => {
    const s = freshSetup();
    handleKey("\x1b[A", s.state, s.ui, s.onSubmit);
    expect(s.ui.streamScrollOffset).toBe(5);
    handleKey("\x1b[A", s.state, s.ui, s.onSubmit);
    expect(s.ui.streamScrollOffset).toBe(10);
    handleKey("\x1b[B", s.state, s.ui, s.onSubmit);
    expect(s.ui.streamScrollOffset).toBe(5);
    handleKey("\x1b[F", s.state, s.ui, s.onSubmit);
    expect(s.ui.streamScrollOffset).toBe(0);
  });

  it("f cycles eventFilter through all four states (only when input empty)", () => {
    const s = freshSetup();
    expect(s.ui.eventFilter).toBe("all");
    handleKey("f", s.state, s.ui, s.onSubmit);
    expect(s.ui.eventFilter).toBe("task");
    handleKey("f", s.state, s.ui, s.onSubmit);
    expect(s.ui.eventFilter).toBe("worker");
    handleKey("f", s.state, s.ui, s.onSubmit);
    expect(s.ui.eventFilter).toBe("chain");
    handleKey("f", s.state, s.ui, s.onSubmit);
    expect(s.ui.eventFilter).toBe("all");
  });

  it("f is treated as a printable char while composing a message", () => {
    const s = freshSetup();
    s.ui.inputBuffer = "hi";
    handleKey("f", s.state, s.ui, s.onSubmit);
    expect(s.ui.inputBuffer).toBe("hif");
    expect(s.ui.eventFilter).toBe("all");
  });

  it("? toggles showHelp", () => {
    const s = freshSetup();
    handleKey("?", s.state, s.ui, s.onSubmit);
    expect(s.ui.showHelp).toBe(true);
    handleKey("?", s.state, s.ui, s.onSubmit);
    expect(s.ui.showHelp).toBe(false);
  });

  it("Esc closes help overlay even with empty buffer", () => {
    const s = freshSetup();
    s.ui.showHelp = true;
    handleKey("\x1b", s.state, s.ui, s.onSubmit);
    expect(s.ui.showHelp).toBe(false);
  });

  it("Changing worker via Tab resets streamScrollOffset", () => {
    const s = freshSetup();
    s.ui.streamScrollOffset = 25;
    handleKey("\t", s.state, s.ui, s.onSubmit);
    expect(s.ui.streamScrollOffset).toBe(0);
  });
});
