// CORE-RETENTION
// Locks in: parseStreamLine — the runtime's authoritative parser for
// claude CLI `--output-format stream-json --verbose` lines. Specifically:
// (a) assistant lines with `text` blocks → { kind: "text", text } with
//     all text blocks joined; thinking and tool_use suppressed when
//     text is present (worker activity is a low-rate summary).
// (b) tool_use blocks → { kind: "tool_use", tool, summary } where
//     summary is derived from tool input: Bash→command, Read/Write/
//     Edit→basename(file_path), Grep/Glob→pattern, fallback→tool name.
// (c) thinking-only assistant lines → { kind: "thinking" } with no
//     payload — the worker exposes a placeholder, not the reasoning.
// (d) result lines → { kind: "result", text, is_error } so the worker
//     can detect early-error terminations.
// (e) unparseable / empty / unknown-type lines never throw.
// Critical because: workers forward parsed events to the Leader for
// live TUI display. A regression that mis-tags a tool_use as text, or
// emits thinking text verbatim, leaks internal reasoning to the user.
// Primary sources: packages/runtime/src/stream-json.ts

import { describe, expect, it } from "vitest";
import {
  extractAssistantText,
  extractResultText,
  parseStreamLine,
} from "../src/stream-json.js";

describe("parseStreamLine — input shape robustness", () => {
  it("returns null for empty and whitespace-only lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   \n")).toBeNull();
  });

  it("returns null for unparseable JSON", () => {
    expect(parseStreamLine("{not json")).toBeNull();
  });

  it("returns { kind: 'other' } for unknown top-level types", () => {
    const e = parseStreamLine(JSON.stringify({ type: "unknown_type" }));
    expect(e).toEqual({ kind: "other" });
  });
});

describe("parseStreamLine — assistant text", () => {
  it("extracts and joins consecutive text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(parseStreamLine(line)).toEqual({
      kind: "text",
      text: "Hello world",
    });
  });

  it("text wins over thinking and tool_use when present in the same line", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "visible" },
        ],
      },
    });
    expect(parseStreamLine(line)).toEqual({ kind: "text", text: "visible" });
  });

  it("skips empty text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    });
    // Falls through to "other" since no usable block remained.
    expect(parseStreamLine(line)).toEqual({ kind: "other" });
  });
});

describe("parseStreamLine — tool_use summaries", () => {
  function toolLine(name: string, input: Record<string, unknown>): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name, input }],
      },
    });
  }

  it("Bash → command", () => {
    expect(parseStreamLine(toolLine("Bash", { command: "pnpm test" }))).toEqual({
      kind: "tool_use",
      tool: "Bash",
      summary: "pnpm test",
    });
  });

  it("Bash → truncates long commands with ellipsis", () => {
    const long = "a".repeat(100);
    const e = parseStreamLine(toolLine("Bash", { command: long }));
    if (e?.kind !== "tool_use") throw new Error("expected tool_use");
    expect(e.summary.length).toBeLessThanOrEqual(80);
    expect(e.summary.endsWith("…")).toBe(true);
  });

  it("Read → basename(file_path)", () => {
    expect(
      parseStreamLine(toolLine("Read", { file_path: "/abs/long/path/foo.ts" })),
    ).toEqual({
      kind: "tool_use",
      tool: "Read",
      summary: "foo.ts",
    });
  });

  it("Write / Edit → basename(file_path)", () => {
    expect(
      parseStreamLine(toolLine("Write", { file_path: "/x/y/out.md" })),
    ).toMatchObject({ summary: "out.md" });
    expect(
      parseStreamLine(toolLine("Edit", { file_path: "/x/y/z.tsx" })),
    ).toMatchObject({ summary: "z.tsx" });
  });

  it("Grep → pattern", () => {
    expect(parseStreamLine(toolLine("Grep", { pattern: "TODO" }))).toMatchObject({
      summary: "TODO",
    });
  });

  it("unknown tool → tool name as summary", () => {
    expect(parseStreamLine(toolLine("MagicTool", { foo: "bar" }))).toEqual({
      kind: "tool_use",
      tool: "MagicTool",
      summary: "MagicTool",
    });
  });

  it("tool with missing input falls back to tool name", () => {
    expect(parseStreamLine(toolLine("Bash", {}))).toMatchObject({
      summary: "Bash",
    });
  });
});

describe("parseStreamLine — thinking", () => {
  it("returns kind:thinking with NO payload (content not exposed)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "deeply private reasoning" }],
      },
    });
    const event = parseStreamLine(line);
    expect(event).toEqual({ kind: "thinking" });
  });
});

describe("parseStreamLine — result", () => {
  it("extracts result text and is_error=false on success", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      is_error: false,
    });
    expect(parseStreamLine(line)).toEqual({
      kind: "result",
      text: "ok",
      is_error: false,
    });
  });

  it("preserves is_error=true on failure result lines", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
    });
    expect(parseStreamLine(line)).toEqual({
      kind: "result",
      text: null,
      is_error: true,
    });
  });
});

describe("backward-compat: extractAssistantText / extractResultText", () => {
  it("extractAssistantText returns the joined text for assistant lines", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(extractAssistantText(line)).toBe("hello");
  });

  it("extractAssistantText returns null for tool_use-only lines", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "x" } }],
      },
    });
    expect(extractAssistantText(line)).toBeNull();
  });

  it("extractResultText returns the result text from result lines", () => {
    const line = JSON.stringify({ type: "result", result: "done" });
    expect(extractResultText(line)).toBe("done");
  });

  it("extractResultText returns null for non-result lines", () => {
    expect(
      extractResultText(JSON.stringify({ type: "system", subtype: "init" })),
    ).toBeNull();
  });
});
