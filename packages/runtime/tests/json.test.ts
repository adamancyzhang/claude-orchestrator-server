import { describe, expect, it } from "vitest";
import { extractJson } from "../src/json.js";

describe("extractJson", () => {
  it("extracts a JSON object from plain text", () => {
    expect(extractJson('Here is {"a": 1} in text')).toBe('{"a": 1}');
  });

  it("extracts a JSON array from plain text", () => {
    expect(extractJson("Result: [1, 2, 3]")).toBe("[1, 2, 3]");
  });

  it("strips markdown code fences and extracts JSON", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(extractJson(input)).toBe('{"key": "value"}');
  });

  it("strips plain code fences and extracts JSON", () => {
    const input = '```\n{"key": "value"}\n```';
    expect(extractJson(input)).toBe('{"key": "value"}');
  });

  it("returns the first valid JSON when multiple candidates exist", () => {
    const input = 'First: {"a": 1} then some text then {"b": 2}';
    expect(extractJson(input)).toBe('{"a": 1}');
  });

  it("skips invalid JSON candidates and returns the first valid one", () => {
    const input = 'Not json: {broken} then valid: {"ok": true}';
    expect(extractJson(input)).toBe('{"ok": true}');
  });

  it("handles nested JSON objects", () => {
    const input = 'nested: {"outer": {"inner": 42}} done';
    expect(extractJson(input)).toBe('{"outer": {"inner": 42}}');
  });

  it("handles nested arrays", () => {
    const input = "nested: [[1, 2], [3, 4]] done";
    expect(extractJson(input)).toBe("[[1, 2], [3, 4]]");
  });

  it("returns cleaned input when no valid JSON found", () => {
    expect(extractJson("no json here")).toBe("no json here");
  });

  it("handles empty input", () => {
    expect(extractJson("")).toBe("");
  });

  it("handles input with only whitespace", () => {
    expect(extractJson("   ")).toBe("");
  });

  it("extracts JSON from text with surrounding prose and fences", () => {
    const input = `Here is the result:

\`\`\`json
{"decision": "activate_next", "reason": "looks good"}
\`\`\`

That should work.`;
    expect(extractJson(input)).toBe(
      '{"decision": "activate_next", "reason": "looks good"}',
    );
  });

  it("handles text with explanation before and JSON after", () => {
    const input = `The analysis shows:
{"result": "pass", "score": 95}`;
    expect(extractJson(input)).toBe('{"result": "pass", "score": 95}');
  });
});
