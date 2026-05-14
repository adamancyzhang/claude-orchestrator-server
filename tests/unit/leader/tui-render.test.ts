import { describe, it, expect } from "vitest";
import {
  stripAnsi, padRight, truncate, wrapText, box,
  stripJsonChunk, workerStatusColor,
  renderTeamGrid, renderPendingTasks, renderClaimedTasks,
  renderWorkerMessages, renderStreamPanel,
  renderEventLog, renderInputLine, renderFooter,
  renderTerminalTooSmall, renderHelpOverlay,
  senderBadge,
  MIN_COLS, MIN_ROWS,
} from "../../../src/leader/tui-render.js";
import type { WorkerInfo } from "../../../src/leader/state.js";
import { makeTask } from "../../fixtures/factories.js";

function makeWorker(over: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id: "w1", name: "Alice", presetRole: "builder",
    currentRole: null, status: "idle", currentTaskId: null,
    worktreeName: "wt-alice", worktreePath: "/tmp/wt",
    worktreeBranch: "feature/x", pid: 1234,
    currentMessage: null, currentMessageLink: null, currentMessageTime: null,
    messageHistory: [], lastCompletedTask: null,
    streamBuffer: [], streamActive: false, streamLogPath: null,
    ...over,
  } as WorkerInfo;
}

describe("pure helpers", () => {
  it("stripAnsi removes color codes", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m")).toBe("hello");
  });

  it("padRight ignores ANSI when measuring visible width", () => {
    const s = "\x1b[31mhi\x1b[0m";
    const padded = padRight(s, 6);
    // visible len was 2 → padded with 4 spaces
    expect(padded.endsWith("    ")).toBe(true);
  });

  it("truncate appends ellipsis when oversize", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(truncate("hi", 5)).toBe("hi");
    expect(truncate("hi", 0)).toBe("");
  });

  it("wrapText wraps at maxWidth without breaking words mid-stream", () => {
    const out = wrapText("abcdefghij", 4);
    expect(out).toEqual(["abcd", "efgh", "ij"]);
  });

  it("box draws borders matching width", () => {
    const drawn = box(10, "x");
    const top = drawn.split("\n")[0];
    expect(stripAnsi(top)).toBe("┌────────┐");
  });

  it("workerStatusColor maps known statuses", () => {
    expect(workerStatusColor("idle")).toMatch(/\x1b/);
    expect(workerStatusColor("busy")).toMatch(/\x1b/);
    expect(workerStatusColor("unknown")).toMatch(/\x1b/);
  });
});

describe("stripJsonChunk", () => {
  it("extracts content_block_delta text", () => {
    const out = stripJsonChunk(JSON.stringify({ type: "content_block_delta", delta: { text: "hello" } }));
    expect(out).toBe("hello");
  });

  it("returns empty for known non-text types", () => {
    expect(stripJsonChunk(JSON.stringify({ type: "message_start" }))).toBe("");
    expect(stripJsonChunk(JSON.stringify({ type: "ping" }))).toBe("");
  });

  it("returns empty (no throw) for unknown event types — regression guard", () => {
    expect(() => stripJsonChunk(JSON.stringify({ type: "future_v99" }))).not.toThrow();
    expect(stripJsonChunk(JSON.stringify({ type: "future_v99" }))).toBe("");
  });

  it("returns empty (no throw) on malformed JSON", () => {
    expect(() => stripJsonChunk("not json at all {")).not.toThrow();
    expect(stripJsonChunk("not json at all {")).toBe("");
  });
});

describe("renderTeamGrid", () => {
  it("shows 'No workers online' when list empty", () => {
    const lines = renderTeamGrid([], 0, 80).join("\n");
    expect(lines).toContain("No workers online");
  });

  it("marks the selected worker with `>` prefix", () => {
    const a = makeWorker({ name: "Alpha" });
    const b = makeWorker({ id: "w2", name: "Zeta" });
    const lines = renderTeamGrid([a, b], 1, 100);
    // Find the worker row containing "Zeta"
    const zetaRow = lines.find((l) => l.includes("Zeta"));
    expect(zetaRow).toBeDefined();
    expect(stripAnsi(zetaRow!)).toContain(">");
    // The non-selected row should not contain ">"
    const alphaRow = lines.find((l) => l.includes("Alpha"));
    expect(alphaRow).toBeDefined();
    expect(stripAnsi(alphaRow!)).not.toContain(">");
  });

  it("caps display at 8 with 'and N more' marker", () => {
    const many = Array.from({ length: 12 }, (_, i) => makeWorker({ id: `w${i}`, name: `W${i}` }));
    const lines = renderTeamGrid(many, 0, 100).join("\n");
    expect(lines).toContain("and 4 more");
  });
});

describe("renderPendingTasks / renderClaimedTasks", () => {
  it("renderPendingTasks shows priority badges", () => {
    const tasks = [
      { ...makeTask({ title: "high task", priority: 0 }), id: "t-h" },
      { ...makeTask({ title: "low task", priority: 2 }), id: "t-l" },
    ];
    const lines = renderPendingTasks(tasks, 80).join("\n");
    expect(stripAnsi(lines)).toContain("HIGH");
    expect(stripAnsi(lines)).toContain("LOW");
  });

  it("renderClaimedTasks shows claimed_by short id and 'No tasks in progress' when empty", () => {
    expect(renderClaimedTasks([], 80).join("\n")).toContain("No tasks in progress");
    const t = { ...makeTask({ title: "running" }), id: "t1", claimed_by: "abcdef1234" };
    const lines = renderClaimedTasks([t], 80).join("\n");
    expect(stripAnsi(lines)).toContain("abcdef12");
  });
});

describe("renderWorkerMessages multiline overflow marker", () => {
  it("inserts overflow marker when output exceeds maxLines", () => {
    const longHistory = Array.from({ length: 30 }, (_, i) => ({
      timestamp: `t${i}`,
      content: `msg ${i}`,
      contentFull: `msg ${i}`,
      link: null,
      messageId: `m${i}`,
    }));
    const w = makeWorker({ messageHistory: longHistory });
    const lines = renderWorkerMessages(w, 80, 8);
    expect(lines).toHaveLength(8);
    expect(stripAnsi(lines[lines.length - 1])).toContain("more lines");
  });

  it("shows '(idle)' when no current message", () => {
    const w = makeWorker();
    const lines = renderWorkerMessages(w, 80, 10).join("\n");
    expect(stripAnsi(lines)).toContain("(idle)");
  });
});

describe("renderStreamPanel pause + scroll", () => {
  it("includes 'PAUSED' label when streamPaused", () => {
    const w = makeWorker({ streamActive: true, streamBuffer: ["{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}"] });
    const lines = renderStreamPanel(w, 80, 10, { streamPaused: true, streamScrollOffset: 0 }).join("\n");
    expect(stripAnsi(lines)).toContain("PAUSED");
  });

  it("respects streamScrollOffset and shows scroll indicator", () => {
    const buf: string[] = [];
    for (let i = 0; i < 30; i++) {
      buf.push(JSON.stringify({ type: "content_block_delta", delta: { text: `line${i}` } }));
    }
    const w = makeWorker({ streamActive: true, streamBuffer: buf });
    const lines = renderStreamPanel(w, 80, 10, { streamPaused: false, streamScrollOffset: 10 }).join("\n");
    expect(stripAnsi(lines)).toContain("scrolled 10");
    // We scrolled back 10 → should NOT show line29
    expect(stripAnsi(lines)).not.toContain("line29");
  });
});

describe("renderEventLog filter", () => {
  const events = [
    { timestamp: "t1", message: "Task task-1 claimed" },
    { timestamp: "t2", message: "Worker Alice joined (builder)" },
    { timestamp: "t3", message: "Chain c-1 activated" },
    { timestamp: "t4", message: "Debug random" },
  ];

  it("all filter shows everything", () => {
    const lines = renderEventLog(events, 10, 80, "all").join("\n");
    expect(stripAnsi(lines)).toContain("Task task-1 claimed");
    expect(stripAnsi(lines)).toContain("Debug random");
  });

  it("task filter shows only task events", () => {
    const lines = renderEventLog(events, 10, 80, "task").join("\n");
    expect(stripAnsi(lines)).toContain("Task task-1 claimed");
    expect(stripAnsi(lines)).not.toContain("Worker Alice joined");
  });

  it("worker filter shows joined/left/received events", () => {
    const lines = renderEventLog(events, 10, 80, "worker").join("\n");
    expect(stripAnsi(lines)).toContain("Worker Alice joined");
    expect(stripAnsi(lines)).not.toContain("Chain c-1");
  });

  it("chain filter shows only chain events", () => {
    const lines = renderEventLog(events, 10, 80, "chain").join("\n");
    expect(stripAnsi(lines)).toContain("Chain c-1");
  });
});

describe("renderInputLine sent indicator", () => {
  it("shows '… sending' immediately after submit", () => {
    const { hint } = renderInputLine("", { pendingInput: "build it", sentAt: 1000, nowMs: 1100 });
    expect(stripAnsi(hint)).toContain("sending");
  });

  it("shows '✓ sent' after the spinner phase", () => {
    const { hint } = renderInputLine("", { pendingInput: "build it", sentAt: 1000, nowMs: 1500 });
    expect(stripAnsi(hint)).toContain("✓ sent");
  });

  it("reverts to 'Type a message' after indicator expires", () => {
    const { hint } = renderInputLine("", { pendingInput: "build it", sentAt: 1000, nowMs: 5000 });
    expect(stripAnsi(hint)).toContain("Type a message");
  });

  it("shows blank hint while user is typing", () => {
    const { hint } = renderInputLine("partial", { pendingInput: null, sentAt: null, nowMs: 0 });
    expect(stripAnsi(hint)).toBe(" ");
  });
});

describe("renderFooter", () => {
  it("includes leader name and instance id", () => {
    const out = renderFooter(120, "Atlas", "abcdef0123456789", "/tmp/cache", 0);
    expect(stripAnsi(out)).toContain("Atlas");
    expect(stripAnsi(out)).toContain("abcdef01");
  });

  it("rotates keybinding hint based on nowMs", () => {
    const a = stripAnsi(renderFooter(120, "X", "i", "c", 0));
    const b = stripAnsi(renderFooter(120, "X", "i", "c", 4000));
    expect(a).not.toBe(b);
  });

  it("at narrow widths, drops cache/leader and shows only tip", () => {
    const out = stripAnsi(renderFooter(80, "Atlas", "i", "c", 0));
    expect(out).not.toContain("Leader: Atlas");
  });
});

describe("renderTerminalTooSmall", () => {
  it("reports current and required dimensions", () => {
    const lines = renderTerminalTooSmall(60, 10).join("\n");
    const plain = stripAnsi(lines);
    expect(plain).toContain("Terminal too small");
    expect(plain).toContain("60 × 10");
    expect(plain).toContain(`${MIN_COLS} × ${MIN_ROWS}`);
  });
});

describe("renderHelpOverlay", () => {
  it("lists key bindings", () => {
    const out = renderHelpOverlay(100).join("\n");
    const plain = stripAnsi(out);
    expect(plain).toContain("Tab");
    expect(plain).toContain("Ctrl+P");
    expect(plain).toContain("Ctrl+C");
  });
});

describe("senderBadge", () => {
  it("shows blue [L] for leader", () => {
    expect(stripAnsi(senderBadge("leader"))).toBe("[L]");
  });

  it("shows [W:role] for worker roles", () => {
    expect(stripAnsi(senderBadge("builder"))).toBe("[W:builder]");
  });

  it("shows [?] for missing role", () => {
    expect(stripAnsi(senderBadge(null))).toBe("[?]");
  });
});
